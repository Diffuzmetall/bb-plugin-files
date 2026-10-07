import { useEffect, useState, useRef } from "react";
import {
  useBbContext,
  useBbNavigate,
  useRpc,
  type PluginFileOpenerProps,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EditorPane } from "./EditorPane";
import type { FileAction } from "./FileContextMenu";
import { OperationDialog, type OperationRequest } from "./OperationDialog";
import { TreePane } from "./TreePane";
import {
  FILE_SOURCE_UNAVAILABLE,
  useFilesWorkspace,
  type FileTreeEntry,
  type FilesRootScope,
} from "../hooks/useFilesWorkspace";
import { useResponsiveLayout } from "../hooks/useResponsiveLayout";
import { publishFilesOpen, subscribeFilesOpen } from "../files-open-bus";
import type { filesRpcContract } from "../../server";

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function childPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

function duplicateSuggestion(entry: FileTreeEntry): string {
  const parent = parentPath(entry.path);
  if (entry.kind === "directory")
    return childPath(parent, `${entry.name} copy`);
  const dot = entry.name.lastIndexOf(".");
  const name =
    dot > 0
      ? `${entry.name.slice(0, dot)} copy${entry.name.slice(dot)}`
      : `${entry.name} copy`;
  return childPath(parent, name);
}

type FilesPanelProps =
  | PluginThreadPanelProps
  | PluginFileOpenerProps
  | PluginNavPanelProps;

function isFileOpenerProps(
  props: FilesPanelProps,
): props is PluginFileOpenerProps {
  return "source" in props;
}

/** The left-sidebar entry owns its own route and carries no thread. */
function isNavPanelProps(props: FilesPanelProps): props is PluginNavPanelProps {
  return "subPath" in props;
}

type OpenedFileTarget = { rootScope: FilesRootScope; path: string };
type RequestIdentity = { key: string; generation: number };
type OpenedFileResolution =
  | {
      requestKey: string;
      generation: number;
      state: "file";
      target: OpenedFileTarget;
    }
  | {
      requestKey: string;
      generation: number;
      state: "pending" | "unsupported";
      previousTarget: OpenedFileTarget | null;
    };

function workspacePathFromParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const record = params as { path?: unknown; source?: unknown };
  if (typeof record.path !== "string" || record.path.length === 0) {
    return null;
  }
  if (record.path.startsWith("/")) return null;
  if (record.source === undefined) return record.path;
  if (typeof record.source !== "object" || record.source === null) return null;
  const kind = (record.source as { kind?: unknown }).kind;
  return kind === undefined || kind === "workspace" ? record.path : null;
}

function isWorkspaceFileLink(
  source: PluginFileOpenerProps["source"],
  path: string,
): boolean {
  return source.kind === "workspace" && !path.startsWith("/");
}

export function FilesPanel(props: FilesPanelProps) {
  const context = useBbContext();
  if (isNavPanelProps(props)) {
    return (
      <FilesPanelContent key="host-root" initialPath={null} rootScope="host" />
    );
  }
  // The host context and server-side root resolution are the authorization
  // boundary. Opener and panel props are persisted input only.
  if (isFileOpenerProps(props)) {
    return <OpenedFile source={props.source} path={props.path} />;
  }
  if (context.threadId === null) {
    return (
      <div
        className="grid h-full place-items-center p-6 text-sm text-muted-foreground"
        role="alert"
      >
        {FILE_SOURCE_UNAVAILABLE}
      </div>
    );
  }
  const requestedPath = workspacePathFromParams(props.params);
  return (
    <FilesPanelContent
      key={JSON.stringify([context.threadId, context.projectId])}
      initialPath={requestedPath}
      requestedPath={requestedPath}
      rootScope="thread"
    />
  );
}

function OpenedFile({
  source,
  path,
}: Pick<PluginFileOpenerProps, "source" | "path">) {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const sameActiveWorkspace =
    isWorkspaceFileLink(source, path) &&
    source.threadId !== null &&
    source.threadId === context.threadId;
  const [local, setLocal] = useState(!sameActiveWorkspace);

  useEffect(() => {
    if (!sameActiveWorkspace) {
      setLocal(true);
      return;
    }
    publishFilesOpen({ path, threadId: source.threadId });
    if (!navigate.openThreadPanel({ actionId: "files", title: "Files" })) {
      setLocal(true);
    }
  }, [navigate, path, sameActiveWorkspace, source]);

  if (!local) return null;
  return <OpenedFileLocal source={source} path={path} />;
}

