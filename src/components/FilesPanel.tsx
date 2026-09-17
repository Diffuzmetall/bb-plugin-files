import { useEffect, useState, useRef } from "react";
import {
  useBbContext,
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
import type { filesRpcContract } from "../../server";
import type { FileScope } from "../contracts";

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

type OpenedFileResolution =
  | { state: "pending" }
  | { state: "file"; rootScope: FilesRootScope; path: string }
  | { state: "unsupported" };

/** The server decides the root; the panel only renders it. */
function panelRootScope(scope: FileScope): FilesRootScope {
  if (scope.kind === "thread") return "thread";
  if (scope.rootPath === undefined) return "host";
  return scope.hostId === undefined
    ? { kind: "host", rootPath: scope.rootPath }
    : { kind: "host", hostId: scope.hostId, rootPath: scope.rootPath };
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
  if (isFileOpenerProps(props)) {
    return <OpenedFile source={props.source} path={props.path} />;
  }
  return (
    <FilesPanelContent
      key={JSON.stringify([context.threadId, context.projectId])}
      initialPath={null}
      rootScope="thread"
    />
  );
}

/** A file link from another surface: workspace files open in the thread root,
 * host files re-root the panel at the directory that owns them. */
function OpenedFile({
  source,
  path,
}: Pick<PluginFileOpenerProps, "source" | "path">) {
  const rpc = useRpc<typeof filesRpcContract>();
  // `useRpc` may hand back a fresh client on every render, so the request is
  // keyed by the link itself and issued once per link.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const requestedRef = useRef<string | null>(null);
  // A workspace path is already relative to the thread root, so it opens
  // without a round trip; every other source asks the server where it lives.
  const workspaceFile = source.kind === "workspace" && !path.startsWith("/");
  const [resolved, setResolved] = useState<OpenedFileResolution>(() =>
    workspaceFile
      ? { state: "file", rootScope: "thread", path }
      : { state: "pending" },
  );

  useEffect(() => {
    if (workspaceFile) return;
    const requestKey = JSON.stringify([
      source.kind,
      source.threadId,
      source.experimental_hostId ?? null,
      path,
    ]);
    if (requestedRef.current === requestKey) return;
    requestedRef.current = requestKey;
    // The path itself is not trusted: the server decides which root may read
    // it, and a link it cannot place shows the same notice as a missing source.
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
        setResolved(
          result.kind === "file"
            ? {
                state: "file",
                rootScope: panelRootScope(result.scope),
                path: result.path,
              }
            : { state: "unsupported" },
        );
      })
      .catch(() => setResolved({ state: "unsupported" }));
  }, [
    path,
    source.experimental_hostId,
    source.kind,
    source.threadId,
    workspaceFile,
  ]);

  if (resolved.state === "pending") {
    return (
      <div
        className="grid h-full place-items-center p-6 text-sm text-muted-foreground"
        role="status"
      >
        Opening file…
      </div>
    );
  }
  if (resolved.state === "unsupported") {
    return (
      <div
        className="grid h-full place-items-center p-6 text-sm text-muted-foreground"
        role="alert"
      >
        {FILE_SOURCE_UNAVAILABLE}
      </div>
    );
  }
  const target = resolved;
  return (
    <FilesPanelContent
      key={
        typeof target.rootScope === "string"
          ? target.rootScope
          : `${target.rootScope.hostId ?? ""}\u0000${target.rootScope.rootPath}\u0000${target.path}`
      }
      initialPath={target.path}
      rootScope={target.rootScope}
    />
  );
}

function FilesPanelContent({
  initialPath,
  rootScope,
}: {
  initialPath: string | null;
  rootScope: FilesRootScope;
}) {
  const workspace = useFilesWorkspace(initialPath, rootScope);
  // Opening a file in BB's own preview needs a thread tab, so the global root
  // keeps that action out of its menus.
  const showOpenPreferred = rootScope === "thread";
  const { containerRef, containerNode, isNarrow } = useResponsiveLayout();
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

  const startResizing = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    isResizing.current = true;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isResizing.current) return;
    const containerRect = containerNode?.getBoundingClientRect();
    if (containerRect) {
      // Since tree is on the right, width is right edge minus mouse X
      let newWidth = containerRect.right - e.clientX;
      if (newWidth < 100) {
        setIsSidebarOpen(false);
        isResizing.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        return;
      }
      if (newWidth > containerRect.width - 200)
        newWidth = containerRect.width - 200;
      setSidebarWidth(newWidth);
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
      onOpen={(path) => void workspace.openPath(path)}
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
      onTabClose={(path) => void workspace.closeFile(path)}
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
      onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
      isSidebarOpen={isSidebarOpen}
      getDownloadUrl={workspace.getDownloadUrl}
    />
  );

  return (
    <div
      ref={containerRef}
      className="bb-files-panel relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground"
    >
      {isNarrow ? (
        workspace.activePath === null ? (
          tree
        ) : (
          editor
        )
      ) : (
        <>
          <div className="h-full min-w-0 flex-1">{editor}</div>
          {isSidebarOpen && (
            <>
              <div
                className="group relative z-10 -mx-[5px] w-[11px] shrink-0 cursor-col-resize touch-none bg-transparent"
                onPointerDown={startResizing}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-seam transition-colors group-hover:bg-state-hover" />
              </div>
              <div
                className="h-full shrink-0"
                style={{ width: `${sidebarWidth}px`, minWidth: "150px" }}
              >
                {tree}
              </div>
            </>
          )}
        </>
      )}

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
