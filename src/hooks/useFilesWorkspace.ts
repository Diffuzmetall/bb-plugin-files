import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbContext, useRpc } from "@bb/plugin-sdk/app";
import type { filesRpcContract } from "../../server";
import { parentPath } from "../tree-order";
import type { FileScope } from "../contracts";
import { fileScopeSchema, sameSource } from "../file-scope";
export { sameSource } from "../file-scope";

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

function canonicalScope(scope: FileScope): FileScope {
  if (scope.kind === "thread") {
    return { kind: "thread", threadId: scope.threadId };
  }
  if (scope.kind === "thread-storage") {
    return { kind: "thread-storage", threadId: scope.threadId };
  }
  return {
    kind: "host",
    ...(scope.hostId !== undefined ? { hostId: scope.hostId } : {}),
    ...(scope.rootPath !== undefined ? { rootPath: scope.rootPath } : {}),
  };
}

export function workspaceFileId(identity: WorkspaceFileIdentity): string {
  return JSON.stringify([identity.version, canonicalScope(identity.scope), identity.path]);
}

function storageKey(scope: FileScope): string {
  return `${WORKSPACE_STORAGE_PREFIX}${JSON.stringify(canonicalScope(scope))}`;
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
    if (!parsedScope.success) return null;
    const scopeData = parsedScope.data;
    if (scopeData.kind === "host" && scopeData.rootPath) {
      const segments = scopeData.rootPath.split("/");
      if (
        scopeData.rootPath.length > MAX_WORKSPACE_PATH_LENGTH ||
        !scopeData.rootPath.startsWith("/") ||
        scopeData.rootPath.includes("\\") ||
        scopeData.rootPath.includes("\0") ||
        segments.some((segment) => segment === "." || segment === "..")
      ) {
        return null;
      }
    }
    return { identity: { version: 2, scope: scopeData, path: item.path }, legacyId: null };
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

function storedIdMatches(identity: WorkspaceFileIdentity, storedId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(storedId);
    if (!Array.isArray(parsed) || parsed[0] !== 2 || parsed[2] !== identity.path) return false;
    const storedScope = fileScopeSchema.safeParse(parsed[1]);
    return storedScope.success && sameSource(storedScope.data, identity.scope);
  } catch {
    return false;
  }
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
        .filter((value): value is RestoredWorkspaceFile => value !== null);
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
                storedIdMatches(identity, parsed.activeFileId as string) ||
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
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => initialWorkspace.activeFileId,
  );

  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const treeRequestRef = useRef(0);
  const fileLoadRequestsRef = useRef<Map<string, { promise: Promise<boolean>; error?: string }>>(new Map());
  const savePromisesRef = useRef<Record<string, Promise<boolean> | undefined>>(
    {},
  );
  const childrenByDirRef = useRef(childrenByDir);
  const expandedDirsRef = useRef(expandedDirs);
  const dirRequestsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => void (tabsRef.current = tabs), [tabs]);
  useEffect(() => void (activeTabIdRef.current = activeTabId), [activeTabId]);
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
      activeFileId: activeTabId,
    });
  }, [activeTabId, tabs, workspaceScope]);

  // One owner per load generation; the retained request object rejects late completions.
  const loadFile = useCallback((tab: TabState, force = false): Promise<boolean> => {
    const previous = fileLoadRequestsRef.current.get(tab.id);
    if (previous && !force) return previous.promise;
    const request: { promise: Promise<boolean>; error?: string } = { promise: Promise.resolve(false) };
    fileLoadRequestsRef.current.set(tab.id, request);
    request.promise = (async () => {
      try {
        const result = await rpc.call("readFile", { scope: tab.scope, path: tab.path });
        if (fileLoadRequestsRef.current.get(tab.id) !== request) return false;
        const nextTabs = tabsRef.current.map((current): TabState => current.id !== tab.id ? current : {
          ...current,
          file: result,
          loading: false,
          draftText: current.draftText !== tab.draftText ? current.draftText : result.state === "text" ? result.content : "",
          savedText: result.state === "text" ? result.content : "",
          saveState: { kind: "saved" },
        });
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        return true;
      } catch (error) {
        if (fileLoadRequestsRef.current.get(tab.id) !== request) return false;
        request.error = message(error);
        const nextTabs = tabsRef.current.map((current): TabState => current.id !== tab.id ? current : {
          ...current,
          loading: false,
          saveState: { kind: "error", message: request.error! },
        });
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        return false;
      }
    })();
    return request.promise;
  }, [rpc]);

  useEffect(() => {
    for (const id of fileLoadRequestsRef.current.keys()) {
      if (!tabs.some((tab) => tab.id === id)) fileLoadRequestsRef.current.delete(id);
    }
    if (!canRead) return;
    tabs.forEach((tab) => {
      if (tab.file === null && tab.loading) void loadFile(tab);
    });
  }, [canRead, loadFile, tabs]);

  const openInPreferredViewer = useCallback(
    async (path: string, targetScope?: FileScope) => {
      const effectiveScope = targetScope ?? scope;
      if (effectiveScope?.kind !== "thread" || !isCanonicalWorkspacePath(path))
        return false;
      const result = await rpc.call("openFile", { scope: effectiveScope, path });
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
    const currentActiveTab = tabsRef.current.find((t) => t.id === activeTabId);
    if (!currentActiveTab || !sameSource(currentActiveTab.scope, workspaceScope)) return;
    let parent = parentPath(currentActiveTab.path);
    while (parent.length > 0) {
      expandDirectory(parent);
      parent = parentPath(parent);
    }
  }, [activeTabId, expandDirectory, workspaceScope]);

  const findTab = useCallback(
    (target: string | null): TabState | undefined => {
      if (target === null) return undefined;
      return tabsRef.current.find((t) => t.id === target);
    },
    [],
  );

  const commitWrite = useCallback((tabId: string, content: string, result: { sha256: string; sizeBytes: number }) => {
    // A successful write owns a new snapshot identity, superseding older loads and polls.
    fileLoadRequestsRef.current.set(tabId, { promise: Promise.resolve(true) });
    const nextTabs = tabsRef.current.map((current): TabState => current.id !== tabId ? current : {
      ...current,
      file: current.file?.state === "text" ? { ...current.file, sha256: result.sha256, sizeBytes: result.sizeBytes } : current.file,
      savedText: content,
      loading: false,
      saveState: { kind: "saved" },
    });
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
  }, []);

  const save = useCallback(
    async (target: string): Promise<boolean> => {
      if (!canRead) return false;
      const tab = findTab(target);
      if (!tab || !isCanonicalWorkspacePath(tab.path)) return false;
      const tabId = tab.id;
      const existingPromise = savePromisesRef.current[tabId];
      if (existingPromise) return existingPromise;

      if (tab.file?.state !== "text" || tab.draftText === tab.savedText) {
        return tab.saveState.kind !== "conflict";
      }
      if (tab.saveState.kind === "conflict") return false;
      const file = tab.file;
      if (file?.state !== "text") return false;

      const pending = (async () => {
        setTabs((curr) =>
          curr.map((t) =>
            t.id === tabId ? { ...t, saveState: { kind: "saving" } } : t,
          ),
        );
        const currentTab = tabsRef.current.find((t) => t.id === tabId);
        if (!currentTab) return false;
        const tabScope = currentTab.scope;
        try {
          const result = await rpc.call("saveFile", {
            scope: tabScope,
            path: currentTab.path,
            content: currentTab.draftText,
            expectedSha256: file.sha256,
          });
          if (result.outcome === "conflict") {
            setTabs((curr) =>
              curr.map((t) =>
                t.id === tabId
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
          commitWrite(tabId, currentTab.draftText, result);
          // A completed write is not a fully saved tab if newer edits arrived.
          return tabsRef.current.find((t) => t.id === tabId)?.draftText === currentTab.draftText;
        } catch (error) {
          setTabs((curr) =>
            curr.map((t) =>
              t.id === tabId
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
      savePromisesRef.current[tabId] = pending;
      try {
        return await pending;
      } finally {
        if (savePromisesRef.current[tabId] === pending) {
          delete savePromisesRef.current[tabId];
        }
      }
    },
    [canRead, commitWrite, findTab, rpc],
  );

  const openPath = useCallback(
    async (path: string, targetScope?: FileScope): Promise<boolean> => {
      if (!canRead || !isCanonicalWorkspacePath(path)) return false;
      const effectiveScope = targetScope ?? workspaceScope;
      if (effectiveScope === null) return false;
      const identity = { version: 2 as const, scope: effectiveScope, path };
      const id = workspaceFileId(identity);
      const existingTab = tabsRef.current.find((tab) => tab.id === id);
      if (existingTab) {
        activeTabIdRef.current = id;
        setActiveTabId(id);
        return existingTab.file !== null ? true : loadFile(existingTab, !existingTab.loading);
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
      activeTabIdRef.current = id;
      setActiveTabId(id);
      tabsRef.current = nextTabs;
      setTabs(nextTabs);

      return loadFile(newTab, true);
    },
    [canRead, loadFile, workspaceScope],
  );

  const closeFile = useCallback(
    async (target: string) => {
      if (!canRead) return false;
      const tab = findTab(target);
      if (!tab) return false;
      const tabId = tab.id;
      const isDirty =
        tab.file?.state === "text" && tab.draftText !== tab.savedText;
      if (isDirty) {
        if (!(await save(tabId))) return false;
        if (tabsRef.current.find((t) => t.id === tabId)?.draftText !== tab.draftText)
          return false;
      }
      fileLoadRequestsRef.current.delete(tabId);
      const filtered = tabsRef.current.filter((t) => t.id !== tabId);
      tabsRef.current = filtered;
      setTabs(filtered);
      if (activeTabIdRef.current === tabId) {
        const nextActiveId = filtered.length > 0 ? filtered[filtered.length - 1].id : null;
        activeTabIdRef.current = nextActiveId;
        setActiveTabId(nextActiveId);
      }
      return true;
    },
    [canRead, findTab, save],
  );

  useEffect(() => {
    const timers = tabs
      .filter(
        (t) =>
          t.file?.state === "text" &&
          t.draftText !== t.savedText &&
          t.saveState.kind !== "conflict",
      )
      .map((t) => window.setTimeout(() => void save(t.id), 700));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [tabs, save]);

  const reloadFile = useCallback(
    async (target: string) => {
      if (!canRead) return false;
      const tab = findTab(target);
      if (!tab || !isCanonicalWorkspacePath(tab.path)) return false;
      setTabs((curr) => curr.map((t) => t.id === tab.id ? { ...t, loading: true } : t));
      return loadFile(tab, true);
    },
    [canRead, findTab, loadFile],
  );

  const overwrite = useCallback(
    async (target: string) => {
      if (!canRead) return false;
      const tab = findTab(target);
      if (
        !tab ||
        tab.file?.state !== "text" ||
        !isCanonicalWorkspacePath(tab.path)
      )
        return false;
      const tabId = tab.id;
      const tabScope = tab.scope;
      const path = tab.path;
      setTabs((curr) =>
        curr.map((t) =>
          t.id === tabId ? { ...t, saveState: { kind: "saving" } } : t,
        ),
      );
      try {
        const result = await rpc.call("overwriteFile", {
          scope: tabScope,
          path,
          content: tab.draftText,
        });
        if (result.outcome === "conflict") {
          setTabs((curr) =>
            curr.map((t) =>
              t.id === tabId
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
        commitWrite(tabId, tab.draftText, result);
        return true;
      } catch (error) {
        setTabs((curr) =>
          curr.map((t) =>
            t.id === tabId
              ? { ...t, saveState: { kind: "error", message: message(error) } }
              : t,
          ),
        );
        return false;
      }
    },
    [canRead, commitWrite, findTab, rpc],
  );

  useEffect(() => {
    if (!canRead) return;
    const timer = window.setInterval(() => {
      void refreshTree(query, { silent: true });
      const currentTabs = tabsRef.current;
      currentTabs.forEach((tab) => {
        const path = tab.path;
        const id = tab.id;
        const tabScope = tab.scope;
        const captureSha = tab.file?.sha256;
        const captureLoad = fileLoadRequestsRef.current.get(id);
        if (!tab.file) return;
        void rpc
          .call("readFile", { scope: tabScope, path })
          .then((remote) => {
            const latestTab = tabsRef.current.find((t) => t.id === id);
            if (!latestTab || !latestTab.file || fileLoadRequestsRef.current.get(id) !== captureLoad) return;

            // Stale check: if tab was saved/modified locally while readFile was in flight
            if (latestTab.file.sha256 !== captureSha) return;

            // Remote sha unchanged: nothing to update
            if (remote.sha256 === latestTab.file.sha256) return;

            if (latestTab.draftText === latestTab.savedText) {
              setTabs((curr) =>
                curr.map((t) => {
                  if (t.id !== id) return t;
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
                  t.id === id
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
  }, [canRead, query, refreshTree, rpc]);

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
        let nextActiveId = activeTabIdRef.current;
        const currentActive = tabsRef.current.find(
          (t) => t.id === activeTabIdRef.current,
        );
        if (
          currentActive &&
          sameSource(currentActive.scope, scope) &&
          (currentActive.path === sourcePath ||
            currentActive.path.startsWith(`${sourcePath}/`))
        ) {
          const movedActivePath =
            currentActive.path === sourcePath
              ? destinationPath
              : `${destinationPath}${currentActive.path.slice(sourcePath.length)}`;
          nextActiveId = workspaceFileId({
            version: 2 as const,
            scope: currentActive.scope,
            path: movedActivePath,
          });
        }

        const movedTabs = tabsRef.current.map((t) => {
          if (!sameSource(t.scope, scope)) return t;
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
        setTabs(movedTabs);
        if (nextActiveId !== activeTabIdRef.current) {
          activeTabIdRef.current = nextActiveId;
          setActiveTabId(nextActiveId);
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
        const filtered = tabsRef.current.filter(
          (t) =>
            !(
              sameSource(t.scope, scope) &&
              (t.path === path || t.path.startsWith(`${path}/`))
            ),
        );
        tabsRef.current = filtered;
        setTabs(filtered);
        if (!filtered.find((t) => t.id === activeTabIdRef.current)) {
          const nextActiveId =
            filtered.length > 0 ? filtered[filtered.length - 1].id : null;
          activeTabIdRef.current = nextActiveId;
          setActiveTabId(nextActiveId);
        }
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
    async (target: string, targetScope?: FileScope) => {
      if (!canRead)
        throw new Error(
          "This file source is not available in the active workspace.",
        );
      const tab = findTab(target);
      const effectiveScope = targetScope ?? tab?.scope ?? null;
      const effectivePath = targetScope ? target : tab?.path ?? "";
      if (effectiveScope === null || !isCanonicalWorkspacePath(effectivePath))
        throw new Error(
          "This file source is not available in the active workspace.",
        );
      const result = await rpc.call("getDownloadUrl", { scope: effectiveScope, path: effectivePath });
      return result.url;
    },
    [canRead, findTab, rpc, scope],
  );

  const downloadPath = useCallback(
    async (path: string, targetScope: FileScope = workspaceScope) => {
      if (!canRead) return;
      if (!isCanonicalWorkspacePath(path)) return;
      try {
        const url = await getDownloadUrl(path, targetScope);
        const a = document.createElement("a");
        a.href = url;
        a.download = path.split("/").pop() || "download";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (error) {
        setTabs((curr) =>
          curr.map((t) =>
            sameSource(t.scope, targetScope) && t.path === path
              ? { ...t, saveState: { kind: "error", message: message(error) } }
              : t,
          ),
        );
      }
    },
    [canRead, getDownloadUrl, workspaceScope],
  );

  const downloadFile = useCallback(
    async (id: string) => {
      const tab = findTab(id);
      if (tab) await downloadPath(tab.path, tab.scope);
    },
    [downloadPath, findTab],
  );

  const createNote = useCallback(
    async (directory?: string) => {
      if (!canRead || scope === null) {
        const err = FILE_SOURCE_UNAVAILABLE;
        setTreeError(err);
        return {
          ok: false as const,
          error: err,
        };
      }
      try {
        const result = await rpc.call("createNote", {
          currentScope: scope,
          ...(directory === undefined ? {} : { directory }),
        });

        const isCurrentScope = sameSource(result.scope, scope);
        if (isCurrentScope) {
          await refreshTree(query);
          revealPath(result.path);
        }
        let preferredDelivered = false;
        if (result.scope.kind === "thread") {
          try {
            preferredDelivered = await openInPreferredViewer(result.path, result.scope);
          } catch {
            // Keep the created file usable in Files when another opener fails.
          }
        }
        if (!preferredDelivered && !(await openPath(result.path, result.scope))) {
          const readError = fileLoadRequestsRef.current.get(workspaceFileId({ version: 2, scope: result.scope, path: result.path }))?.error;
          const error = `Created ${result.path}, but could not open it in Files.${readError ? ` ${readError}` : ""} Retry opening the existing file; do not create it again.`;
          setTreeError(error);
          return { ok: false as const, note: result, openedInPreferred: false, error };
        }
        return {
          ok: true as const,
          note: result,
          openedInPreferred: preferredDelivered,
        };
      } catch (error) {
        const errMessage = message(error);
        setTreeError(errMessage);
        return { ok: false as const, error: errMessage };
      }
    },
    [
      canRead,
      openInPreferredViewer,
      openPath,
      query,
      refreshTree,
      revealPath,
      rpc,
      scope,
    ],
  );

  const selectTab = useCallback(
    (id: string | null) => {
      if (
        !canRead ||
        (id !== null && !tabsRef.current.some((tab) => tab.id === id))
      )
        return;
      activeTabIdRef.current = id;
      setActiveTabId(id);
    },
    [canRead],
  );

  const setDraftText = useCallback(
    (target: string, text: string) => {
      if (!canRead) return;
      const tab = findTab(target);
      if (!tab) return;
      const tabId = tab.id;
      setTabs((curr) =>
        curr.map((t) => (t.id === tabId ? { ...t, draftText: text } : t)),
      );
    },
    [canRead, findTab],
  );

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  return useMemo(
    () => ({
      tabs,
      activeTabId,
      activeTab,
      annotateAvailable,
      sqlAvailable,
      setActiveTabId: selectTab,
      closeFile,
      createDirectory,
      createFile,
      createNote,
      downloadPath,
      downloadFile,
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
      setTreeError,
      treeLoading,
      truncated,
      uploadFiles,
    }),
    [
      tabs,
      activeTabId,
      activeTab,
      annotateAvailable,
      sqlAvailable,
      selectTab,
      closeFile,
      createDirectory,
      createFile,
      createNote,
      downloadPath,
      downloadFile,
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