/** A file link from another surface: workspace files open in the thread root,
 * host files re-root the panel at the directory that owns them. */
function OpenedFileLocal({
  source,
  path,
}: Pick<PluginFileOpenerProps, "source" | "path">) {
  const rpc = useRpc<typeof filesRpcContract>();
  const context = useBbContext();
  // `useRpc` may hand back a fresh client on every render, so the request is
  // keyed by the link itself and issued once per link.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const requestedGenerationRef = useRef<number | null>(null);
  // A workspace path is already relative to this thread root. Other sources
  // resolve through their own thread or host identity.
  const workspaceThreadId =
    source.kind === "workspace" &&
    !path.startsWith("/") &&
    source.threadId !== null &&
    source.threadId === context.threadId
      ? source.threadId
      : null;
  const workspaceTarget =
    workspaceThreadId === null
      ? null
      : { rootScope: { kind: "thread" as const, threadId: workspaceThreadId }, path };
  const requestKey = JSON.stringify([
    source.kind,
    source.threadId,
    source.experimental_hostId ?? null,
    path,
    context.threadId,
  ]);
  const [requestIdentity, setRequestIdentity] = useState<RequestIdentity>(() => ({
    key: requestKey,
    generation: 0,
  }));
  if (requestIdentity.key !== requestKey) {
    setRequestIdentity({
      key: requestKey,
      generation: requestIdentity.generation + 1,
    });
  }
  const requestGeneration = requestIdentity.generation;
  const latestRequestRef = useRef({ requestKey, generation: requestGeneration });
  latestRequestRef.current = { requestKey, generation: requestGeneration };
  const [resolved, setResolved] = useState<OpenedFileResolution>(() =>
    workspaceTarget === null
      ? { requestKey, generation: requestGeneration, state: "pending", previousTarget: null }
      : { requestKey, generation: requestGeneration, state: "file", target: workspaceTarget },
  );

  useEffect(() => {
    if (workspaceThreadId !== null) {
      requestedGenerationRef.current = null;
      setResolved({
        requestKey,
        generation: requestGeneration,
        state: "file",
        target: {
          rootScope: { kind: "thread", threadId: workspaceThreadId },
          path,
        },
      });
      return;
    }
    if (requestedGenerationRef.current === requestGeneration) return;
    requestedGenerationRef.current = requestGeneration;
    // A key mismatch renders loading immediately; retain the previous target
    // mounted but hidden so a same-root resolution can preserve its drafts.
    void rpcRef.current
      .call("resolveOpenerFile", {
        source: {
          kind: source.kind,
          threadId: source.threadId,
          ...(source.experimental_hostId === undefined
            ? {}
            : { experimental_hostId: source.experimental_hostId }),
        },
        path,
      })
      .then((result) => {
        if (
          latestRequestRef.current.requestKey !== requestKey ||
          latestRequestRef.current.generation !== requestGeneration
        ) return;
        if (result.kind === "file") {
          setResolved({
            requestKey,
            generation: requestGeneration,
            state: "file",
            target: {
              rootScope: result.scope,
              path: result.path,
            },
          });
        } else {
          setResolved((previous) => ({
            requestKey,
            generation: requestGeneration,
            state: "unsupported",
            previousTarget:
              previous.state === "file" ? previous.target : previous.previousTarget,
          }));
        }
      })
      .catch(() => {
        if (
          latestRequestRef.current.requestKey === requestKey &&
          latestRequestRef.current.generation === requestGeneration
        ) {
          setResolved((previous) => ({
            requestKey,
            generation: requestGeneration,
            state: "unsupported",
            previousTarget:
              previous.state === "file" ? previous.target : previous.previousTarget,
          }));
        }
      });
  }, [
    path,
    requestKey,
    source.experimental_hostId,
    source.kind,
    source.threadId,
    workspaceThreadId,
    requestGeneration,
  ]);

  const target =
    workspaceTarget ??
    (resolved.state === "file" ? resolved.target : resolved.previousTarget);
  const targetIsCurrent =
    workspaceTarget !== null ||
    (resolved.requestKey === requestKey &&
      resolved.generation === requestGeneration &&
      resolved.state === "file");
  const isPending =
    workspaceTarget === null &&
    (resolved.requestKey !== requestKey ||
      resolved.generation !== requestGeneration ||
      resolved.state === "pending");
  const isUnsupported =
    workspaceTarget === null &&
    resolved.requestKey === requestKey &&
    resolved.generation === requestGeneration &&
    resolved.state === "unsupported";

  return (
    <>
      {target !== null && (
        <div hidden={!targetIsCurrent} className={targetIsCurrent ? "h-full" : undefined}>
          <FilesPanelContent
            key={
              typeof target.rootScope === "string"
                ? target.rootScope
                : JSON.stringify(target.rootScope)
            }
            initialPath={target.path}
            requestedPath={targetIsCurrent ? target.path : null}
            rootScope={target.rootScope}
          />
        </div>
      )}
      {isPending && (
        <div
          className="grid h-full place-items-center p-6 text-sm text-muted-foreground"
          role="status"
        >
          Opening file…
        </div>
      )}
      {isUnsupported && (
        <div
          className="grid h-full place-items-center p-6 text-sm text-muted-foreground"
          role="alert"
        >
          {FILE_SOURCE_UNAVAILABLE}
        </div>
      )}
    </>
  );
}

