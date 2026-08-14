import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbContext, useRpc } from "@bb/plugin-sdk/app";
import type { PluginFileOpenerSource } from "@bb/plugin-sdk/app";
import type { filesRpcContract } from "../../server";

export interface FileTreeEntry {
  kind: "file" | "directory";
  path: string;
  name: string;
  score: number;
  positions: number[];
}

export type OpenFile =
  | {
      state: "text";
      path: string;
      sha256: string;
      sizeBytes: number;
      mimeType: string | null;
      modifiedAtMs: number | null;
      content: string;
    }
  | {
      state: "unsupported";
      path: string;
      sha256: string;
      sizeBytes: number;
      mimeType: string | null;
      modifiedAtMs: number | null;
      reason: "binary" | "too-large";
    };

export type SaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; currentSha256: string | null };

export interface WorkspaceFileIdentity {
  version: 1;
  source: Pick<PluginFileOpenerSource, "kind" | "threadId" | "environmentId" | "projectId">;
  path: string;
}

export interface TabState extends WorkspaceFileIdentity {
  id: string;
  file: OpenFile | null;
  loading: boolean;
  draftText: string;
  savedText: string;
  saveState: SaveState;
}

const WORKSPACE_STORAGE_PREFIX = "bb-plugin-files:workspace:";
const MAX_RESTORED_TABS = 20;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;

interface StoredWorkspaceState {
  version: 2;
  openFiles: WorkspaceFileIdentity[];
  activeFileId: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceFileId(identity: WorkspaceFileIdentity): string {
  return JSON.stringify([identity.version, identity.source.kind, identity.source.threadId, identity.source.environmentId, identity.source.projectId, identity.path]);
}

function storageKey(source: WorkspaceFileIdentity["source"]): string {
  return `${WORKSPACE_STORAGE_PREFIX}${JSON.stringify([source.threadId, source.environmentId, source.projectId])}`;
}

function sameSource(
  left: WorkspaceFileIdentity["source"],
  right: WorkspaceFileIdentity["source"],
): boolean {
  return left.kind === right.kind && left.threadId === right.threadId && left.environmentId === right.environmentId && left.projectId === right.projectId;
}

function isCanonicalWorkspacePath(path: string): boolean {
  return path.length > 0 && path.length <= MAX_WORKSPACE_PATH_LENGTH && path.trim() === path && !path.includes("\\") && !path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes("\0"));
}

function isSafeEvictionCandidate(tab: TabState): boolean {
  return !tab.loading && tab.draftText === tab.savedText && tab.saveState.kind === "saved";
}

function limitWorkspaceFiles(files: WorkspaceFileIdentity[], requestedId?: string): WorkspaceFileIdentity[] {
  const unique: WorkspaceFileIdentity[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const id = workspaceFileId(file);
    if (!ids.has(id)) {
      ids.add(id);
      unique.push(file);
    }
  }
  if (unique.length <= MAX_RESTORED_TABS) return unique;
  const requested = requestedId === undefined ? null : unique.find((file) => workspaceFileId(file) === requestedId) ?? null;
  const candidates = unique.filter((file) => requested === null || workspaceFileId(file) !== requestedId);
  const kept = candidates.slice(Math.max(0, candidates.length - (MAX_RESTORED_TABS - (requested === null ? 0 : 1))));
  return requested === null ? kept : [...kept, requested];
}

function asWorkspaceFileIdentity(value: unknown): WorkspaceFileIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<WorkspaceFileIdentity>;
  if (item.version !== 1 || typeof item.path !== "string" || !isCanonicalWorkspacePath(item.path)) return null;
  const source = item.source;
  if (source?.kind !== "workspace" || typeof source.threadId !== "string" || source.threadId.length === 0) return null;
  if ((source.environmentId !== null && typeof source.environmentId !== "string") || (source.projectId !== null && typeof source.projectId !== "string")) return null;
  return { version: 1, source, path: item.path };
}

