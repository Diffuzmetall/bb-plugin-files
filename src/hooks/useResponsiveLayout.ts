import { useCallback, useEffect, useState } from "react";

const NARROW_PANEL_WIDTH = 680;

export function useResponsiveLayout() {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [isNarrow, setIsNarrow] = useState(false);
  const ref = useCallback((next: HTMLElement | null) => setNode(next), []);

  useEffect(() => {
    if (node === null) return;
    const update = (width: number) => setIsNarrow(width < NARROW_PANEL_WIDTH);
    update(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { containerRef: ref, isNarrow };
}
