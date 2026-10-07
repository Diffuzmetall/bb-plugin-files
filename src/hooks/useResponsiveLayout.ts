import { useCallback, useEffect, useState } from "react";

const NARROW_PANEL_WIDTH = 680;

export function useResponsiveLayout() {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(NARROW_PANEL_WIDTH);
  const ref = useCallback((next: HTMLElement | null) => setNode(next), []);

  useEffect(() => {
    if (node === null) return;
    const update = (width: number) => setContainerWidth(width);
    update(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return {
    containerRef: ref,
    containerNode: node,
    containerWidth,
    isNarrow: containerWidth < NARROW_PANEL_WIDTH,
  };
}
