import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import type { FileTreeEntry } from "../hooks/useFilesWorkspace";

export type FileAction =
  | "create-file"
  | "create-directory"
  | "rename"
  | "duplicate"
  | "delete"
  | "copy-path";

export function FileContextMenu({
  children,
  entry,
  onAction,
}: {
  children: ReactNode;
  entry: FileTreeEntry;
  onAction(action: FileAction, entry: FileTreeEntry): void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {entry.kind === "directory" ? (
          <>
            <ContextMenuItem onSelect={() => onAction("create-file", entry)}>
              <Icon name="File" /> New file
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onAction("create-directory", entry)}
            >
              <Icon name="FolderPlus" /> New folder
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem onSelect={() => onAction("rename", entry)}>
          <Icon name="Edit" /> Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction("duplicate", entry)}>
          <Icon name="Copy" /> Duplicate
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction("copy-path", entry)}>
          <Icon name="Copy" /> Copy relative path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive-text focus:text-destructive-text"
          onSelect={() => onAction("delete", entry)}
        >
          <Icon name="Trash2" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
