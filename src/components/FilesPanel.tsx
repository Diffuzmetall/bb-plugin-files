import { useState, useRef } from "react";
import {
  useBbContext,
  type PluginFileOpenerProps,
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
  useFilesWorkspace,
  type FileTreeEntry,
} from "../hooks/useFilesWorkspace";
import { useResponsiveLayout } from "../hooks/useResponsiveLayout";

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

type FilesPanelProps = PluginThreadPanelProps | PluginFileOpenerProps;

function isFileOpenerProps(
  props: FilesPanelProps,
): props is PluginFileOpenerProps {
  return "source" in props;
}

export function FilesPanel(props: FilesPanelProps) {
  const context = useBbContext();
  const opener = isFileOpenerProps(props);
  // The host context and server-side thread-environment resolution are the
  // authorization boundary. Opener and panel props are persisted input only.
  if (context.threadId === null) {
    return (
      <div
        className="grid h-full place-items-center p-6 text-sm text-muted-foreground"
        role="alert"
      >
        This file source is not available in the active workspace.
      </div>
    );
  }
  const sourceKey = JSON.stringify([context.threadId, context.projectId]);
  return (
    <FilesPanelContent
      key={sourceKey}
      initialPath={opener ? props.path : null}
    />
  );
}

function FilesPanelContent({ initialPath }: { initialPath: string | null }) {
  const workspace = useFilesWorkspace(initialPath);
  const { containerRef, containerNode, isNarrow } = useResponsiveLayout();
  const [operation, setOperation] = useState<OperationRequest | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<FileTreeEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const handleAction = (action: FileAction, entry: FileTreeEntry) => {
    if (
      action === "annotate" ||
      action === "open-sql" ||
      action === "open-preferred"
    ) {
      openInPreferred(entry.path);
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
      onToggleDirectory={workspace.toggleDirectory}
      query={workspace.query}
      rootName={workspace.rootName}
      selectedPath={workspace.activePath}
      setQuery={workspace.setQuery}
      showAnnotate={workspace.annotateAvailable}
      showSql={workspace.sqlAvailable}
      truncated={workspace.truncated}
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
