import { useEffect, useState } from "react";
import { Markdown } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { CodeEditor } from "./CodeEditor";
import type { OpenFile, SaveState } from "../hooks/useFilesWorkspace";

function isMarkdown(path: string): boolean {
  return /\.(?:md|mdx|markdown)$/iu.test(path);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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

export function EditorPane({
  draftText,
  file,
  fileLoading,
  isDirty,
  narrow,
  onBack,
  onChange,
  onOverwrite,
  onReload,
  onSave,
  saveState,
}: {
  draftText: string;
  file: OpenFile | null;
  fileLoading: boolean;
  isDirty: boolean;
  narrow: boolean;
  onBack(): void;
  onChange(value: string): void;
  onOverwrite(): void;
  onReload(): void;
  onSave(): void;
  saveState: SaveState;
}) {
  const [mode, setMode] = useState<"preview" | "raw">("raw");
  const [copied, setCopied] = useState(false);
  const markdown = file !== null && isMarkdown(file.path);

  useEffect(() => setMode(markdown ? "preview" : "raw"), [file?.path, markdown]);

  if (fileLoading && file === null) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground" role="status">
        Loading file…
      </div>
    );
  }
  if (file === null) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
        <div>
          <Icon name="File" className="mx-auto mb-3 h-8 w-8" aria-hidden />
          Select a file from the project tree.
        </div>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-seam px-2">
        {narrow ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label="Back to files"
            onClick={onBack}
          >
            <Icon name="ChevronLeft" />
          </Button>
        ) : null}
        <Icon name="File" className="h-4 w-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {file.path}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
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
          <Icon name={copied ? "Check" : "Copy"} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label="Reload file"
          onClick={onReload}
        >
          <Icon name="RotateCcw" />
        </Button>
        {file.state === "text" ? (
          <>
            <SaveLabel state={saveState} dirty={isDirty} />
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={!isDirty || saveState.kind === "saving" || saveState.kind === "conflict"}
              onClick={onSave}
            >
              Save
            </Button>
          </>
        ) : null}
      </div>

      {markdown && file.state === "text" ? (
        <div className="flex h-10 shrink-0 items-center justify-end border-b border-border-seam px-2">
          <div className="flex rounded-md border border-input p-0.5" role="group" aria-label="Markdown view">
            <Button
              size="sm"
              variant={mode === "preview" ? "secondary" : "ghost"}
              className="h-7 px-3"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              Preview
            </Button>
            <Button
              size="sm"
              variant={mode === "raw" ? "secondary" : "ghost"}
              className="h-7 px-3"
              aria-pressed={mode === "raw"}
              onClick={() => setMode("raw")}
            >
              Raw
            </Button>
          </div>
        </div>
      ) : null}

      {saveState.kind === "conflict" ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text" role="alert">
          The file changed outside this editor. Your draft is preserved.
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onReload}>
            Reload
          </Button>
          <Button size="sm" variant="destructive" className="h-7" onClick={onOverwrite}>
            Overwrite
          </Button>
        </div>
      ) : saveState.kind === "error" ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text" role="alert">
          {saveState.message}
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onSave}>
            Retry
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {file.state === "unsupported" ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div className="max-w-sm">
              <Icon name="FileQuestion" className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">
                {file.reason === "binary" ? "Binary file" : "File is too large"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatBytes(file.sizeBytes)} · This file is available as metadata only and cannot be edited here.
              </p>
            </div>
          </div>
        ) : markdown && mode === "preview" ? (
          <div className="h-full overflow-y-auto p-5">
            <Markdown content={draftText} />
          </div>
        ) : (
          <CodeEditor
            filePath={file.path}
            value={draftText}
            onChange={onChange}
            onSave={onSave}
          />
        )}
      </div>
      <div className="flex h-7 shrink-0 items-center justify-between border-t border-border-seam px-3 text-xs text-muted-foreground">
        <span>{file.state === "text" ? "UTF-8" : file.reason === "binary" ? "Binary" : "Unsupported"}</span>
        <span>{formatBytes(file.sizeBytes)}</span>
      </div>
    </section>
  );
}
