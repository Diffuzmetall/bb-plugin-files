import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** Scale is relative to the fitted image; 1:1 uses the original pixel dimensions. */
export function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const fit = natural.width && size.width
    ? Math.min(1, Math.max(1, size.width - 32) / natural.width, Math.max(1, size.height - 32) / natural.height)
    : 1;
  const scale = fit * view.zoom;
  const ready = natural.width > 0 && !failed;

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function reset() {
    setView({ zoom: 1, x: 0, y: 0 });
    pointers.current.clear();
  }

  function zoomBy(factor: number, x = 0, y = 0) {
    setView(previous => {
      const zoom = Math.min(Math.max(8, 1 / fit), Math.max(0.1, previous.zoom * factor));
      const ratio = zoom / previous.zoom;
      return { zoom, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio };
    });
  }

  useEffect(() => {
    const node = viewport.current;
    if (!node || !ready) return;
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const bounds = node!.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      zoomBy(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.005),
        event.clientX - bounds.left - bounds.width / 2,
        event.clientY - bounds.top - bounds.height / 2);
    }
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [ready, fit]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--canvas)]">
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-b p-1" role="group" aria-label="Image zoom controls">
        <Button variant="ghost" size="sm" aria-label="Zoom out" disabled={!ready || view.zoom <= 0.1} onClick={() => zoomBy(1 / 1.25)}>−</Button>
        <output className="min-w-14 text-center text-xs" aria-label="Image scale">{Math.round(scale * 100)}%</output>
        <Button variant="ghost" size="sm" aria-label="Zoom in" disabled={!ready || view.zoom >= Math.max(8, 1 / fit)} onClick={() => zoomBy(1.25)}>+</Button>
        <Button variant="ghost" size="sm" disabled={!ready} onClick={reset}>Fit</Button>
        <Button variant="ghost" size="sm" disabled={!ready} onClick={() => setView({ zoom: 1 / fit, x: 0, y: 0 })}>1:1</Button>
      </div>
      <div
        ref={viewport}
        className="checkerboard-bg relative min-h-0 flex-1 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ touchAction: "none", cursor: ready ? "grab" : "default" }}
        tabIndex={0}
        role="region"
        aria-label="Image preview. Scroll or pinch to zoom, drag to pan. Use plus, minus or zero to fit."
        onKeyDown={event => {
          if (event.key === "+" || event.key === "=") zoomBy(1.25);
          else if (event.key === "-") zoomBy(1 / 1.25);
          else if (event.key === "0") reset();
          else return;
          event.preventDefault();
        }}
        onDoubleClick={reset}
        onPointerDown={event => {
          if (!ready || event.button !== 0) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerMove={event => {
          const old = pointers.current.get(event.pointerId);
          if (!old) return;
          const before = [...pointers.current.values()];
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (before.length === 2) {
            const after = [...pointers.current.values()];
            const distance = (points: typeof before) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
            const previousDistance = distance(before);
            const bounds = event.currentTarget.getBoundingClientRect();
            const midpoint = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
            if (previousDistance > 0) zoomBy(distance(after) / previousDistance, midpoint.x - bounds.left - bounds.width / 2, midpoint.y - bounds.top - bounds.height / 2);
            setView(previous => ({ ...previous, x: previous.x + (event.clientX - old.x) / 2, y: previous.y + (event.clientY - old.y) / 2 }));
          } else if (before.length === 1) {
            setView(previous => ({ ...previous, x: previous.x + event.clientX - old.x, y: previous.y + event.clientY - old.y }));
          }
        }}
        onPointerUp={event => pointers.current.delete(event.pointerId)}
        onPointerCancel={event => pointers.current.delete(event.pointerId)}
        onLostPointerCapture={event => pointers.current.delete(event.pointerId)}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="absolute max-w-none select-none drop-shadow-md"
          style={{ left: "50%", top: "50%", width: natural.width || undefined, height: natural.height || undefined, visibility: ready ? "visible" : "hidden", transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${scale})` }}
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
        {!ready && <p role="status" className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{failed ? "Unable to load image preview." : "Loading image preview…"}</p>}
      </div>
    </div>
  );
}
