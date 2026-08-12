import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
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

export interface TabState {
  path: string;
  file: OpenFile | null;
  loading: boolean;
  draftText: string;
  savedText: string;
  saveState: SaveState;
}

const WORKSPACE_STORAGE_PREFIX = "bb-plugin-files:workspace:";

interface StoredWorkspaceState {
  version: 1;
  openPaths: string[];
  activePath: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storageKey(threadId: string): string {
  return `${WORKSPACE_STORAGE_PREFIX}${threadId}`;
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter((path) => path.length > 0)));
}

function loadStoredWorkspace(threadId: string): StoredWorkspaceState {
  if (typeof window === "undefined") {
    return { version: 1, openPaths: [], activePath: null };
  }
  try {
    const raw = window.localStorage.getItem(storageKey(threadId));
    if (raw === null) return { version: 1, openPaths: [], activePath: null };
    const parsed = JSON.parse(raw) as Partial<StoredWorkspaceState>;
    const openPaths = dedupePaths(Array.isArray(parsed.openPaths) ? parsed.openPaths.filter((value): value is string => typeof value === "string") : []);
    const activePath = typeof parsed.activePath === "string" && openPaths.includes(parsed.activePath) ? parsed.activePath : openPaths[0] ?? null;
    return { version: 1, openPaths, activePath };
  } catch {
    return { version: 1, openPaths: [], activePath: null };
  }
}

function saveStoredWorkspace(threadId: string, state: StoredWorkspaceState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(threadId), JSON.stringify(state));
  } catch {
    // Ignore storage failures. The editor still works without persisted tabs.
  }
}

