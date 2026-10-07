import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbContext, useRpc } from "@bb/plugin-sdk/app";
import type { filesRpcContract } from "../../server";
import { parentPath } from "../tree-order";
import type { FileScope } from "../contracts";
import { fileScopeSchema } from "../file-scope";

export interface FileTreeEntry {
  kind: "file" | "directory";
  path: string;
  name: string;
  score: number;
  positions: number[];
}

/**
 * Where the server's search index stands. `indexing` means its walk is still
 * running: the panel shows progress and keeps asking until it is `ready`.
 */
export interface SearchIndexState {
  status: "ready" | "indexing";
  indexedCount: number;
  indexingSinceMs: number | null;
}

const IDLE_SEARCH_INDEX: SearchIndexState = {
  status: "ready",
  indexedCount: 0,
  indexingSinceMs: null,
};

/** How often a search re-asks while the server is still building its index. */
const INDEX_POLL_MS = 1_500;

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
  version: 2;
  scope: FileScope;
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
const FILES_PLUGIN_HTTP_BASE = "/api/v1/plugins/files";

interface StoredWorkspaceState {
  version: 2;
  openFiles: WorkspaceFileIdentity[];
  activeFileId: string | null;
}

interface RestoredWorkspaceFile {
  identity: WorkspaceFileIdentity;
  legacyId: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseError(value: unknown, fallback: string): string {
  return value && typeof value === "object" && "error" in value
    ? String((value as { error: unknown }).error)
    : fallback;
}

async function pluginToken(): Promise<string> {
  const response = await fetch(`${FILES_PLUGIN_HTTP_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const json: unknown = await response.json().catch(() => null);
  const token =
    json && typeof json === "object" && "token" in json
      ? (json as { token: unknown }).token
      : null;
  if (!response.ok || typeof token !== "string") {
    // ubs:ignore — validates the response type, not a secret value
    throw new Error(
      responseError(json, `Token request failed (HTTP ${response.status})`),
    );
  }
  return token;
}

async function uploadFile(
  scope: FileScope,
  directory: string,
  file: File,
  token: string,
): Promise<void> {
  const query = new URLSearchParams({ scope: scope.kind });
  if (scope.kind === "thread" || scope.kind === "thread-storage") {
    query.set("threadId", scope.threadId);
  } else {
    if (scope.hostId !== undefined) query.set("hostId", scope.hostId);
    if (scope.rootPath !== undefined) query.set("rootPath", scope.rootPath);
  }
  query.set("directory", directory);
  query.set("fileName", file.name);
  const response = await fetch(
    `${FILES_PLUGIN_HTTP_BASE}/http/upload?${query}`,
    {
      method: "POST",
      headers: { "x-bb-plugin-token": token },
      body: file,
    },
  );
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      responseError(json, `Upload failed (HTTP ${response.status})`),
    );
  }
}

function workspaceFileId(identity: WorkspaceFileIdentity): string {
  return JSON.stringify([identity.version, identity.scope, identity.path]);
}

function storageKey(scope: FileScope): string {
  return `${WORKSPACE_STORAGE_PREFIX}${JSON.stringify(scope)}`;
}

function legacyStorageKey(scope: FileScope, projectId: string | null): string {
  if (scope.kind === "thread") {
    return `${WORKSPACE_STORAGE_PREFIX}${JSON.stringify([scope.threadId, null, projectId])}`;
  }
  if (scope.kind === "host") {
    return `${WORKSPACE_STORAGE_PREFIX}${JSON.stringify([null, null, scope.rootPath ?? null])}`;
  }
  return `${WORKSPACE_STORAGE_PREFIX}${JSON.stringify([scope.threadId, null, projectId])}`;
}

function sameSource(left: FileScope, right: FileScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCanonicalWorkspacePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_WORKSPACE_PATH_LENGTH &&
    path.trim() === path &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\0"),
      )
  );
}

function isSafeEvictionCandidate(tab: TabState): boolean {
  return (
    !tab.loading &&
    tab.draftText === tab.savedText &&
    tab.saveState.kind === "saved"
  );
}

function limitWorkspaceFiles(
  files: WorkspaceFileIdentity[],
  requestedId?: string,
): WorkspaceFileIdentity[] {
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
  const requested =
    requestedId === undefined
      ? null
      : (unique.find((file) => workspaceFileId(file) === requestedId) ?? null);
  const candidates = unique.filter(
    (file) => requested === null || workspaceFileId(file) !== requestedId,
  );
  const kept = candidates.slice(
    Math.max(
      0,
      candidates.length - (MAX_RESTORED_TABS - (requested === null ? 0 : 1)),
    ),
  );
  return requested === null ? kept : [...kept, requested];
}

function asRestoredWorkspaceFile(value: unknown): RestoredWorkspaceFile | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as { version?: unknown; scope?: unknown; source?: unknown; path?: unknown };
  if (typeof item.path !== "string" || !isCanonicalWorkspacePath(item.path)) return null;
  if (item.version === 2) {
    const parsedScope = fileScopeSchema.safeParse(item.scope);
    return parsedScope.success
      ? { identity: { version: 2, scope: parsedScope.data, path: item.path }, legacyId: null }
      : null;
  }
  if (item.version !== 1 || typeof item.source !== "object" || item.source === null) return null;
  const source = item.source as {
    kind?: unknown;
    threadId?: unknown;
    environmentId?: unknown;
    projectId?: unknown;
  };
  if (
    (source.environmentId !== null && typeof source.environmentId !== "string") ||
    (source.projectId !== null && typeof source.projectId !== "string")
  ) return null;
  // Legacy host records lack an authoritative host ID; keep them isolated.
  if (source.kind === "host") return null;
  const scope: FileScope | null =
    source.kind === "workspace" && typeof source.threadId === "string"
      ? { kind: "thread", threadId: source.threadId }
      : source.kind === "thread-storage" && typeof source.threadId === "string"
        ? { kind: "thread-storage", threadId: source.threadId }
        : null;
  if (scope === null) return null;
  return {
    identity: { version: 2, scope, path: item.path },
    legacyId: JSON.stringify([
      1,
      source.kind,
      source.threadId,
      source.environmentId,
      source.projectId,
      item.path,
    ]),
  };
}

function loadStoredWorkspace(scope: FileScope, legacyProjectId: string | null): StoredWorkspaceState {
  const empty = { version: 2 as const, openFiles: [], activeFileId: null };
  if (typeof window === "undefined") return empty;
  try {
    const raw =
      window.localStorage.getItem(storageKey(scope)) ??
      window.localStorage.getItem(legacyStorageKey(scope, legacyProjectId));
    if (raw === null) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredWorkspaceState>;
    if (parsed.version === 2 && Array.isArray(parsed.openFiles)) {
      const restored = parsed.openFiles
        .map(asRestoredWorkspaceFile)
        .filter(
          (value): value is RestoredWorkspaceFile =>
            value !== null && sameSource(value.identity.scope, scope),
        );
      const ids = new Set<string>();
      const unique = restored.filter(({ identity }) => {
        const id = workspaceFileId(identity);
        return !ids.has(id) && ids.add(id);
      });
      const selected =
        typeof parsed.activeFileId === "string"
          ? unique.find(
              ({ identity, legacyId }) =>
                workspaceFileId(identity) === parsed.activeFileId ||
                legacyId === parsed.activeFileId,
            )
          : undefined;
      const selectedId =
        selected === undefined ? undefined : workspaceFileId(selected.identity);
      const limited = limitWorkspaceFiles(
        unique.map(({ identity }) => identity),
        selectedId,
      );
      const activeFileId =
        selectedId !== undefined &&
        limited.some((file) => workspaceFileId(file) === selectedId)
          ? selectedId
          : limited[0]
            ? workspaceFileId(limited[0])
            : null;
      return { version: 2, openFiles: limited, activeFileId };
    }
    return empty;
  } catch {
    return empty;
  }
}

function saveStoredWorkspace(scope: FileScope, state: StoredWorkspaceState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(scope), JSON.stringify(state));
  } catch {
    // Ignore storage failures. The editor still works without persisted tabs.
  }
}

/**
 * The root a Files panel reads: the thread's workspace (`thread`), this
 * machine's global root (`host`), or — when a file link points outside the
 * workspace — one host directory that the file was opened from.
 */
export type FilesRootScope = "thread" | "host" | FileScope;

function scopeIdentity(rootScope: FilesRootScope): string {
  return typeof rootScope === "string" ? rootScope : JSON.stringify(rootScope);
}

/** Shown while a scope has no live root to read. */
export const FILE_SOURCE_UNAVAILABLE =
  "This file source is not available in the active workspace.";

/**
 * `thread` (default) reads the thread's live workspace. `host` reads the global
 * root — this machine's home directory — which is what the Files entry in BB's
 * left sidebar opens, where the route carries no thread at all.
 */
export function useFilesWorkspace(
  initialPath: string | null = null,
  rootScope: FilesRootScope = "thread",
) {
  const context = useBbContext();
  const rpc = useRpc<typeof filesRpcContract>();
  // A re-rooted panel receives a fresh scope object on every render, so the
  // identity string — not the object — keys the memos.
  const rootIdentity = scopeIdentity(rootScope);
  // Explicit targets retain the source thread or host; legacy panels still
  // resolve their default scope from the active context.
  const scope = useMemo<FileScope | null>(() => {
    if (typeof rootScope !== "string") return rootScope;
    if (rootScope === "host") return { kind: "host" };
    return context.threadId === null
      ? null
      : { kind: "thread", threadId: context.threadId };
  }, [context.threadId, rootIdentity, rootScope]);
  const workspaceScope: FileScope =
    scope ?? { kind: "thread", threadId: "" };
  const canRead = scope !== null;
  const [query, setQuery] = useState("");
  // The row the tree should scroll to. The nonce makes a repeat reveal of the
  // same path scroll again instead of looking like nothing happened.
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(
    null,
  );
  const revealNonceRef = useRef(0);
  const [rootName, setRootName] = useState("Files");
  // Lazily-expanding tree state: children are fetched one directory at a
  // time (keyed by that directory's path, "" for the root) and dropped again
  // on collapse, so memory tracks what's actually expanded rather than the
  // whole workspace. Search (non-empty query) bypasses this entirely and
  // fills `searchEntries` from a single recursive call instead.
  const [childrenByDir, setChildrenByDir] = useState<
    Map<string, FileTreeEntry[]>
  >(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [searchEntries, setSearchEntries] = useState<FileTreeEntry[]>([]);
  const [searchStatus, setSearchStatus] =
    useState<SearchIndexState>(IDLE_SEARCH_INDEX);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [annotateAvailable, setAnnotateAvailable] = useState(false);
  const [sqlAvailable, setSqlAvailable] = useState(false);

  const entries = useMemo(
    () =>
      query.length > 0
        ? searchEntries
        : Array.from(childrenByDir.values()).flat(),
    [query, searchEntries, childrenByDir],
  );

  const legacyProjectId = rootScope === "thread" ? context.projectId : null;
  const [initialWorkspace] = useState<StoredWorkspaceState>(() => {
    const stored = loadStoredWorkspace(workspaceScope, legacyProjectId);
    if (
      !canRead ||
      initialPath === null ||
      !isCanonicalWorkspacePath(initialPath)
    )
      return stored;
    const initial = {
      version: 2 as const,
      scope: workspaceScope,
      path: initialPath,
    };
    const initialId = workspaceFileId(initial);
    return stored.openFiles.some((file) => workspaceFileId(file) === initialId)
      ? { ...stored, activeFileId: initialId }
      : {
          ...stored,
          openFiles: limitWorkspaceFiles(
            [...stored.openFiles, initial],
            initialId,
          ),
          activeFileId: initialId,
        };
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
  const [activePath, setActivePath] = useState<string | null>(
    () =>
      initialWorkspace.openFiles.find(
        (file) => workspaceFileId(file) === initialWorkspace.activeFileId,
      )?.path ?? null,
  );

  const tabIdForPath = useCallback(
    (path: string) =>
      workspaceFileId({ version: 2, scope: workspaceScope, path }),
    [workspaceScope],
  );
  const tabsRef = useRef(tabs);
  const activePathRef = useRef(activePath);
  const treeRequestRef = useRef(0);
  const fileLoadRequestsRef = useRef<Set<string>>(new Set());
  const savePromisesRef = useRef<Record<string, Promise<boolean> | undefined>>(
    {},
  );
  const childrenByDirRef = useRef(childrenByDir);
  const expandedDirsRef = useRef(expandedDirs);
  const dirRequestsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => void (tabsRef.current = tabs), [tabs]);
  useEffect(() => void (activePathRef.current = activePath), [activePath]);
  useEffect(
    () => void (childrenByDirRef.current = childrenByDir),
    [childrenByDir],
  );
  useEffect(
    () => void (expandedDirsRef.current = expandedDirs),
    [expandedDirs],
  );

  useEffect(() => {
    saveStoredWorkspace(workspaceScope, {
      version: 2,
      openFiles: tabs.map(({ version, scope: tabScope, path }) => ({
        version,
        scope: tabScope,
        path,
      })),
      activeFileId: activePath === null ? null : tabIdForPath(activePath),
    });
  }, [activePath, tabIdForPath, tabs, workspaceScope]);

  useEffect(() => {
    if (!canRead) return;
    tabs.forEach((tab) => {
      if (
        tab.file !== null ||
        !tab.loading ||
        fileLoadRequestsRef.current.has(tab.id)
      )
        return;
      const path = tab.path;
      const id = tab.id;
      fileLoadRequestsRef.current.add(id);
      void rpc
        .call("readFile", { scope, path })
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
  }, [canRead, rpc, tabs, scope]);

  const openInPreferredViewer = useCallback(
    async (path: string) => {
      // BB's own preview belongs to a thread tab, so the host root has no
      // equivalent; the context menu hides the action there instead.
      if (scope?.kind !== "thread" || !isCanonicalWorkspacePath(path))
        return false;
      const result = await rpc.call("openFile", { scope, path });
      return result.delivered > 0;
    },
    [rpc, scope],
  );

  // Fetches one directory's immediate children and stores them under its own
  // key. Does not touch `expandedDirs` — callers decide expand/collapse.
  const loadDirectory = useCallback(
    async (dirPath: string, silent = false): Promise<boolean> => {
      if (!canRead) return false;
      const request = (dirRequestsRef.current.get(dirPath) ?? 0) + 1;
      dirRequestsRef.current.set(dirPath, request);
      try {
        const result = await rpc.call("listDirectory", {
          scope,
          path: dirPath,
        });
        if (dirRequestsRef.current.get(dirPath) !== request) return false;
        setChildrenByDir((current) => {
          const next = new Map(current);
          next.set(dirPath, result.entries);
          return next;
        });
        if (result.rootName !== undefined) setRootName(result.rootName);
        if (result.annotateAvailable !== undefined)
          setAnnotateAvailable(result.annotateAvailable);
        if (result.sqlAvailable !== undefined)
          setSqlAvailable(result.sqlAvailable);
        if (!silent) setTreeError(null);
        return true;
      } catch (error) {
        if (dirRequestsRef.current.get(dirPath) !== request) return false;
        if (!silent) setTreeError(message(error));
        return false;
      }
    },
    [canRead, rpc, scope],
  );

  const expandDirectory = useCallback(
    (dirPath: string) => {
      setExpandedDirs((current) =>
        current.has(dirPath) ? current : new Set(current).add(dirPath),
      );
      if (!childrenByDirRef.current.has(dirPath)) void loadDirectory(dirPath);
    },
    [loadDirectory],
  );

  // Drops the collapsed directory's children (and every already-loaded
  // descendant) from state, so a folder the user closes stops holding memory.
  const collapseDirectory = useCallback((dirPath: string) => {
    setExpandedDirs((current) => {
      if (!current.has(dirPath)) return current;
      const next = new Set(current);
      next.delete(dirPath);
      return next;
    });
    setChildrenByDir((current) => {
      let changed = false;
      const next = new Map(current);
      for (const key of current.keys()) {
        if (key === dirPath || key.startsWith(`${dirPath}/`)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const toggleDirectory = useCallback(
    (dirPath: string) => {
      if (expandedDirsRef.current.has(dirPath)) collapseDirectory(dirPath);
      else expandDirectory(dirPath);
    },
    [collapseDirectory, expandDirectory],
  );

  /**
   * Brings one path into view in the tree. Search answers are one flat list, so
   * the only honest answer to "where does this live" is to open every folder
   * above it and scroll to the row.
   */
  const revealPath = useCallback(
    (path: string) => {
      if (!canRead) return;
      setQuery("");
      for (
        let directory = parentPath(path);
        directory.length > 0;
        directory = parentPath(directory)
      ) {
        // A path with `..` in it (a file outside the root) has no folder to open.
        if (isCanonicalWorkspacePath(directory)) expandDirectory(directory);
      }
      revealNonceRef.current += 1;
      setReveal({ path, nonce: revealNonceRef.current });
    },
    [canRead, expandDirectory],
  );

  const refreshTree = useCallback(
    async (
      nextQuery = query,
      options: { silent?: boolean; force?: boolean } = {},
    ) => {
      if (!canRead) return false;
      const request = ++treeRequestRef.current;
      let force = options.force === true;
      if (options.silent !== true) setTreeLoading(true);
      try {
        if (nextQuery.length > 0) {
          // A search is answered from the server's path index. The first one on
          // a root that was never indexed starts that walk, so keep asking
          // until it is ready rather than showing an empty result and stopping.
          for (;;) {
            const result = await rpc.call("listTree", {
              scope,
              query: nextQuery,
              ...(force ? { force: true } : {}),
            });
            force = false;
            if (request !== treeRequestRef.current) return false;
            setRootName(result.rootName);
            setSearchEntries(result.entries);
            setTruncated(result.truncated);
            setSearchStatus({
              status: result.status,
              indexedCount: result.indexedCount,
              indexingSinceMs: result.indexingSinceMs,
            });
            setAnnotateAvailable(result.annotateAvailable === true);
            setSqlAvailable(result.sqlAvailable === true);
            setTreeError(null);
            if (result.status === "ready") return true;
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, INDEX_POLL_MS);
            });
            if (request !== treeRequestRef.current) return false;
          }
        }
        const loadedDirs = ["", ...expandedDirsRef.current];
        const results = await Promise.all(
          loadedDirs.map((dirPath) =>
            loadDirectory(dirPath, options.silent === true),
          ),
        );
        if (request !== treeRequestRef.current) return false;
        setSearchStatus(IDLE_SEARCH_INDEX);
        setTruncated(false);
        return results.every(Boolean);
      } catch (error) {
        if (request !== treeRequestRef.current) return false;
        setTreeError(message(error));
        return false;
      } finally {
        if (request === treeRequestRef.current && options.silent !== true) {
          setTreeLoading(false);
        }
      }
    },
    [canRead, loadDirectory, query, rpc, scope],
  );

  // A search keeps polling while the server indexes, so it has to stop when
  // the panel goes away instead of running until the walk ends.
  useEffect(
    () => () => {
      treeRequestRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!canRead) {
      setTreeLoading(false);
      setTreeError(FILE_SOURCE_UNAVAILABLE);
      return;
    }
    const timer = window.setTimeout(() => void refreshTree(query), 200);
    return () => window.clearTimeout(timer);
  }, [canRead, query, refreshTree]);

  // Reveal the active file by expanding (and lazily loading) every folder
  // above it, so opening a path inside a collapsed folder still shows up in
  // the tree instead of only in the editor.
  useEffect(() => {
    if (activePath === null) return;
    let parent = parentPath(activePath);
    while (parent.length > 0) {
      expandDirectory(parent);
      parent = parentPath(parent);
    }
  }, [activePath, expandDirectory]);

  const save = useCallback(
    async (path: string): Promise<boolean> => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return false;
      const existingPromise = savePromisesRef.current[path];
      if (existingPromise) return existingPromise;
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab) return false;

      if (tab.file?.state !== "text" || tab.draftText === tab.savedText) {
        return tab.saveState.kind !== "conflict";
      }
      if (tab.saveState.kind === "conflict") return false;
      const file = tab.file;
      if (file?.state !== "text") return false;

      const pending = (async () => {
        setTabs((curr) =>
          curr.map((t) =>
            t.path === path ? { ...t, saveState: { kind: "saving" } } : t,
          ),
        );
        try {
          const result = await rpc.call("saveFile", {
            scope,
            path,
            content: tab.draftText,
            expectedSha256: file.sha256,
          });
          if (result.outcome === "conflict") {
            setTabs((curr) =>
              curr.map((t) =>
                t.path === path
                  ? {
                      ...t,
                      saveState: {
                        kind: "conflict",
                        currentSha256: result.currentSha256,
                      },
                    }
                  : t,
              ),
            );
            return false;
          }
          setTabs((curr) =>
            curr.map((t) => {
              if (t.path !== path) return t;
              return {
                ...t,
                file:
                  t.file?.state === "text"
                    ? {
                        ...t.file,
                        sha256: result.sha256,
                        sizeBytes: result.sizeBytes,
                      }
                    : t.file,
                savedText: t.draftText,
                saveState: { kind: "saved" },
              };
            }),
          );
          return true;
        } catch (error) {
          setTabs((curr) =>
            curr.map((t) =>
              t.path === path
                ? {
                    ...t,
                    saveState: { kind: "error", message: message(error) },
                  }
                : t,
            ),
          );
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
    },
    [canRead, rpc, scope],
  );

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

      const evictionCandidate =
        tabsRef.current.length < MAX_RESTORED_TABS
          ? null
          : (tabsRef.current.find(isSafeEvictionCandidate) ?? null);
      if (
        tabsRef.current.length >= MAX_RESTORED_TABS &&
        evictionCandidate === null
      ) {
        setTreeError(
          `Cannot open ${path}: all open tabs have unsaved or unresolved changes.`,
        );
        return false;
      }

      const identity = { version: 2 as const, scope: workspaceScope, path };
      const newTab: TabState = {
        ...identity,
        id,
        file: null,
        loading: true,
        draftText: "",
        savedText: "",
        saveState: { kind: "saved" },
      };
      const nextTabs =
        evictionCandidate === null
          ? [...tabsRef.current, newTab]
          : [
              ...tabsRef.current.filter(
                (tab) => tab.id !== evictionCandidate.id,
              ),
              newTab,
            ];
      activePathRef.current = path;
      setActivePath(path);
      tabsRef.current = nextTabs;
      setTabs(nextTabs);

      try {
        const result = await rpc.call("readFile", { scope, path });
        setTabs((curr) =>
          curr.map((t) => {
            if (t.path !== path) return t;
            return {
              ...t,
              file: result,
              loading: false,
              draftText: result.state === "text" ? result.content : "",
              savedText: result.state === "text" ? result.content : "",
              saveState: { kind: "saved" },
            };
          }),
        );
        return true;
      } catch (error) {
        setTabs((curr) =>
          curr.map((t) => {
            if (t.id !== id) return t;
            return {
              ...t,
              loading: false,
              saveState: { kind: "error", message: message(error) },
            };
          }),
        );
        return false;
      }
    },
    [canRead, rpc, tabIdForPath, scope, workspaceScope],
  );

  const closeFile = useCallback(
    async (path: string) => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return false;
      const tab = tabsRef.current.find((t) => t.path === path);
      const isDirty =
        tab?.file?.state === "text" && tab.draftText !== tab.savedText;
      if (isDirty) {
        if (!(await save(path))) return false;
      }
      setTabs((curr) => {
        const filtered = curr.filter((t) => t.path !== path);
        if (activePathRef.current === path) {
          setActivePath(
            filtered.length > 0 ? filtered[filtered.length - 1].path : null,
          );
        }
        return filtered;
      });
      return true;
    },
    [save],
  );

  useEffect(() => {
    const timers = tabs
      .filter(
        (t) =>
          t.file?.state === "text" &&
          t.draftText !== t.savedText &&
          t.saveState.kind !== "conflict",
      )
      .map((t) => window.setTimeout(() => void save(t.path), 700));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [tabs, save]);

  const reloadFile = useCallback(
    async (path: string) => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return false;
      setTabs((curr) =>
        curr.map((t) => (t.path === path ? { ...t, loading: true } : t)),
      );
      try {
        const result = await rpc.call("readFile", { scope, path });
        setTabs((curr) =>
          curr.map((t) => {
            if (t.path !== path) return t;
            return {
              ...t,
              file: result,
              loading: false,
              draftText: result.state === "text" ? result.content : "",
              savedText: result.state === "text" ? result.content : "",
              saveState: { kind: "saved" },
            };
          }),
        );
        return true;
      } catch (error) {
        setTabs((curr) =>
          curr.map((t) =>
            t.path === path
              ? {
                  ...t,
                  loading: false,
                  saveState: { kind: "error", message: message(error) },
                }
              : t,
          ),
        );
        return false;
      }
    },
    [canRead, rpc, scope],
  );

  const overwrite = useCallback(
    async (path: string) => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return false;
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab || tab.file?.state !== "text") return false;
      setTabs((curr) =>
        curr.map((t) =>
          t.path === path ? { ...t, saveState: { kind: "saving" } } : t,
        ),
      );
      try {
        const result = await rpc.call("overwriteFile", {
          scope,
          path,
          content: tab.draftText,
        });
        if (result.outcome === "conflict") {
          setTabs((curr) =>
            curr.map((t) =>
              t.path === path
                ? {
                    ...t,
                    saveState: {
                      kind: "conflict",
                      currentSha256: result.currentSha256,
                    },
                  }
                : t,
            ),
          );
          return false;
        }
        setTabs((curr) =>
          curr.map((t) => {
            if (t.path !== path) return t;
            return {
              ...t,
              file: {
                ...t.file,
                sha256: result.sha256,
                sizeBytes: result.sizeBytes,
              } as OpenFile,
              savedText: tab.draftText,
              saveState: { kind: "saved" },
            };
          }),
        );
        return true;
      } catch (error) {
        setTabs((curr) =>
          curr.map((t) =>
            t.path === path
              ? { ...t, saveState: { kind: "error", message: message(error) } }
              : t,
          ),
        );
        return false;
      }
    },
    [canRead, rpc, scope],
  );

  useEffect(() => {
    if (!canRead) return;
    const timer = window.setInterval(() => {
      void refreshTree(query, { silent: true });
      const currentTabs = tabsRef.current;
      currentTabs.forEach((tab) => {
        const path = tab.path;
        if (!tab.file) return;
        void rpc
          .call("readFile", { scope, path })
          .then((remote) => {
            const latestTab = tabsRef.current.find((t) => t.path === path);
            if (!latestTab || latestTab.file?.sha256 === tab.file?.sha256)
              return;

            if (latestTab.draftText === latestTab.savedText) {
              setTabs((curr) =>
                curr.map((t) => {
                  if (t.path !== path) return t;
                  return {
                    ...t,
                    file: remote,
                    draftText: remote.state === "text" ? remote.content : "",
                    savedText: remote.state === "text" ? remote.content : "",
                  };
                }),
              );
            } else {
              setTabs((curr) =>
                curr.map((t) =>
                  t.path === path
                    ? {
                        ...t,
                        saveState: {
                          kind: "conflict",
                          currentSha256: remote.sha256,
                        },
                      }
                    : t,
                ),
              );
            }
          })
          .catch(() => undefined);
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [canRead, query, refreshTree, rpc, scope]);

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>) => {
      if (!canRead)
        return { ok: false as const, error: FILE_SOURCE_UNAVAILABLE };
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
      if (!isCanonicalWorkspacePath(path))
        return Promise.resolve({ ok: false as const, error: "Invalid path." });
      if (scope === null)
        return Promise.resolve({
          ok: false as const,
          error: FILE_SOURCE_UNAVAILABLE,
        });
      return runMutation(async () => {
        await rpc.call("createFile", { scope, path });
        // Если файл уже существует (conflict), мы просто проигнорируем ошибку
        // и всё равно откроем его. Это позволяет открывать скрытые файлы.
        await openPath(path);
      });
    },
    [openPath, rpc, runMutation, scope],
  );

  const createDirectory = useCallback(
    (path: string) => {
      if (!isCanonicalWorkspacePath(path))
        return Promise.resolve({ ok: false as const, error: "Invalid path." });
      if (scope === null)
        return Promise.resolve({
          ok: false as const,
          error: FILE_SOURCE_UNAVAILABLE,
        });
      return runMutation(() => rpc.call("createDirectory", { scope, path }));
    },
    [rpc, runMutation, scope],
  );

  const movePath = useCallback(
    (sourcePath: string, destinationPath: string) => {
      if (
        !isCanonicalWorkspacePath(sourcePath) ||
        !isCanonicalWorkspacePath(destinationPath)
      )
        return Promise.resolve({ ok: false as const, error: "Invalid path." });
      if (scope === null)
        return Promise.resolve({
          ok: false as const,
          error: FILE_SOURCE_UNAVAILABLE,
        });
      return runMutation(async () => {
        await rpc.call("movePath", { scope, sourcePath, destinationPath });
        setTabs((curr) => {
          const movedTabs = curr.map((t) => {
            if (t.path !== sourcePath && !t.path.startsWith(`${sourcePath}/`))
              return t;
            const movedPath =
              t.path === sourcePath
                ? destinationPath
                : `${destinationPath}${t.path.slice(sourcePath.length)}`;
            const moved = {
              version: 2 as const,
              scope: t.scope,
              path: movedPath,
            };
            return {
              ...t,
              ...moved,
              id: workspaceFileId(moved),
              file: t.file
                ? ({ ...t.file, path: movedPath } as OpenFile)
                : null,
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
    [rpc, runMutation, scope],
  );

  const removePath = useCallback(
    (path: string, recursive: boolean) => {
      if (!isCanonicalWorkspacePath(path))
        return Promise.resolve({ ok: false as const, error: "Invalid path." });
      if (scope === null)
        return Promise.resolve({
          ok: false as const,
          error: FILE_SOURCE_UNAVAILABLE,
        });
      return runMutation(async () => {
        await rpc.call("removePath", { scope, path, recursive });
        setTabs((curr) => {
          const filtered = curr.filter(
            (t) => !(t.path === path || t.path.startsWith(`${path}/`)),
          );
          if (!filtered.find((t) => t.path === activePathRef.current)) {
            setActivePath(
              filtered.length > 0 ? filtered[filtered.length - 1].path : null,
            );
          }
          return filtered;
        });
      });
    },
    [rpc, runMutation, scope],
  );

  const duplicatePath = useCallback(
    (
      kind: "file" | "directory",
      sourcePath: string,
      destinationPath: string,
    ) => {
      if (
        !isCanonicalWorkspacePath(sourcePath) ||
        !isCanonicalWorkspacePath(destinationPath)
      ) {
        return Promise.resolve({ ok: false as const, error: "Invalid path." });
      }
      if (scope === null)
        return Promise.resolve({
          ok: false as const,
          error: FILE_SOURCE_UNAVAILABLE,
        });
      return runMutation(async () => {
        const result = await rpc.call("duplicatePath", {
          scope,
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
    [rpc, runMutation, scope],
  );

  const uploadFiles = useCallback(
    async (directory: string, files: readonly File[]) => {
      if (
        !canRead ||
        (directory.length > 0 && !isCanonicalWorkspacePath(directory))
      ) {
        return { ok: false as const, error: "Invalid upload destination." };
      }
      if (files.length === 0) return { ok: true as const, count: 0 };

      let uploaded = 0;
      try {
        const token = await pluginToken();
        for (const file of files) {
          await uploadFile(scope, directory, file, token);
          uploaded += 1;
        }
        await refreshTree(query);
        return { ok: true as const, count: uploaded };
      } catch (error) {
        if (uploaded > 0) await refreshTree(query);
        const prefix =
          uploaded > 0 ? `Uploaded ${uploaded} of ${files.length}. ` : "";
        return { ok: false as const, error: `${prefix}${message(error)}` };
      }
    },
    [canRead, query, refreshTree, scope],
  );

  const getDownloadUrl = useCallback(
    async (path: string) => {
      if (!canRead || !isCanonicalWorkspacePath(path))
        throw new Error(
          "This file source is not available in the active workspace.",
        );
      const result = await rpc.call("getDownloadUrl", { scope, path });
      return result.url;
    },
    [canRead, rpc, scope],
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
        setTabs((curr) =>
          curr.map((t) =>
            t.path === path
              ? { ...t, saveState: { kind: "error", message: message(error) } }
              : t,
          ),
        );
      }
    },
    [canRead, getDownloadUrl],
  );

  const selectPath = useCallback(
    (path: string | null) => {
      if (
        !canRead ||
        (path !== null &&
          (!isCanonicalWorkspacePath(path) ||
            !tabsRef.current.some((tab) => tab.path === path)))
      )
        return;
      activePathRef.current = path;
      setActivePath(path);
    },
    [canRead],
  );

  const setDraftText = useCallback(
    (path: string, text: string) => {
      if (
        !canRead ||
        !isCanonicalWorkspacePath(path) ||
        !tabsRef.current.some((tab) => tab.path === path)
      )
        return;
      setTabs((curr) =>
        curr.map((t) => (t.path === path ? { ...t, draftText: text } : t)),
      );
    },
    [canRead],
  );

  return useMemo(
    () => ({
      tabs,
      activePath,
      annotateAvailable,
      sqlAvailable,
      setActivePath: selectPath,
      closeFile,
      createDirectory,
      createFile,
      downloadPath,
      getDownloadUrl,
      setDraftText,
      duplicatePath,
      entries,
      expandedDirs,
      toggleDirectory,
      movePath,
      openPath,
      openInPreferredViewer,
      overwrite,
      query,
      reveal,
      revealPath,
      refreshTree: () => refreshTree(query, { force: true }),
      searchStatus,
      reloadFile,
      removePath,
      rootName,
      save,
      setQuery,
      treeError,
      treeLoading,
      truncated,
      uploadFiles,
    }),
    [
      tabs,
      activePath,
      annotateAvailable,
      sqlAvailable,
      selectPath,
      closeFile,
      createDirectory,
      createFile,
      downloadPath,
      getDownloadUrl,
      setDraftText,
      duplicatePath,
      entries,
      expandedDirs,
      toggleDirectory,
      movePath,
      openPath,
      openInPreferredViewer,
      overwrite,
      query,
      reveal,
      revealPath,
      refreshTree,
      searchStatus,
      reloadFile,
      removePath,
      rootName,
      save,
      treeError,
      treeLoading,
      truncated,
      uploadFiles,
    ],
  );
}