function loadStoredWorkspace(source: WorkspaceFileIdentity["source"]): StoredWorkspaceState {
  const empty = { version: 2 as const, openFiles: [], activeFileId: null };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(storageKey(source));
    if (raw === null) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredWorkspaceState>;
    if (parsed.version === 2 && Array.isArray(parsed.openFiles)) {
      const openFiles = parsed.openFiles
        .map(asWorkspaceFileIdentity)
        .filter((value): value is WorkspaceFileIdentity => value !== null && sameSource(value.source, source));
      const ids = new Set<string>();
      const unique = openFiles.filter((file) => !ids.has(workspaceFileId(file)) && ids.add(workspaceFileId(file)));
      const limited = limitWorkspaceFiles(unique);
      const activeFileId = typeof parsed.activeFileId === "string" && limited.some((file) => workspaceFileId(file) === parsed.activeFileId) ? parsed.activeFileId : limited[0] ? workspaceFileId(limited[0]) : null;
      return { version: 2, openFiles: limited, activeFileId };
    }
    return empty;
  } catch {
    return empty;
  }
}

function saveStoredWorkspace(source: WorkspaceFileIdentity["source"], state: StoredWorkspaceState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(source), JSON.stringify(state));
  } catch {
    // Ignore storage failures. The editor still works without persisted tabs.
  }
}

