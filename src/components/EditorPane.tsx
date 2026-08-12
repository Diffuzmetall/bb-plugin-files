import { useEffect, useState } from "react";
import { Markdown } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { CodeEditor } from "./CodeEditor";
import type { SaveState, TabState } from "../hooks/useFilesWorkspace";

function isMarkdown(path: string): boolean {
  return /\.(?:md|mdx|markdown)$/iu.test(path);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function FileBreadcrumb({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <nav
          aria-label="File path"
          className="flex min-w-0 flex-1 items-center overflow-x-auto text-xs text-muted-foreground no-scrollbar"
          title={path}
        >
          {segments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="flex shrink-0 items-center">
              {index > 0 ? (
                <Icon
                  name="ChevronRight"
                  className="mx-0.5 h-3 w-3 shrink-0 opacity-50"
                  aria-hidden
                />
              ) : null}
              <span
                className={
                  index === segments.length - 1
                    ? "font-medium text-foreground"
                    : undefined
                }
              >
                {segment}
              </span>
            </span>
          ))}
        </nav>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem
          onSelect={() =>
            void navigator.clipboard.writeText(path).catch(() => undefined)
          }
        >
          <Icon name="Copy" /> Copy relative path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SaveLabel({ state, dirty }: { state: SaveState; dirty: boolean }) {
  const label =
    state.kind === "saving"
      ? "Saving…"
      : state.kind === "conflict"
        ? "Conflict"
        : state.kind === "error"
          ? "Save failed"
          : dirty
            ? "Unsaved"
            : "Saved";
  return (
    <span
      className={
        state.kind === "conflict" || state.kind === "error"
          ? "text-xs text-destructive-text"
          : "text-xs text-muted-foreground"
      }
      role="status"
      aria-live="polite"
    >
      {label}
    </span>
  );
}

export function getFileIconForEditor(name: string) {
  const lower = name.toLowerCase();
  if (/\.(ts|tsx|js|jsx|json|css|scss|html|xml|yaml|yml|sh|bash)$/.test(lower)) return "Code";
  if (/\.(md|txt|csv|log)$/.test(lower)) return "FileText";
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|icns)$/.test(lower)) return "FileAttachment";
  return "File";
}

