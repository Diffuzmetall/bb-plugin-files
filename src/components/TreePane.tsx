import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  FileContextMenu,
  type FileAction,
} from "./FileContextMenu";
import type { FileTreeEntry } from "../hooks/useFilesWorkspace";
import {
  filterVisibleEntries,
  orderTreeEntries,
  parentPath,
  searchSortEntries,
} from "../tree-order";

import { type IconName } from "@/components/ui/icon";

function depth(path: string): number {
  return path.split("/").length - 1;
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.files.length > 0 ||
    Array.from(dataTransfer.types).includes("Files")
  );
}

function getFileIcon(name: string): IconName {
  const lower = name.toLowerCase();
  if (/\.(ts|tsx|js|jsx|json|css|scss|html|xml|yaml|yml|sh|bash)$/.test(lower)) return "Code";
  if (/\.(md|txt|csv|log)$/.test(lower)) return "FileText";
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|icns)$/.test(lower)) return "FileAttachment";
  return "File";
}

function useLongPressContextMenu() {
  const timerRef = useRef<number | null>(null);
  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") return;
    const element = event.currentTarget;
    const { clientX, clientY } = event;
    clear();
    timerRef.current = window.setTimeout(() => {
      element.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX,
          clientY,
        }),
      );
    }, 550);
  };
  useEffect(() => clear, []);
  return { onPointerDown, onPointerUp: clear, onPointerCancel: clear };
}

function TreeRow({
  entry,
  expanded,
  selected,
  onAction,
  onOpen,
  onToggle,
  onUpload,
  showAnnotate,
}: {
  entry: FileTreeEntry;
  expanded: boolean;
  selected: boolean;
  onAction(action: FileAction, entry: FileTreeEntry): void;
  onOpen(path: string): void;
  onToggle(path: string): void;
  onUpload(directory: string, files: File[]): void;
  showAnnotate: boolean;
}) {
  const longPress = useLongPressContextMenu();
  const [dropActive, setDropActive] = useState(false);
  const open = () =>
    entry.kind === "directory" ? onToggle(entry.path) : onOpen(entry.path);
  return (
    <FileContextMenu
      entry={entry}
      onAction={onAction}
      showAnnotate={showAnnotate}
    >
      <div
        role="treeitem"
        aria-expanded={entry.kind === "directory" ? expanded : undefined}
        aria-selected={selected}
        className={`group flex h-[22px] shrink-0 cursor-default items-center gap-[6px] pr-2 text-[13px] text-muted-foreground outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring aria-selected:bg-state-active aria-selected:text-foreground transition-colors ${dropActive ? "bg-state-active ring-1 ring-inset ring-primary" : ""}`}
        style={{ paddingLeft: `${8 + depth(entry.path) * 12}px` }}
        tabIndex={0}
        onClick={open}
        onDragOver={(event) => {
          if (entry.kind !== "directory" || !hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDropActive(false);
          }
        }}
        onDrop={(event) => {
          if (entry.kind !== "directory" || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          setDropActive(false);
          if (!expanded) onToggle(entry.path);
          onUpload(entry.path, Array.from(event.dataTransfer.files));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          } else if (
            entry.kind === "directory" &&
            event.key === "ArrowRight" &&
            !expanded
          ) {
            event.preventDefault();
            onToggle(entry.path);
          } else if (
            entry.kind === "directory" &&
            event.key === "ArrowLeft" &&
            expanded
          ) {
            event.preventDefault();
            onToggle(entry.path);
          }
        }}
        {...longPress}
      >
        <span className="grid h-5 w-4 shrink-0 place-items-center opacity-70">
          {entry.kind === "directory" ? (
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="h-3.5 w-3.5" />
          ) : null}
        </span>
        <Icon
          name={
            entry.kind === "directory"
              ? expanded
                ? "FolderOpen"
                : "Folder"
              : getFileIcon(entry.name)
          }
          className="h-3.5 w-3.5 shrink-0 opacity-80 aria-selected:opacity-100 aria-selected:text-primary"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        <button
          type="button"
          className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded opacity-0 hover:bg-state-hover focus:opacity-100 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-all"
          aria-label={`More actions for ${entry.name}`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.parentElement?.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                clientX: rect.left,
                clientY: rect.bottom,
              }),
            );
          }}
        >
          <Icon name="MoreHorizontal" />
        </button>
      </div>
    </FileContextMenu>
  );
}

