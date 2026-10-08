import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { TabState } from "../hooks/useFilesWorkspace";

function fileName(path: string) {
  return path.split("/").pop() || path;
}

function folderName(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "Root folder" : path.slice(0, slash) || "/";
}

export function MobileFileNavigation({
  tabs, activeTabId, onTabSelect, onTabClose, onShowFiles, modes, status, actions,
}: {
  tabs: TabState[];
  activeTabId: string | null;
  onTabSelect(id: string): void;
  onTabClose(id: string): void;
  onShowFiles(): void;
  modes: ReactNode;
  status: ReactNode;
  actions: ReactNode;
}) {
  const [sheet, setSheet] = useState<"files" | "actions" | null>(null);
  const [query, setQuery] = useState("");
  const navigation = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activePath = activeTab?.path ?? null;
  const name = fileName(activePath || "");
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const lowerQuery = query.toLowerCase();
  const filteredTabs = tabs.filter((tab) => tab.path.toLowerCase().includes(lowerQuery));

  useEffect(() => {
    const modal = dialog.current;
    const panel = navigation.current?.closest("section");
    if (!modal || !panel || sheet === null) return;
    const position = () => {
      const rect = panel.getBoundingClientRect();
      Object.assign(modal.style, {
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        bottom: `${Math.max(0, window.innerHeight - rect.bottom)}px`,
        maxHeight: `${Math.min(480, rect.height, window.innerHeight - 16)}px`,
      });
    };
    const cancel = (event: Event) => { event.preventDefault(); dismiss(); };
    const closed = () => {
      if (modal.open) return;
      setSheet(null);
      trigger.current?.focus({ preventScroll: true });
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]:not([aria-disabled="true"])');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (document.activeElement !== (event.shiftKey ? first : last)) return;
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    };
    modal.addEventListener("cancel", cancel);
    modal.addEventListener("close", closed);
    modal.addEventListener("keydown", keydown);
    position();
    modal.showModal();
    modal.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer.disconnect();
      modal.removeEventListener("cancel", cancel);
      modal.removeEventListener("close", closed);
      modal.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (modal.open) modal.close();
    };
  }, [sheet]);

  function openSheet(next: "files" | "actions", button: HTMLButtonElement) {
    trigger.current = button;
    setSheet(next);
  }

  function dismiss() {
    dialog.current?.close();
    setSheet(null);
    trigger.current?.focus({ preventScroll: true });
  }

  function closeTab(id: string) {
    // Expose the existing conflict/error UI if saving prevents the close.
    dismiss();
    onTabClose(id);
  }

  return (
    <div ref={navigation} className="bb-files-mobile-navigation">
      <div className="bb-files-mobile-identity">
        <button type="button" className="bb-files-mobile-back" aria-label="Show files" title="Show files" onClick={onShowFiles}>
          <Icon name="FolderOpen" className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" className="bb-files-mobile-picker" aria-label="Open files" aria-haspopup="dialog" title={activePath || "Open files"} onClick={(event) => { setQuery(""); openSheet("files", event.currentTarget); }}>
          <span className="bb-files-mobile-file">
            <span className="bb-files-mobile-name"><span>{extension ? name.slice(0, dot) : name}</span><span>{extension}</span></span>
            <span className="bb-files-mobile-folder">{activePath ? folderName(activePath) : "No file selected"}</span>
          </span>
          <span className="bb-files-mobile-count">{tabs.length}</span>
          <Icon name="ChevronDown" className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div className="bb-files-mobile-tools">
        {modes}
        <div className="bb-files-mobile-status">{status}</div>
        <Button variant="ghost" size="icon" aria-label="File actions" aria-haspopup="dialog" onClick={(event) => openSheet("actions", event.currentTarget)}>
          <Icon name="MoreHorizontal" className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <dialog ref={dialog} className="bb-files-mobile-sheet" aria-labelledby={titleId} onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
      }}>
        <div className="bb-files-mobile-sheet-header">
          <h2 id={titleId}>{sheet === "files" ? "Open files" : "File actions"}</h2>
          <Button variant="ghost" size="icon" aria-label="Close dialog" onClick={dismiss}><Icon name="X" className="h-4 w-4" aria-hidden /></Button>
        </div>
        {sheet === "files" && (
          <>
            <div className="bb-files-mobile-search">
              <Icon name="Search" className="h-4 w-4" aria-hidden />
              <input type="search" aria-label="Search open files" placeholder="Find an open file…" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="bb-files-mobile-open-list">
              {filteredTabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                const dirty = tab.file?.state === "text" && tab.draftText !== tab.savedText;
                return (
                  <div key={tab.id} className="bb-files-mobile-open-row" data-active={isActive}>
                    <button type="button" aria-label={`Switch to ${tab.path}`} aria-current={isActive ? "true" : undefined} onClick={() => { dismiss(); onTabSelect(tab.id); }}>
                      <Icon name="FileText" className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="bb-files-mobile-open-name"><span>{fileName(tab.path)}{dirty ? " •" : ""}</span><span>{folderName(tab.path)}</span></span>
                      {isActive ? <Icon name="Check" className="h-4 w-4 shrink-0" aria-hidden /> : null}
                    </button>
                    <Button variant="ghost" size="icon" aria-label={`Close ${tab.path}`} onClick={() => closeTab(tab.id)}><Icon name="X" className="h-4 w-4" aria-hidden /></Button>
                  </div>
                );
              })}
              {!filteredTabs.length ? <p className="bb-files-mobile-empty">No matching open files.</p> : null}
            </div>
          </>
        )}
        {sheet === "actions" && (
          <div className="bb-files-mobile-menu" onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('button:not(:disabled), a[href]:not([aria-disabled="true"])')) dismiss();
          }}>
            {actions}
            <Button variant="ghost" className="bb-files-mobile-close" aria-label="Close file" disabled={activeTab === null} onClick={() => { if (activeTab !== null) closeTab(activeTab.id); }}><Icon name="X" className="h-4 w-4" aria-hidden /><span>Close this file</span></Button>
          </div>
        )}
      </dialog>
    </div>
  );
}
