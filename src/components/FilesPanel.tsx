import { useState } from "react";
import type { PluginThreadPanelProps } from "@bb/plugin-sdk/app";
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
  if (entry.kind === "directory") return childPath(parent, `${entry.name} copy`);
  const dot = entry.name.lastIndexOf(".");
  const name =
    dot > 0
      ? `${entry.name.slice(0, dot)} copy${entry.name.slice(dot)}`
      : `${entry.name} copy`;
  return childPath(parent, name);
}

export function FilesPanel({ threadId }: PluginThreadPanelProps) {
  const workspace = useFilesWorkspace(threadId);
  const { containerRef, isNarrow } = useResponsiveLayout();
  const [operation, setOperation] = useState<OperationRequest | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<FileTreeEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requestCreate = (kind: "file" | "directory", parent = "") => {
    setOperation({
      kind: kind === "file" ? "create-file" : "create-directory",
      sourcePath: null,
      targetPath: childPath(parent, kind === "file" ? "untitled.txt" : "untitled"),
      entryKind: kind,
    });
  };

  const handleAction = (action: FileAction, entry: FileTreeEntry) => {
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
      requestCreate(action === "create-file" ? "file" : "directory", entry.path);
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
      loading={workspace.treeLoading}
      onAction={handleAction}
      onCreateRoot={(kind) => requestCreate(kind)}
      onOpen={(path) => void workspace.openPath(path)}
      onRefresh={() => void workspace.refreshTree()}
      query={workspace.query}
      rootName={workspace.rootName}
      selectedPath={workspace.selectedPath}
      setQuery={workspace.setQuery}
      truncated={workspace.truncated}
    />
  );
  const editor = (
    <EditorPane
      draftText={workspace.draftText}
      file={workspace.openFile}
      fileLoading={workspace.fileLoading}
      isDirty={workspace.isDirty}
      narrow={isNarrow}
      onBack={() => void workspace.closeFile()}
      onChange={workspace.setDraftText}
      onOverwrite={() => void workspace.overwrite()}
      onReload={() => void workspace.reloadFile()}
      onSave={() => void workspace.save()}
      onDownload={() => workspace.selectedPath && void workspace.downloadPath(workspace.selectedPath)}
      getDownloadUrl={workspace.getDownloadUrl}
      saveState={workspace.saveState}
    />
  );

  return (
    <div ref={containerRef} className="bb-files-panel relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground">
      {isNarrow ? (
        workspace.selectedPath === null ? tree : editor
      ) : (
        <>
          <div className="h-full min-w-[220px] max-w-[320px] basis-[38%] border-r border-border-seam">{tree}</div>
          <div className="h-full min-w-0 flex-1">{editor}</div>
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
              return workspace.movePath(request.sourcePath ?? "", request.targetPath);
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
                : "The file will be removed."} This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <p className="text-sm text-destructive-text" role="alert">{deleteError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                if (deleteEntry === null) return;
                event.preventDefault();
                void workspace
                  .removePath(deleteEntry.path, deleteEntry.kind === "directory")
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
