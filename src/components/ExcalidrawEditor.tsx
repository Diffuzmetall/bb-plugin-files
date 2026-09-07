import {
  Excalidraw,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useCallback, useEffect, useRef, useState } from "react";
import "../vendor/excalidraw.css";

type CanvasTheme = "light" | "dark";

interface SceneData {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}

function durableAppState(appState: AppState): Partial<AppState> {
  const { scrollX: _scrollX, scrollY: _scrollY, zoom: _zoom, ...durable } =
    appState;
  return durable;
}

function hostTheme(): CanvasTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function allowedExternalLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function ExcalidrawEditor({
  content,
  filePath,
  onChange,
  onSave,
}: {
  content: string;
  filePath: string;
  onChange(value: string): void;
  onSave(): void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const normalizedBaselineRef = useRef<string | null>(null);
  const lastEmittedContentRef = useRef<string | null>(null);
  const hasUserInteractedRef = useRef(false);
  const [scene, setScene] = useState<SceneData | null>(null);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [theme, setTheme] = useState<CanvasTheme>(hostTheme);
  const [api, setApi] = useState<{ refresh: () => void } | null>(null);

  useEffect(() => {
    if (content === lastEmittedContentRef.current) return;
    let cancelled = false;
    setScene(null);
    setLoadError(null);
    if (content.trim() === "") {
      normalizedBaselineRef.current = null;
      lastEmittedContentRef.current = null;
      hasUserInteractedRef.current = false;
      setScene({ elements: [], appState: {}, files: {} });
      setSceneVersion((current) => current + 1);
      return;
    }
    void loadFromBlob(
      new Blob([content], { type: "application/json" }),
      null,
      null,
    )
      .then((restored) => {
        if (cancelled) return;
        normalizedBaselineRef.current = null;
        lastEmittedContentRef.current = null;
        hasUserInteractedRef.current = false;
        setScene({
          elements: restored.elements,
          appState: restored.appState,
          files: restored.files,
        });
        setSceneVersion((current) => current + 1);
      })
      .catch((cause) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof Error ? cause.message : "Could not load Excalidraw file",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [content, filePath]);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(hostTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => api?.refresh());
    });
    observer.observe(mount);
    return () => observer.disconnect();
  }, [api]);

  const handleChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      const serialized = serializeAsJSON(
        elements,
        durableAppState(appState),
        files,
        "database",
      );
      if (
        normalizedBaselineRef.current === null &&
        !hasUserInteractedRef.current
      ) {
        normalizedBaselineRef.current = serialized;
        return;
      }
      if (
        serialized === content ||
        serialized === lastEmittedContentRef.current ||
        serialized === normalizedBaselineRef.current
      ) {
        return;
      }
      lastEmittedContentRef.current = serialized;
      onChange(serialized);
    },
    [content, onChange],
  );

  if (loadError) {
    return (
      <div className="bb-files-excalidraw-state" role="alert">
        {loadError}
      </div>
    );
  }
  if (!scene) {
    return (
      <div className="bb-files-excalidraw-state" role="status">
        Loading drawing…
      </div>
    );
  }

  return (
    <div
      ref={mountRef}
      className="bb-files-excalidraw"
      data-testid="bb-files-excalidraw"
      onPointerDownCapture={() => {
        hasUserInteractedRef.current = true;
      }}
      onKeyDownCapture={(event) => {
        hasUserInteractedRef.current = true;
        if (
          event.key.toLowerCase() === "s" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          onSave();
        }
      }}
    >
      <Excalidraw
        key={`${filePath}:${sceneVersion}`}
        autoFocus
        theme={theme}
        excalidrawAPI={setApi}
        initialData={scene}
        onChange={handleChange}
        handleKeyboardGlobally={false}
        validateEmbeddable={false}
        onLinkOpen={(element, event) => {
          event.preventDefault();
          if (element.link && allowedExternalLink(element.link)) {
            window.open(element.link, "_blank", "noopener,noreferrer");
          }
        }}
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
          },
        }}
      />
    </div>
  );
}