export function useFilesWorkspace(threadId: string) {
  const rpc = useRpc<typeof filesRpcContract>();
  const [query, setQuery] = useState("");
  const [rootName, setRootName] = useState("Files");
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [annotateAvailable, setAnnotateAvailable] = useState(false);

  const [initialWorkspace] = useState(() => loadStoredWorkspace(threadId));
  const [tabs, setTabs] = useState<TabState[]>(() =>
    initialWorkspace.openPaths.map((path) => ({
      path,
      file: null,
      loading: true,
      draftText: "",
      savedText: "",
      saveState: { kind: "saved" },
    })),
  );
  const [activePath, setActivePath] = useState<string | null>(initialWorkspace.activePath);

  const tabsRef = useRef(tabs);
  const activePathRef = useRef(activePath);
  const treeRequestRef = useRef(0);
  const fileLoadRequestsRef = useRef<Set<string>>(new Set());
  const savePromisesRef = useRef<Record<string, Promise<boolean> | undefined>>({});

  useEffect(() => void (tabsRef.current = tabs), [tabs]);
  useEffect(() => void (activePathRef.current = activePath), [activePath]);

  useEffect(() => {
    saveStoredWorkspace(threadId, {
      version: 1,
      openPaths: tabs.map((tab) => tab.path),
      activePath,
    });
  }, [activePath, tabs, threadId]);

  useEffect(() => {
    tabs.forEach((tab) => {
      if (tab.file !== null || !tab.loading || fileLoadRequestsRef.current.has(tab.path)) return;
      const path = tab.path;
      fileLoadRequestsRef.current.add(path);
      void rpc
        .call("readFile", { threadId, path })
        .then((result) => {
          setTabs((curr) =>
            curr.map((current) => {
              if (current.path !== path) return current;
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
              current.path === path
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
          fileLoadRequestsRef.current.delete(path);
        });
    });
  }, [rpc, tabs, threadId]);

  const openInPreferredViewer = useCallback(
    async (path: string) => {
      const result = await rpc.call("openFile", { threadId, path });
      return result.delivered > 0;
    },
    [rpc, threadId],
  );

  const refreshTree = useCallback(
    async (nextQuery = query, silent = false) => {
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
    [query, rpc, threadId],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshTree(query), 200);
    return () => window.clearTimeout(timer);
  }, [query, refreshTree]);

  const save = useCallback(async (path: string): Promise<boolean> => {
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

    const pending = (async () => {
      setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "saving" } } : t));
      try {
        const result = await rpc.call("saveFile", {
          threadId,
          path,
          content: tab.draftText,
          expectedSha256: tab.file!.sha256,
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
  }, [rpc, threadId]);

  const openPath = useCallback(
    async (path: string): Promise<boolean> => {
      setActivePath(path);
      const existingTab = tabsRef.current.find(t => t.path === path);
      if (existingTab) return true;

      setTabs(curr => [...curr, {
        path,
        file: null,
        loading: true,
        draftText: "",
        savedText: "",
        saveState: { kind: "saved" }
      }]);

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
          if (t.path !== path) return t;
          return {
            ...t,
            loading: false,
            saveState: { kind: "error", message: message(error) }
          };
        }));
        return false;
      }
    },
    [rpc, threadId],
  );

  const closeFile = useCallback(async (path: string) => {
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
  }, [rpc, threadId]);

  const overwrite = useCallback(async (path: string) => {
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
  }, [rpc, threadId]);

  useEffect(() => {
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
            
            if (latestTab.draftText !== latestTab.savedText) {
              setTabs(curr => curr.map(t => t.path === path ? { ...t, saveState: { kind: "conflict", currentSha256: remote.sha256 } } : t));
            } else {
              setTabs(curr => curr.map(t => {
                if (t.path !== path) return t;
                return {
                  ...t,
                  file: remote,
                  draftText: remote.state === "text" ? remote.content : "",
                  savedText: remote.state === "text" ? remote.content : "",
                };
              }));
            }
          })
          .catch(() => undefined);
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [query, refreshTree, rpc, threadId]);

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>) => {
      try {
        await operation();
        await refreshTree(query);
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: message(error) };
      }
    },
    [query, refreshTree],
  );

  const createFile = useCallback(
    (path: string) =>
      runMutation(async () => {
        const result = await rpc.call("createFile", { threadId, path });
        // Если файл уже существует (conflict), мы просто проигнорируем ошибку 
        // и всё равно откроем его. Это позволяет открывать скрытые файлы.
        await openPath(path);
      }),
    [openPath, rpc, runMutation, threadId],
  );

  const createDirectory = useCallback(
    (path: string) =>
      runMutation(() => rpc.call("createDirectory", { threadId, path })),
    [rpc, runMutation, threadId],
  );

  const movePath = useCallback(
    (sourcePath: string, destinationPath: string) =>
      runMutation(async () => {
        await rpc.call("movePath", { threadId, sourcePath, destinationPath });
        setTabs(curr => curr.map(t => {
          if (t.path !== sourcePath) return t;
          return {
            ...t,
            path: destinationPath,
            file: t.file ? { ...t.file, path: destinationPath } as OpenFile : null
          };
        }));
        if (activePathRef.current === sourcePath) {
          setActivePath(destinationPath);
        }
      }),
    [rpc, runMutation, threadId],
  );

  const removePath = useCallback(
    (path: string, recursive: boolean) =>
      runMutation(async () => {
        await rpc.call("removePath", { threadId, path, recursive });
        setTabs(curr => {
          const filtered = curr.filter(t => !(t.path === path || t.path.startsWith(`${path}/`)));
          if (!filtered.find(t => t.path === activePathRef.current)) {
            setActivePath(filtered.length > 0 ? filtered[filtered.length - 1].path : null);
          }
          return filtered;
        });
      }),
    [rpc, runMutation, threadId],
  );

  const duplicatePath = useCallback(
    (kind: "file" | "directory", sourcePath: string, destinationPath: string) =>
      runMutation(async () => {
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
      }),
    [rpc, runMutation, threadId],
  );

  const getDownloadUrl = useCallback(
    async (path: string) => {
      const result = await rpc.call("getDownloadUrl", { threadId, path });
      return result.url;
    },
    [rpc, threadId]
  );

  const downloadPath = useCallback(
    async (path: string) => {
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
    [getDownloadUrl]
  );

  const setDraftText = useCallback((path: string, text: string) => {
    setTabs(curr => curr.map(t => t.path === path ? { ...t, draftText: text } : t));
  }, []);

  return useMemo(
    () => ({
      tabs,
      activePath,
      annotateAvailable,
      setActivePath,
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