export function EditorPane({
  tabs,
  activePath,
  narrow,
  onTabSelect,
  onTabClose,
  onChange,
  onOverwrite,
  onReload,
  onSave,
  onDownload,
  onToggleSidebar,
  isSidebarOpen,
  getDownloadUrl,
}: {
  tabs: TabState[];
  activePath: string | null;
  narrow: boolean;
  onTabSelect(path: string): void;
  onTabClose(path: string): void;
  onChange(path: string, value: string): void;
  onOverwrite(path: string): void;
  onReload(path: string): void;
  onSave(path: string): void;
  onDownload(path: string): void;
  onToggleSidebar?(): void;
  isSidebarOpen?: boolean;
  getDownloadUrl(path: string): Promise<string>;
}) {
  const [mode, setMode] = useState<"preview" | "raw">("raw");
  const [copied, setCopied] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  const activeTab = tabs.find(t => t.path === activePath);
  const file = activeTab?.file || null;
  const draftText = activeTab?.draftText || "";
  const saveState = activeTab?.saveState || { kind: "saved" };
  const fileLoading = activeTab?.loading || false;
  const isDirty = file?.state === "text" && draftText !== activeTab?.savedText;

  const markdown = file !== null && isMarkdown(file.path);
  const isHtml = file !== null && /\.(html|htm)$/i.test(file.path);
  const isImage = file !== null && file.state === "unsupported" && Boolean(file.mimeType?.startsWith("image/"));
  const previewSrc = previewUrl && file ? `${previewUrl}${previewUrl.includes("?") ? "&" : "?"}t=${encodeURIComponent(file.sha256)}` : null;

  useEffect(() => setMode(markdown || isHtml ? "preview" : "raw"), [file?.path, markdown, isHtml]);

  useEffect(() => {
    let cancelled = false;
    if ((isImage || isHtml) && file) {
      getDownloadUrl(file.path).then((url) => {
        if (!cancelled) setPreviewUrl(url);
      }).catch(() => {
        if (!cancelled) setPreviewUrl(null);
      });
    } else {
      setPreviewUrl(null);
    }
    return () => void (cancelled = true);
  }, [file?.path, file?.sha256, isImage, isHtml, getDownloadUrl]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {/* TAB BAR */}
      <div className="flex h-9 shrink-0 items-end bg-background/50 pr-2 pl-0 relative overflow-x-auto no-scrollbar">
        <div className="flex h-full flex-nowrap shrink-0">
          {tabs.map(tab => {
            const isActive = tab.path === activePath;
            const tabIsDirty = tab.file?.state === "text" && tab.draftText !== tab.savedText;
            const name = tab.path.split("/").pop() || "";
            return (
              <div 
                key={tab.path}
                onClick={() => onTabSelect(tab.path)}
                className={`group relative flex h-[35px] max-w-[200px] shrink-0 cursor-pointer items-center gap-2 px-3 text-[13px] transition-colors ${
                  isActive ? "bg-background text-foreground" : "bg-muted/20 text-muted-foreground hover:bg-muted/40"
                }`}
              >
                <Icon name={getFileIconForEditor(name) as any} className="h-3.5 w-3.5 opacity-80" />
                <span className="min-w-0 flex-1 truncate select-none">
                  {name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.path);
                  }}
                  className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Close file"
                >
                  {tabIsDirty ? (
                    <div className="h-2 w-2 rounded-full bg-foreground opacity-100" />
                  ) : (
                    <Icon name="X" className="h-[14px] w-[14px]" />
                  )}
                </button>
                {/* Always show dirty dot when not hovered */}
                {tabIsDirty && (
                  <div className="absolute right-3.5 h-2 w-2 rounded-full bg-foreground opacity-100 group-hover:opacity-0 transition-opacity pointer-events-none" />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex-1" />

        <div className="flex h-full items-center gap-1 pb-1 shrink-0">
          {file !== null ? (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                aria-label="Download file"
                onClick={() => onDownload(activePath!)}
              >
                <Icon name="Download" className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                aria-label={copied ? "Copied" : "Copy file content"}
                disabled={file.state !== "text"}
                onClick={async () => {
                  if (file.state !== "text") return;
                  try {
                    await navigator.clipboard.writeText(draftText);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
              >
                <Icon name={copied ? "Check" : "Copy"} className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                aria-label="Reload file"
                onClick={() => onReload(activePath!)}
              >
                <Icon name="RotateCcw" className="h-4 w-4" />
              </Button>
            </>
          ) : null}

          {!isSidebarOpen && onToggleSidebar ? (
            <>
              {file !== null ? <div className="w-[1px] h-4 bg-border-seam mx-1" /> : null}
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label="Show sidebar"
                onClick={onToggleSidebar}
              >
                <Icon name="PanelRight" className="h-4 w-4" />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* FILE PATH / PREVIEW ACTIONS */}
      {file !== null ? (
        <div className="flex h-9 shrink-0 items-center gap-2 bg-background px-3">
          <FileBreadcrumb path={file.path} />
          {isHtml && file.state === "text" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
              disabled={!previewSrc}
              onClick={() => {
                if (!previewSrc) return;
                window.open(previewSrc, "_blank", "noopener,noreferrer");
              }}
            >
              <Icon name="ExternalLink" className="mr-1.5 h-3.5 w-3.5" />
              Open preview
            </Button>
          ) : null}
          {(markdown || isHtml) && file.state === "text" ? (
            <div
              className="flex shrink-0 rounded-md border border-input p-0.5"
              role="group"
              aria-label="View mode"
            >
              <Button
                size="sm"
                variant={mode === "preview" ? "secondary" : "ghost"}
                className="h-6 px-3 text-xs"
                aria-pressed={mode === "preview"}
                onClick={() => setMode("preview")}
              >
                Preview
              </Button>
              <Button
                size="sm"
                variant={mode === "raw" ? "secondary" : "ghost"}
                className="h-6 px-3 text-xs"
                aria-pressed={mode === "raw"}
                onClick={() => setMode("raw")}
              >
                Raw
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* MAIN CONTENT AREA */}
      {fileLoading && file === null ? (
        <div className="grid h-full place-items-center text-sm text-muted-foreground" role="status">
          Loading file…
        </div>
      ) : file === null ? (
        <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground bg-background">
          <div className="opacity-50 select-none">
            <Icon name="Code" className="mx-auto mb-4 h-16 w-16 stroke-[1px]" aria-hidden />
            <p className="font-medium text-base tracking-tight">BB Files Editor</p>
            <p className="mt-1 text-xs">Select a file from the explorer to begin.</p>
          </div>
        </div>
      ) : (
        <>
          {saveState.kind === "conflict" ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text" role="alert">
              The file changed outside this editor. Your draft is preserved.
              <Button size="sm" variant="outline" className="ml-auto h-6 text-xs" onClick={() => onReload(activePath!)}>
                Reload
              </Button>
              <Button size="sm" variant="destructive" className="h-6 text-xs" onClick={() => onOverwrite(activePath!)}>
                Overwrite
              </Button>
            </div>
          ) : saveState.kind === "error" ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text" role="alert">
              {saveState.message}
              <Button size="sm" variant="outline" className="ml-auto h-6 text-xs" onClick={() => onSave(activePath!)}>
                Retry
              </Button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden relative">
            {isImage ? (
              <div className="grid h-full place-items-center bg-[var(--canvas)] p-6 checkerboard-bg">
                {previewUrl ? (
                  <img 
                    src={previewUrl} 
                    alt={file.path} 
                    className="max-h-full max-w-full object-contain drop-shadow-md"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Loading image preview…</p>
                )}
              </div>
            ) : file.state === "unsupported" ? (
              <div className="grid h-full place-items-center p-6 text-center bg-background">
                <div className="max-w-sm">
                  <Icon name="FileQuestion" className="mx-auto mb-3 h-10 w-10 text-muted-foreground opacity-50" aria-hidden />
                  <p className="text-sm font-medium text-foreground">
                    {file.reason === "binary" ? "Binary file" : "File is too large"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatBytes(file.sizeBytes)} · This file is available as metadata only and cannot be edited here.
                  </p>
                </div>
              </div>
            ) : (markdown || isHtml) && mode === "preview" ? (
              <div className="h-full overflow-y-auto bg-background">
                {markdown ? (
                  <div className="p-6">
                    <Markdown content={draftText} />
                  </div>
                ) : (
                  <iframe 
                    src={previewSrc ?? "about:blank"} 
                    className="w-full h-full border-0 bg-white"
                    title="HTML Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  />
                )}
              </div>
            ) : (
              <CodeEditor
                filePath={file.path}
                value={draftText}
                onChange={(val) => onChange(activePath!, val)}
                onSave={() => onSave(activePath!)}
              />
            )}
          </div>
          <div className="flex h-6 shrink-0 items-center justify-between bg-background px-3 text-[11px] text-muted-foreground select-none">
            <div className="flex items-center gap-3">
              {file.state === "text" ? (
                <span className="flex items-center gap-1.5">
                  <div className={`h-1.5 w-1.5 rounded-full ${isDirty ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                  {isDirty ? 'Unsaved' : 'Saved'}
                </span>
              ) : null}
              <span>{file.state === "text" ? "UTF-8" : file.reason === "binary" ? "Binary" : "Unsupported"}</span>
            </div>
            <span>{formatBytes(file.sizeBytes)}</span>
          </div>
        </>
      )}
    </section>
  );
}
