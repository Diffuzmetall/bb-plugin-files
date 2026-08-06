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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useFilesWorkspace(threadId: string) {
  const rpc = useRpc<typeof filesRpcContract>();
  const [query, setQuery] = useState("");
  const [rootName, setRootName] = useState("Files");
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>({ kind: "saved" });

  const selectedRef = useRef(selectedPath);
  const fileRef = useRef(openFile);
  const draftRef = useRef(draftText);
  const savedRef = useRef(savedText);
  const saveStateRef = useRef(saveState);
  const treeRequestRef = useRef(0);
  const fileRequestRef = useRef(0);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => void (selectedRef.current = selectedPath), [selectedPath]);
  useEffect(() => void (fileRef.current = openFile), [openFile]);
  useEffect(() => void (draftRef.current = draftText), [draftText]);
  useEffect(() => void (savedRef.current = savedText), [savedText]);
  useEffect(() => void (saveStateRef.current = saveState), [saveState]);

  const isDirty = openFile?.state === "text" && draftText !== savedText;

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

  const save = useCallback(async (): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const file = fileRef.current;
    const selected = selectedRef.current;
    const draft = draftRef.current;
    if (
      file?.state !== "text" ||
      selected === null ||
      draft === savedRef.current
    ) {
      return saveStateRef.current.kind !== "conflict";
    }
    if (saveStateRef.current.kind === "conflict") return false;

    const pending = (async () => {
      setSaveState({ kind: "saving" });
      try {
        const result = await rpc.call("saveFile", {
          threadId,
          path: selected,
          content: draft,
          expectedSha256: file.sha256,
        });
        if (result.outcome === "conflict") {
          setSaveState({
            kind: "conflict",
            currentSha256: result.currentSha256,
          });
          return false;
        }
        if (selectedRef.current === selected) {
          setOpenFile((current) =>
            current?.state === "text" && current.path === selected
              ? { ...current, sha256: result.sha256, sizeBytes: result.sizeBytes }
              : current,
          );
          setSavedText(draft);
          setSaveState({ kind: "saved" });
        }
        return true;
      } catch (error) {
        if (selectedRef.current === selected) {
          setSaveState({ kind: "error", message: message(error) });
        }
        return false;
      }
    })();
    savePromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      if (savePromiseRef.current === pending) savePromiseRef.current = null;
    }
  }, [rpc, threadId]);

  const applyReadResult = useCallback((path: string, result: OpenFile) => {
    setSelectedPath(path);
    setOpenFile(result);
    if (result.state === "text") {
      setDraftText(result.content);
      setSavedText(result.content);
    } else {
      setDraftText("");
      setSavedText("");
    }
    setSaveState({ kind: "saved" });
  }, []);

  const openPath = useCallback(
    async (path: string): Promise<boolean> => {
      if (path === selectedRef.current) return true;
      if (!(await save())) return false;
      const request = ++fileRequestRef.current;
      setFileLoading(true);
      try {
        const result = await rpc.call("readFile", { threadId, path });
        if (request !== fileRequestRef.current) return false;
        applyReadResult(path, result);
        return true;
      } catch (error) {
        if (request === fileRequestRef.current) {
          setSaveState({ kind: "error", message: message(error) });
        }
        return false;
      } finally {
        if (request === fileRequestRef.current) setFileLoading(false);
      }
    },
    [applyReadResult, rpc, save, threadId],
  );

  const closeFile = useCallback(async () => {
    if (!(await save())) return false;
    ++fileRequestRef.current;
    setSelectedPath(null);
    setOpenFile(null);
    setDraftText("");
    setSavedText("");
    setSaveState({ kind: "saved" });
    return true;
  }, [save]);

  useEffect(() => {
    if (!isDirty || saveState.kind === "conflict") return;
    const timer = window.setTimeout(() => void save(), 700);
    return () => window.clearTimeout(timer);
  }, [draftText, isDirty, save, saveState.kind]);

  const reloadFile = useCallback(async () => {
    const path = selectedRef.current;
    if (path === null) return false;
    const request = ++fileRequestRef.current;
    setFileLoading(true);
    try {
      const result = await rpc.call("readFile", { threadId, path });
      if (request !== fileRequestRef.current) return false;
      applyReadResult(path, result);
      return true;
    } catch (error) {
      setSaveState({ kind: "error", message: message(error) });
      return false;
    } finally {
      if (request === fileRequestRef.current) setFileLoading(false);
    }
  }, [applyReadResult, rpc, threadId]);

  const overwrite = useCallback(async () => {
    const path = selectedRef.current;
    const file = fileRef.current;
    if (path === null || file?.state !== "text") return false;
    setSaveState({ kind: "saving" });
    try {
      const result = await rpc.call("overwriteFile", {
        threadId,
        path,
        content: draftRef.current,
      });
      if (result.outcome === "conflict") {
        setSaveState({ kind: "conflict", currentSha256: result.currentSha256 });
        return false;
      }
      setOpenFile({ ...file, sha256: result.sha256, sizeBytes: result.sizeBytes });
      setSavedText(draftRef.current);
      setSaveState({ kind: "saved" });
      return true;
    } catch (error) {
      setSaveState({ kind: "error", message: message(error) });
      return false;
    }
  }, [rpc, threadId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshTree(query, true);
      const path = selectedRef.current;
      const current = fileRef.current;
      if (path === null || current === null) return;
      void rpc
        .call("readFile", { threadId, path })
        .then((remote) => {
          if (selectedRef.current !== path || remote.sha256 === current.sha256) {
            return;
          }
          if (draftRef.current !== savedRef.current) {
            setSaveState({ kind: "conflict", currentSha256: remote.sha256 });
            return;
          }
          applyReadResult(path, remote);
        })
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [applyReadResult, query, refreshTree, rpc, threadId]);

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
        if (selectedRef.current === sourcePath) {
          setSelectedPath(destinationPath);
          setOpenFile((current) =>
            current ? { ...current, path: destinationPath } : null,
          );
        }
      }),
    [rpc, runMutation, threadId],
  );

  const removePath = useCallback(
    (path: string, recursive: boolean) =>
      runMutation(async () => {
        await rpc.call("removePath", { threadId, path, recursive });
        const selected = selectedRef.current;
        if (selected === path || selected?.startsWith(`${path}/`)) {
          setSelectedPath(null);
          setOpenFile(null);
          setDraftText("");
          setSavedText("");
        }
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

  return useMemo(
    () => ({
      closeFile,
      createDirectory,
      createFile,
      draftText,
      duplicatePath,
      entries,
      fileLoading,
      isDirty,
      movePath,
      openFile,
      openPath,
      overwrite,
      query,
      refreshTree: () => refreshTree(query),
      reloadFile,
      removePath,
      rootName,
      save,
      saveState,
      selectedPath,
      setDraftText,
      setQuery,
      treeError,
      treeLoading,
      truncated,
    }),
    [
      closeFile,
      createDirectory,
      createFile,
      draftText,
      duplicatePath,
      entries,
      fileLoading,
      isDirty,
      movePath,
      openFile,
      openPath,
      overwrite,
      query,
      refreshTree,
      reloadFile,
      removePath,
      rootName,
      save,
      saveState,
      selectedPath,
      treeError,
      treeLoading,
      truncated,
    ],
  );
}