function FilesPanelContent({
  initialPath,
  requestedPath = null,
  rootScope,
}: {
  initialPath: string | null;
  requestedPath?: string | null;
  rootScope: FilesRootScope;
}) {
  const context = useBbContext();
  const workspace = useFilesWorkspace(initialPath, rootScope);
  const threadId =
    typeof rootScope === "string"
      ? rootScope === "thread"
        ? context.threadId
        : null
      : rootScope.kind === "thread"
        ? rootScope.threadId
        : null;
  const lastRequestedPath = useRef(requestedPath);
  useEffect(() => {
    if (requestedPath === null || requestedPath === lastRequestedPath.current) return;
    lastRequestedPath.current = requestedPath;
    void workspace.openPath(requestedPath);
  }, [requestedPath, workspace.openPath]);
  useEffect(
    () =>
      subscribeFilesOpen((request) => {
        if (threadId !== null && request.threadId === threadId) {
          void workspace.openPath(request.path);
        }
      }),
    [threadId, workspace.openPath],
  );
  // Opening a file in BB's own preview needs a thread tab, so the global root
  // keeps that action out of its menus.
  const showOpenPreferred =
    rootScope === "thread" ||
    (typeof rootScope !== "string" && rootScope.kind === "thread");
  const { containerRef, containerNode, containerWidth, isNarrow } = useResponsiveLayout();
  const [showingFiles, setShowingFiles] = useState(false);
  const filesVisible = isNarrow && (showingFiles || workspace.activePath === null);

  useEffect(() => setShowingFiles(false), [workspace.activePath, isNarrow]);
  useEffect(() => {
    if (!isNarrow) return;
    containerNode?.querySelector<HTMLInputElement | HTMLButtonElement>(
      filesVisible ? 'input[aria-label="Search files"]' : 'button[aria-label="Open files"]',
    )?.focus();
  }, [containerNode, filesVisible, isNarrow]);
  const [operation, setOperation] = useState<OperationRequest | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<FileTreeEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<{
    kind: "uploading" | "success" | "error";
    message: string;
  } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadDirectoryRef = useRef("");
  const uploadPendingRef = useRef(false);

  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const isResizing = useRef(false);
  // The overlapping 11px handle with -5px margins consumes 1px of layout.
  const minSidebarWidth = 150;
  const minEditorWidth = 200;
  const maxSidebarWidth = Math.max(minSidebarWidth, containerWidth - minEditorWidth - 1);
  const effectiveSidebarWidth = Math.max(minSidebarWidth, Math.min(sidebarWidth, maxSidebarWidth));
  const resizeSidebar = (width: number) =>
    setSidebarWidth(Math.max(minSidebarWidth, Math.min(width, maxSidebarWidth)));

  useEffect(() => { isResizing.current = false; }, [isNarrow, isSidebarOpen]);

  const startResizing = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isResizing.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing.current) return;
    const containerRect = containerNode?.getBoundingClientRect();
    if (containerRect) {
      // Since tree is on the right, width is right edge minus mouse X
      const newWidth = containerRect.right - e.clientX;
      if (newWidth < 100) {
        setIsSidebarOpen(false);
        isResizing.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        return;
      }
      resizeSidebar(newWidth);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    isResizing.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const requestCreate = (kind: "file" | "directory", parent = "") => {
    setOperation({
      kind: kind === "file" ? "create-file" : "create-directory",
      sourcePath: null,
      targetPath: childPath(
        parent,
        kind === "file" ? "untitled.txt" : "untitled",
      ),
      entryKind: kind,
    });
  };

  const openInPreferred = (path: string) =>
    void workspace.openInPreferredViewer(path);

  const chooseUpload = (directory: string) => {
    if (uploadPendingRef.current) return;
    uploadDirectoryRef.current = directory;
    uploadInputRef.current?.click();
  };

  const uploadFiles = async (directory: string, files: File[]) => {
    if (uploadPendingRef.current || files.length === 0) return;
    uploadPendingRef.current = true;
    const destination = directory.length > 0 ? directory : "the root";
    setUploadStatus({
      kind: "uploading",
      message: `Uploading ${files.length} ${files.length === 1 ? "file" : "files"} to ${destination}…`,
    });
    try {
      const result = await workspace.uploadFiles(directory, files);
      setUploadStatus(
        result.ok
          ? {
              kind: "success",
              message: `Uploaded ${result.count} ${result.count === 1 ? "file" : "files"} to ${destination}.`,
            }
          : { kind: "error", message: result.error },
      );
    } finally {
      uploadPendingRef.current = false;
    }
  };

  const handleAction = (action: FileAction, entry: FileTreeEntry) => {
    if (
      action === "annotate" ||
      action === "open-sql" ||
      action === "open-preferred"
    ) {
      openInPreferred(entry.path);
      return;
    }
    if (action === "reveal") {
      workspace.revealPath(entry.path);
      return;
    }
    if (action === "copy-path") {
      void navigator.clipboard.writeText(entry.path);
      return;
    }
    if (action === "download") {
      void workspace.downloadPath(entry.path);
      return;
    }
    if (action === "upload") {
      chooseUpload(entry.path);
      return;
    }
    if (action === "delete") {
      setDeleteError(null);
      setDeleteEntry(entry);
      return;
    }
    if (action === "create-file" || action === "create-directory") {
      requestCreate(
        action === "create-file" ? "file" : "directory",
        entry.path,
      );
      return;
    }
    setOperation({
      kind: action,
      sourcePath: entry.path,
      targetPath: action === "rename" ? entry.path : duplicateSuggestion(entry),
      entryKind: entry.kind,
    });
  };

  const tree = (
    <TreePane
      entries={workspace.entries}
      error={workspace.treeError}
      expandedDirs={workspace.expandedDirs}
      loading={workspace.treeLoading}
      onAction={handleAction}
      onCreateRoot={(kind) => requestCreate(kind)}
      onOpen={(path) => {
        if (path === workspace.activePath) setShowingFiles(false);
        void workspace.openPath(path);
      }}
      narrow={isNarrow}
      onReturnToDocument={workspace.activePath === null ? undefined : () => setShowingFiles(false)}
      onResizeSidebar={isNarrow ? undefined : (delta) => resizeSidebar(effectiveSidebarWidth + delta)}
      onRefresh={() => void workspace.refreshTree()}
      onUpload={(directory, files) => void uploadFiles(directory, files)}
      onChooseUpload={chooseUpload}
      onToggleDirectory={workspace.toggleDirectory}
      query={workspace.query}
      reveal={workspace.reveal}
      rootName={workspace.rootName}
      searchStatus={workspace.searchStatus}
      selectedPath={workspace.activePath}
      setQuery={workspace.setQuery}
      showAnnotate={workspace.annotateAvailable}
      showOpenPreferred={showOpenPreferred}
      showSql={workspace.sqlAvailable}
      truncated={workspace.truncated}
      uploadStatus={uploadStatus}
    />
  );
  const editor = (
    <EditorPane
      tabs={workspace.tabs}
      activePath={workspace.activePath}
      narrow={isNarrow}
      onTabSelect={workspace.setActivePath}
      onTabClose={async (path) => {
        if (!(await workspace.closeFile(path))) workspace.setActivePath(path);
      }}
      onChange={workspace.setDraftText}
      onOverwrite={(path) => void workspace.overwrite(path)}
      onReload={(path) => void workspace.reloadFile(path)}
      onSave={(path) => void workspace.save(path)}
      onDownload={(path) => void workspace.downloadPath(path)}
      onOpenInAnnotate={openInPreferred}
      showAnnotate={workspace.annotateAvailable}
      showOpenPreferred={showOpenPreferred}
      onOpenInSql={openInPreferred}
      showSql={workspace.sqlAvailable}
      onOpenPreferred={openInPreferred}
      onShowFiles={() => setShowingFiles(true)}
      onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
      isSidebarOpen={isSidebarOpen}
      getDownloadUrl={workspace.getDownloadUrl}
    />
  );

  return (
    <div
      ref={containerRef}
      className="bb-files-panel relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground"
      data-narrow={isNarrow}
    >
      <div
        className="h-full min-h-0 min-w-0 flex-1"
        style={{ display: filesVisible ? "none" : undefined, minWidth: isNarrow ? undefined : minEditorWidth }}
      >
        {editor}
      </div>
      {!isNarrow && isSidebarOpen && (
        <div
          className="group relative z-10 -mx-[5px] w-[11px] shrink-0 cursor-col-resize touch-none bg-transparent outline-none focus-visible:ring-1 focus-visible:ring-ring"
          role="separator"
          aria-label="Resize file tree"
          aria-orientation="vertical"
          aria-valuemin={minSidebarWidth}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={effectiveSidebarWidth}
          tabIndex={0}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const width = event.key === "Home"
              ? minSidebarWidth
              : event.key === "End"
                ? maxSidebarWidth
                : effectiveSidebarWidth + (event.key === "ArrowLeft" ? 40 : -40);
            resizeSidebar(width);
          }}
          onPointerDown={startResizing}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onLostPointerCapture={onPointerUp}
        >
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-seam transition-colors group-hover:bg-state-hover" />
        </div>
      )}
      <div
        className={isNarrow ? "h-full min-h-0 min-w-0 flex-1" : "h-full min-h-0 shrink-0"}
        style={{
          display: (isNarrow ? !filesVisible : !isSidebarOpen) ? "none" : undefined,
          width: isNarrow ? undefined : effectiveSidebarWidth,
        }}
      >
        {tree}
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose files to upload"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void uploadFiles(uploadDirectoryRef.current, files);
        }}
      />

      <OperationDialog
        request={operation}
        onClose={() => setOperation(null)}
        onSubmit={(request) => {
          switch (request.kind) {
            case "create-file":
              return workspace.createFile(request.targetPath);
            case "create-directory":
              return workspace.createDirectory(request.targetPath);
            case "rename":
              return workspace.movePath(
                request.sourcePath ?? "",
                request.targetPath,
              );
            case "duplicate":
              return workspace.duplicatePath(
                request.entryKind,
                request.sourcePath ?? "",
                request.targetPath,
              );
          }
        }}
      />

      <AlertDialog
        open={deleteEntry !== null}
        onOpenChange={(open) => !open && setDeleteEntry(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteEntry?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteEntry?.kind === "directory"
                ? "The folder and all of its contents will be removed."
                : "The file will be removed."}{" "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="text-sm text-destructive-text" role="alert">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                if (deleteEntry === null) return;
                event.preventDefault();
                void workspace
                  .removePath(
                    deleteEntry.path,
                    deleteEntry.kind === "directory",
                  )
                  .then((result) => {
                    if (result.ok) setDeleteEntry(null);
                    else setDeleteError(result.error);
                  });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
