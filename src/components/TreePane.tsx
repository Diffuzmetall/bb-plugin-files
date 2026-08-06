import {
  useEffect,
  useMemo,
  useRef,
  useState,
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

function depth(path: string): number {
  return path.split("/").length - 1;
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
}: {
  entry: FileTreeEntry;
  expanded: boolean;
  selected: boolean;
  onAction(action: FileAction, entry: FileTreeEntry): void;
  onOpen(path: string): void;
  onToggle(path: string): void;
}) {
  const longPress = useLongPressContextMenu();
  const open = () =>
    entry.kind === "directory" ? onToggle(entry.path) : onOpen(entry.path);
  return (
    <FileContextMenu entry={entry} onAction={onAction}>
      <div
        role="treeitem"
        aria-expanded={entry.kind === "directory" ? expanded : undefined}
        aria-selected={selected}
        className="group flex h-7 shrink-0 cursor-default items-center gap-1 rounded-md pr-1 text-sm outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring aria-selected:bg-state-active"
        style={{ paddingLeft: `${8 + depth(entry.path) * 16}px` }}
        tabIndex={0}
        onClick={open}
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
        <span className="grid h-5 w-4 shrink-0 place-items-center text-muted-foreground">
          {entry.kind === "directory" ? (
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} />
          ) : null}
        </span>
        <Icon
          name={
            entry.kind === "directory"
              ? expanded
                ? "FolderOpen"
                : "Folder"
              : "File"
          }
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        <button
          type="button"
          className="grid h-6 w-6 shrink-0 place-items-center rounded opacity-0 hover:bg-state-hover focus:opacity-100 group-hover:opacity-100"
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
  query,
  rootName,
  selectedPath,
  setQuery,
  truncated,
}: {
  entries: FileTreeEntry[];
  error: string | null;
  loading: boolean;
  onAction(action: FileAction, entry: FileTreeEntry): void;
  onCreateRoot(kind: "file" | "directory"): void;
  onOpen(path: string): void;
  onRefresh(): void;
  query: string;
  rootName: string;
  selectedPath: string | null;
  setQuery(value: string): void;
  truncated: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-seam px-2">
        <Icon name="FolderOpen" className="h-4 w-4" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {rootName}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label="Refresh files"
          onClick={onRefresh}
        >
          <Icon name="RotateCcw" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label="New file"
          onClick={() => onCreateRoot("file")}
        >
          <Icon name="File" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label="New folder"
          onClick={() => onCreateRoot("directory")}
        >
          <Icon name="FolderPlus" />
        </Button>
      </div>
      <div className="relative shrink-0 p-2">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          aria-label="Search project files"
          className="h-8 pl-8 text-sm"
          placeholder="Search files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
        role="tree"
        aria-label="Project files"
        aria-busy={loading}
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
      <div
        className="shrink-0 border-t border-border-seam px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        {entries.length} items
        {truncated ? " · results truncated" : " · hidden files excluded"}
      </div>
    </aside>
  );
}