export function useFilesWorkspace(initialPath: string | null = null) {
  const context = useBbContext();
  const rpc = useRpc<typeof filesRpcContract>();
  const threadId = context.threadId ?? "";
  // Environment identity is resolved by the server for every RPC. Persisted
  // state and component props never contribute to the authorization decision.
  const workspaceSource = useMemo(
    () => ({ kind: "workspace" as const, threadId, environmentId: null, projectId: context.projectId }),
    [context.projectId, threadId],
  );
  const canRead = context.threadId !== null;
  const [query, setQuery] = useState("");
  const [rootName, setRootName] = useState("Files");
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [annotateAvailable, setAnnotateAvailable] = useState(false);

  const [initialWorkspace] = useState<StoredWorkspaceState>(() => {
    const stored = loadStoredWorkspace(workspaceSource);
    if (!canRead || initialPath === null || !isCanonicalWorkspacePath(initialPath)) return stored;
    const initial = { version: 1 as const, source: workspaceSource, path: initialPath };
    const initialId = workspaceFileId(initial);
    return stored.openFiles.some((file) => workspaceFileId(file) === initialId)
      ? { ...stored, activeFileId: initialId }
      : { ...stored, openFiles: limitWorkspaceFiles([...stored.openFiles, initial], initialId), activeFileId: initialId };
  });
  const [tabs, setTabs] = useState<TabState[]>(() =>
    initialWorkspace.openFiles.map((identity) => ({
      ...identity,
      id: workspaceFileId(identity),
      file: null,
      loading: true,
      draftText: "",
      savedText: "",
      saveState: { kind: "saved" },
    })),
  );
  const [activePath, setActivePath] = useState<string | null>(() => initialWorkspace.openFiles.find((file) => workspaceFileId(file) === initialWorkspace.activeFileId)?.path ?? null);

  const tabIdForPath = useCallback((path: string) => workspaceFileId({ version: 1, source: workspaceSource, path }), [workspaceSource]);
  const tabsRef = useRef(tabs);
  const activePathRef = useRef(activePath);
  const treeRequestRef = useRef(0);
  const fileLoadRequestsRef = useRef<Set<string>>(new Set());
  const savePromisesRef = useRef<Record<string, Promise<boolean> | undefined>>({});

  useEffect(() => void (tabsRef.current = tabs), [tabs]);
  useEffect(() => void (activePathRef.current = activePath), [activePath]);

  useEffect(() => {
    saveStoredWorkspace(workspaceSource, {
      version: 2,
      openFiles: tabs.map(({ version, source: tabSource, path }) => ({ version, source: tabSource, path })),
      activeFileId: activePath === null ? null : tabIdForPath(activePath),
    });
  }, [activePath, tabIdForPath, tabs, workspaceSource]);

  useEffect(() => {
    if (!canRead) return;
    tabs.forEach((tab) => {
      if (tab.file !== null || !tab.loading || fileLoadRequestsRef.current.has(tab.id)) return;
      const path = tab.path;
      const id = tab.id;
      fileLoadRequestsRef.current.add(id);
      void rpc
        .call("readFile", { threadId, path })
        .then((result) => {
          setTabs((curr) =>
            curr.map((current) => {
              if (current.id !== id) return current;
              return {
                ...current,
                file: result,
                loading: false,
                draftText: result.state === "text" ? result.content : "",
                savedText: result.state === "text" ? result.content : "",
                saveState: { kind: "saved" },
              };
            }),
          );
        })
        .catch((error) => {
          setTabs((curr) =>
            curr.map((current) =>
              current.id === id
                ? {
                    ...current,
                    loading: false,
                    saveState: { kind: "error", message: message(error) },
                  }
                : current,
            ),
          );
        })
        .finally(() => {
          fileLoadRequestsRef.current.delete(id);
        });
    });
  }, [canRead, rpc, tabs, threadId]);

  const openInPreferredViewer = useCallback(
    async (path: string) => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return false;
      const result = await rpc.call("openFile", { threadId, path });
      return result.delivered > 0;
    },
    [canRead, rpc, threadId],
  );

  const refreshTree = useCallback(
    async (nextQuery = query, silent = false) => {
      if (!canRead) return false;
      const request = ++treeRequestRef.current;
      if (!silent) setTreeLoading(true);
      try {
        const result = await rpc.call("listTree", {
          threadId,
          query: nextQuery,
        });
        if (request !== treeRequestRef.current) return false;
        setRootName(result.rootName);
        setEntries(result.entries);
        setTruncated(result.truncated);
        setAnnotateAvailable(result.annotateAvailable === true);
        setTreeError(null);
        return true;
      } catch (error) {
        if (request !== treeRequestRef.current) return false;
        setTreeError(message(error));
        return false;
      } finally {
        if (request === treeRequestRef.current && !silent) setTreeLoading(false);
      }
    },
    [canRead, query, rpc, threadId],
  );

  useEffect(() => {
    if (!canRead) {
      setTreeLoading(false);
      setTreeError("This file source is not available in the active workspace.");
      return;
    }
    const timer = window.setTimeout(() => void refreshTree(query), 200);
    return () => window.clearTimeout(timer);
  }, [canRead, query, refreshTree]);

  const save = useCallback(async (path: string): Promise<boolean> => {
    if (!canRead || !isCanonicalWorkspacePath(path)) return false;
    const existingPromise = savePromisesRef.current[path];
    if (existingPromise) return existingPromise;
    const tab = tabsRef.current.find(t => t.path === path);
    if (!tab) return false;
    
    if (
      tab.file?.state !== "text" ||
      tab.draftText === tab.savedText
    ) {
      return tab.saveState.kind !== "conflict";
    }
    if (tab.saveState.kind === "conflict") return false;
    const file = tab.file;
    if (file?.state !== "text") return false;

    const pending = (async () => {
      setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "saving" } } : t));
      try {
        const result = await rpc.call("saveFile", {
          threadId,
          path,
          content: tab.draftText,
          expectedSha256: file.sha256,
        });
        if (result.outcome === "conflict") {
          setTabs(curr => curr.map(t => t.path === path ? {
            ...t,
            saveState: { kind: "conflict", currentSha256: result.currentSha256 },
          } : t));
          return false;
        }
        setTabs(curr => curr.map(t => {
          if (t.path !== path) return t;
          return {
            ...t,
            file: t.file?.state === "text" ? { ...t.file, sha256: result.sha256, sizeBytes: result.sizeBytes } : t.file,
            savedText: t.draftText,
            saveState: { kind: "saved" }
          };
        }));
        return true;
      } catch (error) {
        setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "error", message: message(error) } } : t));
        return false;
      }
    })();
    savePromisesRef.current[path] = pending;
    try {
      return await pending;
    } finally {
      if (savePromisesRef.current[path] === pending) {
        delete savePromisesRef.current[path];
      }
    }
  }, [canRead, rpc, threadId]);

  const openPath = useCallback(
    async (path: string): Promise<boolean> => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return false;
      const id = tabIdForPath(path);
      const existingTab = tabsRef.current.find((tab) => tab.id === id);
      if (existingTab) {
        activePathRef.current = path;
        setActivePath(path);
        return true;
      }

      const evictionCandidate = tabsRef.current.length < MAX_RESTORED_TABS
        ? null
        : tabsRef.current.find(isSafeEvictionCandidate) ?? null;
      if (tabsRef.current.length >= MAX_RESTORED_TABS && evictionCandidate === null) {
        setTreeError(`Cannot open ${path}: all open tabs have unsaved or unresolved changes.`);
        return false;
      }

      const identity = { version: 1 as const, source: workspaceSource, path };
      const newTab: TabState = {
        ...identity,
        id,
        file: null,
        loading: true,
        draftText: "",
        savedText: "",
        saveState: { kind: "saved" },
      };
      const nextTabs = evictionCandidate === null
        ? [...tabsRef.current, newTab]
        : [...tabsRef.current.filter((tab) => tab.id !== evictionCandidate.id), newTab];
      activePathRef.current = path;
      setActivePath(path);
      tabsRef.current = nextTabs;
      setTabs(nextTabs);

      try {
        const result = await rpc.call("readFile", { threadId, path });
        setTabs(curr => curr.map(t => {
          if (t.path !== path) return t;
          return {
            ...t,
            file: result,
            loading: false,
            draftText: result.state === "text" ? result.content : "",
            savedText: result.state === "text" ? result.content : "",
            saveState: { kind: "saved" }
          };
        }));
        return true;
      } catch (error) {
        setTabs(curr => curr.map(t => {
          if (t.id !== id) return t;
          return {
            ...t,
            loading: false,
            saveState: { kind: "error", message: message(error) }
          };
        }));
        return false;
      }
    },
    [canRead, rpc, tabIdForPath, threadId, workspaceSource],
  );

  const closeFile = useCallback(async (path: string) => {
    if (!canRead || !isCanonicalWorkspacePath(path)) return false;
    const tab = tabsRef.current.find(t => t.path === path);
    const isDirty = tab?.file?.state === "text" && tab.draftText !== tab.savedText;
    if (isDirty) {
      if (!(await save(path))) return false;
    }
    setTabs(curr => {
      const filtered = curr.filter(t => t.path !== path);
      if (activePathRef.current === path) {
        setActivePath(filtered.length > 0 ? filtered[filtered.length - 1].path : null);
      }
      return filtered;
    });
    return true;
  }, [save]);

  useEffect(() => {
    const timers = tabs
      .filter(t => t.file?.state === "text" && t.draftText !== t.savedText && t.saveState.kind !== "conflict")
      .map(t => window.setTimeout(() => void save(t.path), 700));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [tabs, save]);

  const reloadFile = useCallback(async (path: string) => {
    if (!canRead || !isCanonicalWorkspacePath(path)) return false;
    setTabs(curr => curr.map(t => t.path === path ? { ...t, loading: true } : t));
    try {
      const result = await rpc.call("readFile", { threadId, path });
      setTabs(curr => curr.map(t => {
        if (t.path !== path) return t;
        return {
          ...t,
          file: result,
          loading: false,
          draftText: result.state === "text" ? result.content : "",
          savedText: result.state === "text" ? result.content : "",
          saveState: { kind: "saved" }
        };
      }));
      return true;
    } catch (error) {
      setTabs(curr => curr.map(t => t.path === path ? { 
        ...t, 
        loading: false, 
        saveState: { kind: "error", message: message(error) } 
      } : t));
      return false;
    }
  }, [canRead, rpc, threadId]);

  const overwrite = useCallback(async (path: string) => {
    if (!canRead || !isCanonicalWorkspacePath(path)) return false;
    const tab = tabsRef.current.find(t => t.path === path);
    if (!tab || tab.file?.state !== "text") return false;
    setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "saving" } } : t));
    try {
      const result = await rpc.call("overwriteFile", {
        threadId,
        path,
        content: tab.draftText,
      });
      if (result.outcome === "conflict") {
        setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "conflict", currentSha256: result.currentSha256 } } : t));
        return false;
      }
      setTabs(curr => curr.map(t => {
        if (t.path !== path) return t;
        return {
          ...t,
          file: { ...t.file, sha256: result.sha256, sizeBytes: result.sizeBytes } as OpenFile,
          savedText: tab.draftText,
          saveState: { kind: "saved" }
        };
      }));
      return true;
    } catch (error) {
      setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "error", message: message(error) } } : t));
      return false;
    }
  }, [canRead, rpc, threadId]);

  useEffect(() => {
    if (!canRead) return;
    const timer = window.setInterval(() => {
      void refreshTree(query, true);
      const currentTabs = tabsRef.current;
      currentTabs.forEach(tab => {
        const path = tab.path;
        if (!tab.file) return;
        void rpc
          .call("readFile", { threadId, path })
          .then((remote) => {
            const latestTab = tabsRef.current.find(t => t.path === path);
            if (!latestTab || latestTab.file?.sha256 === tab.file?.sha256) return;
            
            if (latestTab.draftText === latestTab.savedText) {
              setTabs(curr => curr.map(t => {
                if (t.path !== path) return t;
                return {
                  ...t,
                  file: remote,
                  draftText: remote.state === "text" ? remote.content : "",
                  savedText: remote.state === "text" ? remote.content : "",
                };
              }));
            } else {
              setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "conflict", currentSha256: remote.sha256 } } : t));
            }
          })
          .catch(() => undefined);
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [canRead, query, refreshTree, rpc, threadId]);

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>) => {
      if (!canRead) return { ok: false as const, error: "This file source is not available in the active workspace." };
      try {
        await operation();
        await refreshTree(query);
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: message(error) };
      }
    },
    [canRead, query, refreshTree],
  );

  const createFile = useCallback(
    (path: string) => {
      if (!isCanonicalWorkspacePath(path)) return Promise.resolve({ ok: false as const, error: "Invalid workspace path." });
      return runMutation(async () => {
        await rpc.call("createFile", { threadId, path });
        // Если файл уже существует (conflict), мы просто проигнорируем ошибку 
        // и всё равно откроем его. Это позволяет открывать скрытые файлы.
        await openPath(path);
      });
    },
    [openPath, rpc, runMutation, threadId],
  );

  const createDirectory = useCallback(
    (path: string) => isCanonicalWorkspacePath(path)
      ? runMutation(() => rpc.call("createDirectory", { threadId, path }))
      : Promise.resolve({ ok: false as const, error: "Invalid workspace path." }),
    [rpc, runMutation, threadId],
  );

  const movePath = useCallback(
    (sourcePath: string, destinationPath: string) => {
      if (!isCanonicalWorkspacePath(sourcePath) || !isCanonicalWorkspacePath(destinationPath)) return Promise.resolve({ ok: false as const, error: "Invalid workspace path." });
      return runMutation(async () => {
        await rpc.call("movePath", { threadId, sourcePath, destinationPath });
        setTabs(curr => {
          const movedTabs = curr.map(t => {
            if (t.path !== sourcePath && !t.path.startsWith(`${sourcePath}/`)) return t;
            const movedPath = t.path === sourcePath ? destinationPath : `${destinationPath}${t.path.slice(sourcePath.length)}`;
            const moved = { version: 1 as const, source: t.source, path: movedPath };
            return {
              ...t,
              ...moved,
              id: workspaceFileId(moved),
              file: t.file ? { ...t.file, path: movedPath } as OpenFile : null,
            };
          });
          tabsRef.current = movedTabs;
          return movedTabs;
        });
        const active = activePathRef.current;
        if (active === sourcePath || active?.startsWith(`${sourcePath}/`)) {
          const movedActivePath = `${destinationPath}${active.slice(sourcePath.length)}`;
          activePathRef.current = movedActivePath;
          setActivePath(movedActivePath);
        }
      });
    },
    [rpc, runMutation, threadId],
  );

  const removePath = useCallback(
    (path: string, recursive: boolean) => {
      if (!isCanonicalWorkspacePath(path)) return Promise.resolve({ ok: false as const, error: "Invalid workspace path." });
      return runMutation(async () => {
        await rpc.call("removePath", { threadId, path, recursive });
        setTabs(curr => {
          const filtered = curr.filter(t => !(t.path === path || t.path.startsWith(`${path}/`)));
          if (!filtered.find(t => t.path === activePathRef.current)) {
            setActivePath(filtered.length > 0 ? filtered[filtered.length - 1].path : null);
          }
          return filtered;
        });
      });
    },
    [rpc, runMutation, threadId],
  );

  const duplicatePath = useCallback(
    (kind: "file" | "directory", sourcePath: string, destinationPath: string) => {
      if (!isCanonicalWorkspacePath(sourcePath) || !isCanonicalWorkspacePath(destinationPath)) {
        return Promise.resolve({ ok: false as const, error: "Invalid workspace path." });
      }
      return runMutation(async () => {
        const result = await rpc.call("duplicatePath", {
          threadId,
          kind,
          sourcePath,
          destinationPath,
        });
        if (result.outcome === "partial") {
          throw new Error(
            `${result.error} Created before failure: ${result.createdPaths.join(", ")}`,
          );
        }
      });
    },
    [rpc, runMutation, threadId],
  );

  const getDownloadUrl = useCallback(
    async (path: string) => {
      if (!canRead || !isCanonicalWorkspacePath(path)) throw new Error("This file source is not available in the active workspace.");
      const result = await rpc.call("getDownloadUrl", { threadId, path });
      return result.url;
    },
    [canRead, rpc, threadId]
  );

  const downloadPath = useCallback(
    async (path: string) => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return;
      try {
        const url = await getDownloadUrl(path);
        const a = document.createElement("a");
        a.href = url;
        a.download = path.split("/").pop() || "download";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (error) {
        setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "error", message: message(error) } } : t));
      }
    },
    [canRead, getDownloadUrl]
  );

  const selectPath = useCallback((path: string | null) => {
    if (!canRead || (path !== null && (!isCanonicalWorkspacePath(path) || !tabsRef.current.some((tab) => tab.path === path)))) return;
    activePathRef.current = path;
    setActivePath(path);
  }, [canRead]);

  const setDraftText = useCallback((path: string, text: string) => {
    if (!canRead || !isCanonicalWorkspacePath(path) || !tabsRef.current.some((tab) => tab.path === path)) return;
    setTabs(curr => curr.map(t => t.path === path ? { ...t, draftText: text } : t));
  }, [canRead]);

  return useMemo(
    () => ({
      tabs,
      activePath,
      annotateAvailable,
      setActivePath: selectPath,
      closeFile,
      createDirectory,
      createFile,
      downloadPath,
      getDownloadUrl,
      setDraftText,
      duplicatePath,
      entries,
      movePath,
      openPath,
      openInPreferredViewer,
      overwrite,
      query,
      refreshTree: () => refreshTree(query),
      reloadFile,
      removePath,
      rootName,
      save,
      setQuery,
      treeError,
      treeLoading,
      truncated,
    }),
    [
      tabs,
      activePath,
      annotateAvailable,
      selectPath,
      closeFile,
      createDirectory,
      createFile,
      downloadPath,
      getDownloadUrl,
      setDraftText,
      duplicatePath,
      entries,
      movePath,
      openPath,
      openInPreferredViewer,
      overwrite,
      query,
      refreshTree,
      reloadFile,
      removePath,
      rootName,
      save,
      treeError,
      treeLoading,
      truncated,
    ],
  );
}