export function TreePane({
  entries,
  error,
  loading,
  onAction,
  onCreateRoot,
  onOpen,
  onRefresh,
  onUpload,
  onChooseUpload,
  query,
  rootName,
  selectedPath,
  setQuery,
  showAnnotate,
  truncated,
  uploadStatus,
}: {
  entries: FileTreeEntry[];
  error: string | null;
  loading: boolean;
  onAction(action: FileAction, entry: FileTreeEntry): void;
  onCreateRoot(kind: "file" | "directory"): void;
  onOpen(path: string): void;
  onRefresh(): void;
  onUpload(directory: string, files: File[]): void;
  onChooseUpload(directory: string): void;
  query: string;
  rootName: string;
  selectedPath: string | null;
  setQuery(value: string): void;
  showAnnotate: boolean;
  truncated: boolean;
  uploadStatus: { kind: "uploading" | "success" | "error"; message: string } | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rootDropActive, setRootDropActive] = useState(false);

  // Reveal a newly selected file by expanding every folder above it, so a
  // file created or opened inside a collapsed folder appears in the tree
  // instead of only in the editor.
  useEffect(() => {
    if (selectedPath === null) return;
    const ancestors: string[] = [];
    let parent = parentPath(selectedPath);
    while (parent.length > 0) {
      ancestors.push(parent);
      parent = parentPath(parent);
    }
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      let next = current;
      for (const ancestor of ancestors) {
        if (!next.has(ancestor)) {
          if (next === current) next = new Set(current);
          next.add(ancestor);
        }
      }
      return next;
    });
  }, [selectedPath]);

  const visibleEntries = useMemo(() => {
    if (query.length > 0) return searchSortEntries(entries);
    return filterVisibleEntries(orderTreeEntries(entries), expanded);
  }, [entries, expanded, query]);

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-[34px] shrink-0 items-center gap-0.5 border-b border-border-seam px-1.5">
        <Icon name="FolderOpen" className="h-3.5 w-3.5" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {rootName}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-[26px] w-[26px]"
          aria-label="Refresh files"
          onClick={onRefresh}
        >
          <Icon name="RotateCcw" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-[26px] w-[26px]"
          aria-label="Upload files"
          onClick={() => onChooseUpload("")}
        >
          <Icon name="ArrowUp" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-[26px] w-[26px]"
          aria-label="New file"
          onClick={() => onCreateRoot("file")}
        >
          <Icon name="File" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-[26px] w-[26px]"
          aria-label="New folder"
          onClick={() => onCreateRoot("directory")}
        >
          <Icon name="FolderPlus" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="group relative mx-1 my-1 shrink-0 rounded-sm transition-colors hover:bg-state-hover focus-within:bg-state-hover">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          aria-label="Search project files"
          className="h-7 rounded-none border-0 bg-transparent py-0 pl-7 pr-2 text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          placeholder="Search files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div
        className={`min-h-0 flex-1 overflow-y-auto px-1 pb-2 ${rootDropActive ? "bg-state-hover ring-1 ring-inset ring-primary" : ""}`}
        role="tree"
        aria-label="Project files"
        aria-busy={loading || uploadStatus?.kind === "uploading"}
        onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setRootDropActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setRootDropActive(false);
          }
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          setRootDropActive(false);
          onUpload("", Array.from(event.dataTransfer.files));
        }}
      >
        {error ? (
          <div className="m-2 rounded-md border border-surface-destructive-border bg-surface-destructive p-3 text-sm text-destructive-text">
            <p>{error}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={onRefresh}>
              Retry
            </Button>
          </div>
        ) : loading && entries.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground" role="status">
            Loading files…
          </p>
        ) : visibleEntries.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {query ? "No matching files." : "This workspace is empty."}
          </p>
        ) : (
          visibleEntries.map((entry) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              expanded={expanded.has(entry.path)}
              selected={selectedPath === entry.path}
              onAction={onAction}
              onOpen={onOpen}
              onUpload={onUpload}
              showAnnotate={showAnnotate}
              onToggle={(path) =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
            />
          ))
        )}
      </div>
      {uploadStatus ? (
        <div
          className={`shrink-0 border-t border-border-seam px-3 py-2 text-xs ${uploadStatus.kind === "error" ? "text-destructive-text" : "text-muted-foreground"}`}
          role={uploadStatus.kind === "error" ? "alert" : "status"}
        >
          {uploadStatus.message}
        </div>
      ) : null}
      <div className="shrink-0 border-t border-border-seam px-3 py-2 text-xs text-muted-foreground">
        {entries.length} items
        {truncated ? " · results truncated" : " · hidden files excluded"}
      </div>
    </aside>
  );
}
