// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPanel } from "./components/FilesPanel";
import { useFilesWorkspace } from "./hooks/useFilesWorkspace";
import {
  setBbContext,
  setRpcHandlers,
} from "../test/plugin-sdk-app-runtime";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: () => <div data-testid="mock-files-excalidraw">Drawing</div>,
  loadFromBlob: async () => ({ elements: [], appState: {}, files: {} }),
  serializeAsJSON: () =>
    JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
}));

class TestResizeObserver {
  static width = 900;
  static panels = new Set<TestResizeObserver>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    if (target.matches(".bb-files-panel")) TestResizeObserver.panels.add(this);
    this.emit(TestResizeObserver.width);
  }
  emit(width: number) {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this);
  }
  static resize(width: number) {
    TestResizeObserver.width = width;
    for (const observer of TestResizeObserver.panels) observer.emit(width);
  }
  disconnect() {
    TestResizeObserver.panels.delete(this);
  }
  unobserve() {}
}

beforeEach(() => {
  window.localStorage.clear();
  TestResizeObserver.width = 900;
  TestResizeObserver.panels.clear();
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  setBbContext({ projectId: "proj_curr", threadId: "thread-1" });
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Quick notes UI behavior", () => {
  it("nav New note sends strict JSON without an absent directory or local host ID", async () => {
    setBbContext({ projectId: null, threadId: null });
    const createNote = vi.fn((input: unknown) => {
      // Model the real SDK boundary before the creation handler, without changing other stubs.
      expect(input).toStrictEqual(JSON.parse(JSON.stringify(input)));
      return { scope: { kind: "host" as const }, path: "Untitled.md", name: "Untitled.md", absolutePath: "/notes/Untitled.md", sha256: "created" };
    });
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "Home", entries: [], annotateAvailable: false, sqlAvailable: false }),
      createNote,
      readFile: (input: any) => ({ state: "text" as const, path: input.path, sha256: "created", sizeBytes: 0, mimeType: "text/markdown", modifiedAtMs: 1, content: "" }),
    });
    const view = render(<FilesPanel subPath="" />);
    fireEvent.click((await view.findAllByRole("button", { name: "New note" }))[0]);
    await waitFor(() => expect(createNote).toHaveBeenCalledOnce());
    const input = createNote.mock.calls[0][0];
    expect(input).toStrictEqual({ currentScope: { kind: "host" } });
    expect(input).not.toHaveProperty("directory");
    expect(input).not.toHaveProperty("currentScope.hostId");
    await view.findByRole("textbox", { name: "Editing preview of Untitled.md" });
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("toolbar one-tap creates a note and opens it immediately", async () => {
    let noteCreated = false;
    const entries = [
      { kind: "file" as const, path: "README.md", name: "README.md", score: 0, positions: [] },
    ];

    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "my-project",
        entries: noteCreated
          ? [
              ...entries,
              { kind: "file" as const, path: "Untitled.md", name: "Untitled.md", score: 0, positions: [] },
            ]
          : entries,
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "my-project",
        entries: noteCreated
          ? [
              ...entries,
              { kind: "file" as const, path: "Untitled.md", name: "Untitled.md", score: 0, positions: [] },
            ]
          : entries,
        truncated: false,
        status: "ready" as const,
        indexedCount: 1,
        indexingSinceMs: null,
      }),
      createNote: () => {
        noteCreated = true;
        return {
          scope: { kind: "thread" as const, threadId: "thread-1" },
          path: "Untitled.md",
          name: "Untitled.md",
          absolutePath: "/workspace/Untitled.md",
          sha256: "sha-untitled-1",
        };
      },
      readFile: (input: any) => {
        return {
          state: "text" as const,
          path: input.path,
          sha256: "sha-read",
          sizeBytes: 0,
          mimeType: "text/markdown",
          modifiedAtMs: 1,
          content: "",
        };
      },
      openFile: () => ({ delivered: 0 }),
    });

    const view = render(<FilesPanel threadId="thread-1" params={null} />);

    // Find the toolbar "New note" button
    const newNoteBtns = await view.findAllByRole("button", { name: "New note" });
    const newNoteBtn = newNoteBtns[0];
    expect(newNoteBtn).toBeDefined();

    // Click "New note"
    await act(async () => {
      fireEvent.click(newNoteBtn);
    });

    // Verify it opened the tab for "Untitled.md"
    await waitFor(() => {
      expect(view.getAllByText("Untitled.md").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("opens note from original destination scope when destination is in another workspace", async () => {
    let readFileScope: any = null;
    let readFilePath: string | null = null;
    const foreignScope = {
      kind: "host" as const,
      hostId: "host_5rncjk8fs2",
      rootPath: "/home/ubuntu/Projects/notes-system",
    };

    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "active-project",
        entries: [],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "active-project",
        entries: [],
        truncated: false,
        status: "ready" as const,
        indexedCount: 0,
        indexingSinceMs: null,
      }),
      createNote: () => {
        return {
          scope: foreignScope,
          path: "Untitled.md",
          name: "Untitled.md",
          absolutePath: "/home/ubuntu/Projects/notes-system/Untitled.md",
          sha256: "sha-foreign",
        };
      },
      readFile: (input: any) => {
        readFileScope = input.scope;
        readFilePath = input.path;
        return {
          state: "text" as const,
          path: input.path,
          sha256: "sha-foreign-content",
          sizeBytes: 0,
          mimeType: "text/markdown",
          modifiedAtMs: 1,
          content: "# Notes from foreign vault",
        };
      },
      openFile: () => ({ delivered: 0 }),
    });

    const view = render(<FilesPanel threadId="thread-1" params={null} />);

    const newNoteBtns = await view.findAllByRole("button", { name: "New note" });
    const newNoteBtn = newNoteBtns[0];
    await act(async () => {
      fireEvent.click(newNoteBtn);
    });

    // The note must be read using its original destination scope, NOT current scope!
    await waitFor(() => {
      expect(readFilePath).toBe("Untitled.md");
      expect(readFileScope).toEqual(foreignScope);
    });
  });

  it("shortcut Mod+Alt+N creates note when panel is active, but is ignored inside editable controls", async () => {
    let createNoteCalls = 0;

    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "proj",
        entries: [],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "proj",
        entries: [],
        truncated: false,
        status: "ready" as const,
        indexedCount: 0,
        indexingSinceMs: null,
      }),
      createNote: () => {
        createNoteCalls += 1;
        return {
          scope: { kind: "thread" as const, threadId: "thread-1" },
          path: "Untitled.md",
          name: "Untitled.md",
          absolutePath: "/workspace/Untitled.md",
          sha256: "sha-shortcut",
        };
      },
      readFile: (input: any) => ({
        state: "text" as const,
        path: input.path,
        sha256: "sha",
        sizeBytes: 0,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "",
      }),
      openFile: () => ({ delivered: 0 }),
    });

    const view = render(<FilesPanel threadId="thread-1" params={null} />);

    // 1. When focus is inside search input (an editable control):
    const searchInput = await view.findByRole("textbox", { name: "Search files" });
    searchInput.focus();

    await act(async () => {
      fireEvent.keyDown(searchInput, {
        key: "n",
        code: "KeyN",
        altKey: true,
        ctrlKey: true,
      });
    });

    // Shortcut must be IGNORED inside editable control!
    expect(createNoteCalls).toBe(0);

    // 2. When focus is on a non-editable element inside panel (e.g. Refresh files button):
    const refreshBtn = await view.findByRole("button", { name: "Refresh files" });
    refreshBtn.focus();

    await act(async () => {
      fireEvent.keyDown(refreshBtn, {
        key: "n",
        code: "KeyN",
        altKey: true,
        ctrlKey: true,
      });
    });

    // Shortcut must FIRE when focused in panel!
    await waitFor(() => {
      expect(createNoteCalls).toBe(1);
    });
  });

  it("prevents duplicate creations when New note is tapped multiple times in flight", async () => {
    let createNoteCalls = 0;
    let finishCreate!: () => void;
    const pendingPromise = new Promise<any>((resolve) => {
      finishCreate = () =>
        resolve({
          scope: { kind: "thread" as const, threadId: "thread-1" },
          path: "Untitled.md",
          name: "Untitled.md",
          absolutePath: "/workspace/Untitled.md",
          sha256: "sha-dup",
        });
    });

    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "proj",
        entries: [],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "proj",
        entries: [],
        truncated: false,
        status: "ready" as const,
        indexedCount: 0,
        indexingSinceMs: null,
      }),
      createNote: () => {
        createNoteCalls += 1;
        return pendingPromise;
      },
      readFile: () => ({
        state: "text" as const,
        path: "Untitled.md",
        sha256: "sha",
        sizeBytes: 0,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "",
      }),
      openFile: () => ({ delivered: 0 }),
    });

    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    const newNoteBtns = await view.findAllByRole("button", { name: "New note" });
    const newNoteBtn = newNoteBtns[0];

    // Double-tap while first request is in-flight
    await act(async () => {
      fireEvent.click(newNoteBtn);
      fireEvent.click(newNoteBtn);
      fireEvent.click(newNoteBtn);
    });

    expect(createNoteCalls).toBe(1);

    // Resolve the in-flight promise
    await act(async () => {
      finishCreate();
    });

    await waitFor(() => {
      expect(view.getAllByText("Untitled.md").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("handles server error gracefully without crashing", async () => {
    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "proj",
        entries: [],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "proj",
        entries: [],
        truncated: false,
        status: "ready" as const,
        indexedCount: 0,
        indexingSinceMs: null,
      }),
      createNote: () => {
        throw new Error("Disk quota exceeded");
      },
    });

    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    const newNoteBtns = await view.findAllByRole("button", { name: "New note" });
    const newNoteBtn = newNoteBtns[0];

    // Clicking when server fails does not crash the component
    await act(async () => {
      fireEvent.click(newNoteBtn);
    });

    // The panel remains intact and rendered
    expect(view.getAllByRole("button", { name: "New note" })[0]).toBeDefined();
  });

  it("directory context menu 'New note here' overrides default destination with explicit directory", async () => {
    let createNoteDirectory: string | undefined = undefined;
    const entries = [
      { kind: "directory" as const, path: "docs", name: "docs", score: 0, positions: [] },
    ];

    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "proj",
        entries,
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "proj",
        entries,
        truncated: false,
        status: "ready" as const,
        indexedCount: 1,
        indexingSinceMs: null,
      }),
      createNote: (input: any) => {
        expect(input).toStrictEqual(JSON.parse(JSON.stringify(input)));
        expect(input).toHaveProperty("directory", "docs");
        createNoteDirectory = input?.directory;
        return {
          scope: { kind: "thread" as const, threadId: "thread-1" },
          path: "docs/Untitled.md",
          name: "Untitled.md",
          absolutePath: "/workspace/docs/Untitled.md",
          sha256: "sha-docs-note",
        };
      },
      readFile: (input: any) => ({
        state: "text" as const,
        path: input.path,
        sha256: "sha",
        sizeBytes: 0,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "",
      }),
      openFile: () => ({ delivered: 0 }),
    });

    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    const dirRow = await view.findByRole("treeitem", { name: "docs" });

    // Open context menu on "docs" folder
    await act(async () => {
      fireEvent.contextMenu(dirRow);
    });

    // Select "New note here"
    const newNoteHere = await view.findByRole("menuitem", { name: "New note here" });
    await act(async () => {
      fireEvent.click(newNoteHere);
    });

    expect(createNoteDirectory).toBe("docs");
    await waitFor(() => {
      expect(view.getAllByText("Untitled.md").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("both same-name tabs remain independently selectable and maintain draft separation", async () => {
    const foreignScope = {
      kind: "host" as const,
      hostId: "host_notes",
      rootPath: "/home/ubuntu/Projects/notes-system",
    };
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => ({
        state: "text" as const,
        path: input.path,
        sha256: input.scope?.kind === "host" ? "sha-foreign" : "sha-local",
        sizeBytes: 10,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: input.scope?.kind === "host" ? "Foreign content" : "Local content",
      }),
    });

    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      await hook.result.current.openPath("Untitled.md");
      await hook.result.current.openPath("Untitled.md", foreignScope);
    });

    expect(hook.result.current.tabs).toHaveLength(2);
    const localTab = hook.result.current.tabs.find((t) => t.scope.kind === "thread")!;
    const foreignTab = hook.result.current.tabs.find((t) => t.scope.kind === "host")!;
    expect(localTab).toBeDefined();
    expect(foreignTab).toBeDefined();
    expect(localTab.id).not.toBe(foreignTab.id);

    // Draft separation: editing tab 1 does not affect tab 2
    act(() => {
      hook.result.current.setDraftText(localTab.id, "Local draft");
    });
    expect(hook.result.current.tabs.find((t) => t.id === localTab.id)?.draftText).toBe("Local draft");
    expect(hook.result.current.tabs.find((t) => t.id === foreignTab.id)?.draftText).toBe("Foreign content");

    act(() => {
      hook.result.current.setDraftText(foreignTab.id, "Foreign draft");
    });
    expect(hook.result.current.tabs.find((t) => t.id === localTab.id)?.draftText).toBe("Local draft");
    expect(hook.result.current.tabs.find((t) => t.id === foreignTab.id)?.draftText).toBe("Foreign draft");

    // Independent selection
    act(() => {
      hook.result.current.setActiveTabId(localTab.id);
    });
    expect(hook.result.current.activeTabId).toBe(localTab.id);
    expect(hook.result.current.activeTab?.id).toBe(localTab.id);

    act(() => {
      hook.result.current.setActiveTabId(foreignTab.id);
    });
    expect(hook.result.current.activeTabId).toBe(foreignTab.id);
    expect(hook.result.current.activeTab?.id).toBe(foreignTab.id);
  });

  it.each([
    ["overwrite", false, false],
    ["overwrite", true, false],
    ["overwrite", false, true],
    ["save", true, false],
    ["save", true, true],
  ] as const)("successful %s supersedes deferred reload (newer draft=%s, late error=%s)", async (operation, newerDraft, lateError) => {
    // Overwrite follows the exposed conflict Reload/Overwrite flow. Clean reload/save is hook-only sibling coverage.
    vi.useFakeTimers();
    try {
      const scope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
      const file = (content: string) => ({ state: "text" as const, path: "Untitled.md", sha256: content, sizeBytes: content.length, mimeType: "text/markdown", modifiedAtMs: 1, content });
      let readMode: "normal" | "pending" | "error" = "normal";
      let finishRead!: (response: ReturnType<typeof file>) => void;
      let rejectRead!: (error: Error) => void;
      let conflict = operation === "overwrite";
      const saveFile = vi.fn((input: any) => conflict
        ? { outcome: "conflict" as const, currentSha256: "Remote before write" }
        : { outcome: "written" as const, sha256: input.content, sizeBytes: input.content.length });
      setRpcHandlers({
        listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
        readFile: () => {
          if (readMode === "error") throw new Error("Current reload failed");
          if (readMode === "pending") return new Promise((resolve, reject) => { finishRead = resolve; rejectRead = reject; });
          return file("Original");
        },
        saveFile,
        overwriteFile: (input: any) => ({ outcome: "written" as const, sha256: input.content, sizeBytes: input.content.length }),
      });
      const hook = renderHook(() => useFilesWorkspace());
      await act(async () => { await hook.result.current.openPath("Untitled.md", scope); });
      const id = hook.result.current.activeTabId!;
      if (operation === "overwrite") {
        act(() => hook.result.current.setDraftText(id, "Written"));
        await act(async () => { expect(await hook.result.current.save(id)).toBe(false); });
        expect(hook.result.current.activeTab?.saveState.kind).toBe("conflict");
      }
      readMode = "pending";
      let pending!: Promise<boolean>;
      act(() => { pending = hook.result.current.reloadFile(id); });
      expect(hook.result.current.activeTab?.loading).toBe(true);
      if (newerDraft) act(() => hook.result.current.setDraftText(id, "New written"));
      const submitted = hook.result.current.activeTab!.draftText;
      await act(async () => { expect(await hook.result.current[operation](id)).toBe(true); });
      expect(hook.result.current.activeTab?.loading).toBe(false);
      if (newerDraft) act(() => hook.result.current.setDraftText(id, "Edited after write"));
      const newestDraft = hook.result.current.activeTab!.draftText;
      await act(async () => {
        if (lateError) rejectRead(new Error("Stale read failed"));
        else finishRead(file("Remote before write"));
        expect(await pending).toBe(false);
      });
      expect(hook.result.current.activeTab?.draftText).toBe(newestDraft);
      expect(hook.result.current.activeTab?.savedText).toBe(submitted);
      expect(hook.result.current.activeTab?.file?.sha256).toBe(submitted);
      expect(hook.result.current.activeTab?.saveState.kind).toBe("saved");
      // A subsequent save must use the successful write's CAS version, not the stale read's.
      conflict = false;
      act(() => hook.result.current.setDraftText(id, "Newest draft"));
      await act(async () => { expect(await hook.result.current.save(id)).toBe(true); });
      expect(saveFile.mock.calls.at(-1)?.[0].expectedSha256).toBe(submitted);
      readMode = "error";
      await act(async () => { expect(await hook.result.current.reloadFile(id)).toBe(false); });
      expect(hook.result.current.activeTab?.loading).toBe(false);
      expect(hook.result.current.activeTab?.saveState).toEqual({ kind: "error", message: "Current reload failed" });
      readMode = "normal";
      await act(async () => { expect(await hook.result.current.reloadFile(id)).toBe(true); });
      expect(hook.result.current.activeTab?.loading).toBe(false);
      expect(hook.result.current.activeTab?.savedText).toBe("Original");
      expect(hook.result.current.activeTab?.saveState.kind).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("has one initial read owner and ignores a closed/reopened tab's old generation", async () => {
    const reads: Array<(file: any) => void> = [];
    const foreignScope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: () => new Promise((resolve) => { reads.push(resolve); }),
    });
    const hook = renderHook(() => useFilesWorkspace());
    const file = (content: string) => ({ state: "text", path: "Untitled.md", sha256: content, sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content });
    let oldOpen!: Promise<boolean>;
    act(() => { oldOpen = hook.result.current.openPath("Untitled.md", foreignScope); });
    expect(reads).toHaveLength(1);
    const id = hook.result.current.tabs[0].id;
    await act(async () => { expect(await hook.result.current.closeFile(id)).toBe(true); });
    let newOpen!: Promise<boolean>;
    act(() => { newOpen = hook.result.current.openPath("Untitled.md", foreignScope); });
    expect(reads).toHaveLength(2);
    await act(async () => { reads[1](file("New generation")); expect(await newOpen).toBe(true); });
    act(() => { hook.result.current.setDraftText(id, "Newest unsaved draft"); });
    await act(async () => { reads[0](file("Old generation")); expect(await oldOpen).toBe(false); });
    hook.rerender();
    expect(reads).toHaveLength(2);
    expect(hook.result.current.activeTab?.draftText).toBe("Newest unsaved draft");
    expect(hook.result.current.activeTab?.savedText).toBe("New generation");
  });

  it("reports a created-but-unreadable note visibly on mobile and retries reading, not creation", async () => {
    TestResizeObserver.width = 360;
    const createNote = vi.fn(() => ({ scope: { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" }, path: "Untitled.md", name: "Untitled.md", absolutePath: "/notes/Untitled.md", sha256: "created" }));
    let denied = true;
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      createNote,
      readFile: (input: any) => {
        if (denied) throw new Error("Read denied");
        return { state: "text" as const, path: input.path, sha256: "created", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "Created note" };
      },
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    fireEvent.click((await view.findAllByRole("button", { name: "New note" }))[0]);
    await waitFor(() => expect(view.getAllByRole("alert").some((alert) => /created.*could not open/i.test(alert.textContent ?? ""))).toBe(true));
    expect(createNote).toHaveBeenCalledTimes(1);
    denied = false;
    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    await view.findByRole("textbox", { name: "Editing preview of Untitled.md" });
    expect(createNote).toHaveBeenCalledTimes(1);
  });

  it("createNote does not claim successful opening when its created file read fails", async () => {
    const createNote = vi.fn(() => ({ scope: { kind: "host" as const, rootPath: "/notes" }, path: "Untitled.md", name: "Untitled.md", absolutePath: "/notes/Untitled.md", sha256: "created" }));
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      createNote,
      readFile: () => { throw new Error("Read denied"); },
    });
    const hook = renderHook(() => useFilesWorkspace());
    let outcome: any;
    await act(async () => { outcome = await hook.result.current.createNote(); });
    expect(outcome.ok).toBe(false);
    expect(outcome.note.path).toBe("Untitled.md");
    expect(outcome.error).toMatch(/created.*could not open/i);
    expect(createNote).toHaveBeenCalledTimes(1);
  });

  it("keeps newer edits when a close joins an older in-flight save", async () => {
    let finishSave!: (result: any) => void;
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => ({ state: "text" as const, path: input.path, sha256: "sha-v1", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "Original" }),
      saveFile: () => new Promise((resolve) => { finishSave = resolve; }),
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => { await hook.result.current.openPath("Untitled.md"); });
    const id = hook.result.current.tabs[0].id;
    act(() => hook.result.current.setDraftText(id, "Submitted"));
    let saving!: Promise<boolean>;
    act(() => { saving = hook.result.current.save(id); });
    act(() => hook.result.current.setDraftText(id, "Newer unsaved draft"));
    let closing!: Promise<boolean>;
    act(() => { closing = hook.result.current.closeFile(id); });
    let closed = true;
    await act(async () => {
      finishSave({ outcome: "written", sha256: "sha-v2", sizeBytes: 9 });
      await saving;
      closed = await closing;
    });
    expect(closed).toBe(false);
    expect(hook.result.current.tabs).toHaveLength(1);
    expect(hook.result.current.tabs[0].savedText).toBe("Submitted");
    expect(hook.result.current.tabs[0].draftText).toBe("Newer unsaved draft");
  });

  it("mobile same-name sheets select and close by source identity and preserve separate editors", async () => {
    const entries = [{ kind: "file" as const, path: "Untitled.md", name: "Untitled.md", score: 0, positions: [] }];
    const foreignScope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries, annotateAvailable: false, sqlAvailable: false }),
      listTree: () => ({ rootName: "repo", entries, truncated: false, status: "ready" as const, indexedCount: 1, indexingSinceMs: null }),
      readFile: (input: any) => ({ state: "text" as const, path: input.path, sha256: input.scope.kind === "host" ? "foreign" : "local", sizeBytes: 10, mimeType: "text/markdown", modifiedAtMs: 1, content: input.scope.kind === "host" ? "Foreign original" : "Local original" }),
      createNote: () => ({ scope: foreignScope, path: "Untitled.md", name: "Untitled.md", absolutePath: "/notes/Untitled.md", sha256: "foreign" }),
      saveFile: () => ({ outcome: "conflict" as const, currentSha256: "remote" }),
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    fireEvent.click(await view.findByRole("treeitem", { name: "Untitled.md" }));
    await view.findByRole("textbox", { name: "Editing preview of Untitled.md" });
    fireEvent.click(view.getAllByRole("button", { name: "New note" })[0]);
    await waitFor(() => expect(view.getByRole("textbox", { name: "Editing preview of Untitled.md" }).textContent).toContain("Foreign original"));
    act(() => TestResizeObserver.resize(360));
    // Exercise the real sheet; JSDOM does not implement the native modal methods.
    const dialog = view.container.querySelector("dialog")!;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event("close")); };
    const editor = view.getByRole("textbox", { name: "Editing preview of Untitled.md" });
    const paragraph = editor.querySelector("p")!;
    paragraph.textContent = "Foreign draft";
    fireEvent.input(paragraph);
    await view.findByText("Unsaved");
    fireEvent.click(view.getByRole("button", { name: "Open files" }));
    expect(view.getAllByRole("button", { name: "Switch to Untitled.md" })).toHaveLength(2);
    fireEvent.click(view.getAllByRole("button", { name: "Switch to Untitled.md" })[0]);
    await waitFor(() => expect(view.getByRole("textbox", { name: "Editing preview of Untitled.md" }).textContent).toContain("Local original"));
    fireEvent.click(view.getByRole("button", { name: "Open files" }));
    fireEvent.click(view.getAllByRole("button", { name: "Close Untitled.md" })[1]);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Your draft is preserved"));
    expect(view.getByRole("textbox", { name: "Editing preview of Untitled.md" }).textContent).toContain("Foreign draft");
    fireEvent.click(view.getByRole("button", { name: "Open files" }));
    expect(view.getAllByRole("button", { name: "Switch to Untitled.md" })).toHaveLength(2);
  });

  it("close guarding protects dirty second tab without closing both same-name tabs", async () => {
    const foreignScope = {
      kind: "host" as const,
      hostId: "host_notes",
      rootPath: "/home/ubuntu/Projects/notes-system",
    };
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => ({
        state: "text" as const,
        path: input.path,
        sha256: input.scope?.kind === "host" ? "sha-foreign" : "sha-local",
        sizeBytes: 10,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "Original text",
      }),
      saveFile: () => ({ outcome: "conflict" as const, currentSha256: "conflict-sha" }),
    });

    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      await hook.result.current.openPath("Untitled.md");
      await hook.result.current.openPath("Untitled.md", foreignScope);
    });

    const localTab = hook.result.current.tabs.find((t) => t.scope.kind === "thread")!;
    const foreignTab = hook.result.current.tabs.find((t) => t.scope.kind === "host")!;

    // Make only the foreign tab dirty
    act(() => {
      hook.result.current.setDraftText(foreignTab.id, "Dirty foreign draft");
    });

    // Close the foreign tab: save fails due to conflict, so close should be rejected!
    let closedForeign = false;
    await act(async () => {
      closedForeign = await hook.result.current.closeFile(foreignTab.id);
    });
    expect(closedForeign).toBe(false);
    expect(hook.result.current.tabs).toHaveLength(2);
    expect(hook.result.current.tabs.find((t) => t.id === foreignTab.id)?.draftText).toBe("Dirty foreign draft");

    // Close the clean local tab: should close cleanly, leaving foreign tab untouched
    let closedLocal = false;
    await act(async () => {
      closedLocal = await hook.result.current.closeFile(localTab.id);
    });
    expect(closedLocal).toBe(true);
    expect(hook.result.current.tabs).toHaveLength(1);
    expect(hook.result.current.tabs[0].id).toBe(foreignTab.id);
    expect(hook.result.current.tabs[0].draftText).toBe("Dirty foreign draft");
  });

  it("save and autosave target each tab's own scope", async () => {
    vi.useFakeTimers();
    try {
      const foreignScope = {
        kind: "host" as const,
        hostId: "host_notes",
        rootPath: "/home/ubuntu/Projects/notes-system",
      };
      const savedCalls: any[] = [];
      setRpcHandlers({
        listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
        readFile: (input: any) => ({
          state: "text" as const,
          path: input.path,
          sha256: "sha-init",
          sizeBytes: 10,
          mimeType: "text/markdown",
          modifiedAtMs: 1,
          content: "Original text",
        }),
        saveFile: (input: any) => {
          savedCalls.push(input);
          return { outcome: "written" as const, sha256: "sha-saved", sizeBytes: 20 };
        },
      });

      const hook = renderHook(() => useFilesWorkspace());
      await act(async () => {
        await hook.result.current.openPath("Untitled.md");
        await hook.result.current.openPath("Untitled.md", foreignScope);
      });

      const localTab = hook.result.current.tabs.find((t) => t.scope.kind === "thread")!;
      const foreignTab = hook.result.current.tabs.find((t) => t.scope.kind === "host")!;

      // Explicit save on foreign tab
      act(() => {
        hook.result.current.setDraftText(foreignTab.id, "Foreign content updated");
      });
      await act(async () => {
        const ok = await hook.result.current.save(foreignTab.id);
        expect(ok).toBe(true);
      });

      expect(savedCalls).toHaveLength(1);
      expect(savedCalls[0].scope).toEqual(foreignScope);
      expect(savedCalls[0].path).toBe("Untitled.md");
      expect(savedCalls[0].content).toBe("Foreign content updated");

      // Autosave on local tab
      savedCalls.length = 0;
      act(() => {
        hook.result.current.setDraftText(localTab.id, "Local content updated");
      });
      await act(async () => {
        vi.advanceTimersByTime(800);
      });

      expect(savedCalls).toHaveLength(1);
      expect(savedCalls[0].scope).toEqual({ kind: "thread", threadId: "thread-1" });
      expect(savedCalls[0].path).toBe("Untitled.md");
      expect(savedCalls[0].content).toBe("Local content updated");
    } finally {
      vi.useRealTimers();
    }
  });

  it("overwrites only the selected foreign same-name tab", async () => {
    const foreignScope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
    const overwrites: any[] = [];
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => ({ state: "text" as const, path: input.path, sha256: "sha", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "Original" }),
      overwriteFile: (input: any) => { overwrites.push(input); return { outcome: "written" as const, sha256: "overwritten", sizeBytes: 7 }; },
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      await hook.result.current.openPath("Untitled.md");
      await hook.result.current.openPath("Untitled.md", foreignScope);
    });
    const foreignId = hook.result.current.tabs.find((tab) => tab.scope.kind === "host")!.id;
    act(() => hook.result.current.setDraftText(foreignId, "Foreign"));
    await act(async () => { expect(await hook.result.current.overwrite(foreignId)).toBe(true); });
    expect(overwrites).toEqual([{ scope: foreignScope, path: "Untitled.md", content: "Foreign" }]);
    expect(hook.result.current.tabs.find((tab) => tab.scope.kind === "thread")!.draftText).toBe("Original");
    expect(hook.result.current.tabs.find((tab) => tab.id === foreignId)!.savedText).toBe("Foreign");
  });

  it("10s poller queries each tab's scope, ignores unchanged remote, updates clean tab and flags dirty-tab conflicts", async () => {
    vi.useFakeTimers();
    try {
      const foreignScope = {
        kind: "host" as const,
        hostId: "host_notes",
        rootPath: "/home/ubuntu/Projects/notes-system",
      };
      let foreignRemoteSha = "sha-foreign-v1";
      let foreignRemoteContent = "Remote v1";
      const readCalls: any[] = [];

      setRpcHandlers({
        listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
        readFile: (input: any) => {
          readCalls.push(input);
          if (input.scope?.kind === "host") {
            return {
              state: "text" as const,
              path: input.path,
              sha256: foreignRemoteSha,
              sizeBytes: 10,
              mimeType: "text/markdown",
              modifiedAtMs: 1,
              content: foreignRemoteContent,
            };
          }
          return {
            state: "text" as const,
            path: input.path,
            sha256: "sha-local-v1",
            sizeBytes: 10,
            mimeType: "text/markdown",
            modifiedAtMs: 1,
            content: "Local v1",
          };
        },
      });

      const hook = renderHook(() => useFilesWorkspace());
      await act(async () => {
        await hook.result.current.openPath("Untitled.md");
        await hook.result.current.openPath("Untitled.md", foreignScope);
      });

      readCalls.length = 0;

      // 1. Unchanged remote: poller queries each tab by its own scope, but does nothing because SHAs match
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(readCalls.some((c) => c.scope.kind === "host")).toBe(true);
      expect(readCalls.some((c) => c.scope.kind === "thread")).toBe(true);
      const foreignTab = hook.result.current.tabs.find((t) => t.scope.kind === "host")!;
      expect(foreignTab.file?.sha256).toBe("sha-foreign-v1");

      // 2. Real remote edit on clean foreign tab: poller updates content
      readCalls.length = 0;
      foreignRemoteSha = "sha-foreign-v2";
      foreignRemoteContent = "Remote v2 updated";
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      const updatedForeignTab = hook.result.current.tabs.find((t) => t.scope.kind === "host")!;
      expect(updatedForeignTab.file?.sha256).toBe("sha-foreign-v2");
      expect(updatedForeignTab.draftText).toBe("Remote v2 updated");

      // 3. Real remote edit on DIRTY foreign tab: poller flags conflict and preserves dirty draft
      act(() => {
        hook.result.current.setDraftText(updatedForeignTab.id, "My unsaved edits");
      });
      foreignRemoteSha = "sha-foreign-v3";
      foreignRemoteContent = "Remote v3 conflicting";
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      const conflictedForeignTab = hook.result.current.tabs.find((t) => t.scope.kind === "host")!;
      expect(conflictedForeignTab.saveState).toEqual({
        kind: "conflict",
        currentSha256: "sha-foreign-v3",
      });
      expect(conflictedForeignTab.draftText).toBe("My unsaved edits");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a poll response captured before a newer save", async () => {
    vi.useFakeTimers();
    try {
      const foreignScope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
      let deferForeignPoll = false;
      let finishForeignPoll!: (file: any) => void;
      setRpcHandlers({
        listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
        readFile: (input: any) => {
          if (input.scope.kind === "host" && deferForeignPoll) {
            deferForeignPoll = false;
            return new Promise((resolve) => { finishForeignPoll = resolve; });
          }
          return { state: "text" as const, path: input.path, sha256: "sha-v1", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "Version 1" };
        },
        saveFile: () => ({ outcome: "written" as const, sha256: "sha-v2", sizeBytes: 1 }),
      });
      const hook = renderHook(() => useFilesWorkspace());
      await act(async () => {
        await hook.result.current.openPath("Untitled.md");
        await hook.result.current.openPath("Untitled.md", foreignScope);
      });
      const foreignTab = hook.result.current.tabs.find((tab) => tab.scope.kind === "host")!;
      deferForeignPoll = true;
      act(() => { vi.advanceTimersByTime(10_000); });
      act(() => { hook.result.current.setDraftText(foreignTab.id, "New local draft"); });
      await act(async () => { await hook.result.current.save(foreignTab.id); });
      finishForeignPoll({ state: "text", path: "Untitled.md", sha256: "sha-v1-remote", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "Stale response" });
      await act(async () => { await Promise.resolve(); });
      const latest = hook.result.current.tabs.find((tab) => tab.id === foreignTab.id)!;
      expect(latest.file?.sha256).toBe("sha-v2");
      expect(latest.draftText).toBe("New local draft");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores polling captured for a closed tab after the same identity is reopened", async () => {
    vi.useFakeTimers();
    try {
      let deferPoll = false;
      let finishPoll!: (file: any) => void;
      const foreignScope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
      const file = { state: "text" as const, path: "Untitled.md", sha256: "same-sha", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "Original" };
      setRpcHandlers({
        listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
        readFile: () => {
          if (deferPoll) { deferPoll = false; return new Promise((resolve) => { finishPoll = resolve; }); }
          return file;
        },
      });
      const hook = renderHook(() => useFilesWorkspace());
      await act(async () => { await hook.result.current.openPath("Untitled.md", foreignScope); });
      const id = hook.result.current.tabs[0].id;
      deferPoll = true;
      act(() => { vi.advanceTimersByTime(10_000); });
      await act(async () => { await hook.result.current.closeFile(id); });
      await act(async () => { await hook.result.current.openPath("Untitled.md", foreignScope); });
      act(() => hook.result.current.setDraftText(id, "Reopened draft"));
      await act(async () => { finishPoll({ ...file, sha256: "stale-generation", content: "Old remote" }); });
      expect(hook.result.current.activeTab?.draftText).toBe("Reopened draft");
      expect(hook.result.current.activeTab?.saveState.kind).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("loadStoredWorkspace and initial loader restore and reload foreign active tab without dropping it", async () => {
    const foreignScope = {
      kind: "host" as const,
      hostId: "host_notes",
      rootPath: "/home/ubuntu/Projects/notes-system",
    };
    // Older browser storage can serialize equivalent scope keys in a different order.
    const foreignId = JSON.stringify([2, { kind: "host", rootPath: foreignScope.rootPath, hostId: foreignScope.hostId }, "Untitled.md"]);
    const storedState = {
      version: 2,
      openFiles: [
        { version: 2, scope: { kind: "thread", threadId: "thread-1" }, path: "local.md" },
        { version: 2, scope: foreignScope, path: "Untitled.md" },
      ],
      activeFileId: foreignId,
    };
    window.localStorage.setItem(
      `bb-plugin-files:workspace:${JSON.stringify({ kind: "thread", threadId: "thread-1" })}`,
      JSON.stringify(storedState),
    );

    let readForeignScope: any = null;
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => {
        if (input.scope?.kind === "host") {
          readForeignScope = input.scope;
          return {
            state: "text" as const,
            path: input.path,
            sha256: "sha-foreign",
            sizeBytes: 15,
            mimeType: "text/markdown",
            modifiedAtMs: 1,
            content: "Restored foreign content",
          };
        }
        return {
          state: "text" as const,
          path: input.path,
          sha256: "sha-local",
          sizeBytes: 10,
          mimeType: "text/markdown",
          modifiedAtMs: 1,
          content: "Local file",
        };
      },
    });

    const hook = renderHook(() => useFilesWorkspace());
    await waitFor(() => expect(hook.result.current.tabs.every((t) => !t.loading)).toBe(true));

    expect(hook.result.current.tabs).toHaveLength(2);
    expect(hook.result.current.activeTabId).toBe(hook.result.current.tabs.find((tab) => tab.scope.kind === "host")!.id);
    expect(hook.result.current.activeTabId).not.toBe(foreignId);
    expect(hook.result.current.activeTab?.scope).toEqual(foreignScope);
    expect(hook.result.current.activeTab?.path).toBe("Untitled.md");
    expect(hook.result.current.activeTab?.draftText).toBe("Restored foreign content");
    expect(readForeignScope).toEqual(foreignScope);
    readForeignScope = null;
    await act(async () => { expect(await hook.result.current.reloadFile(hook.result.current.activeTabId!)).toBe(true); });
    expect(readForeignScope).toEqual(foreignScope);
    expect(hook.result.current.activeTab?.draftText).toBe("Restored foreign content");
  });

  it("createNote error is visibly reported with role='alert' when tree is hidden on mobile editor", async () => {
    TestResizeObserver.width = 360;
    const entries = [
      { kind: "file" as const, path: "README.md", name: "README.md", score: 0, positions: [] },
    ];
    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "proj",
        entries,
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "proj",
        entries,
        truncated: false,
        status: "ready" as const,
        indexedCount: 1,
        indexingSinceMs: null,
      }),
      createNote: () => {
        throw new Error("Disk quota exceeded: cannot create note");
      },
      readFile: () => ({
        state: "text" as const,
        path: "README.md",
        sha256: "sha-readme",
        sizeBytes: 10,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "README content",
      }),
    });

    const view = render(<FilesPanel threadId="thread-1" params={null} />);

    // In mobile view, open README.md so mobile switches to editor view (tree is hidden!)
    const readmeItem = await view.findByRole("treeitem", { name: "README.md" });
    await act(async () => {
      fireEvent.click(readmeItem);
    });

    // Verify tree is hidden on mobile:
    const tree = view.container.querySelector("aside")!;
    expect(tree.parentElement!.style.display).toBe("none");

    // In mobile editor view, trigger "New note" via shortcut while focused in mobile navigation
    const showFilesBtn = await view.findByRole("button", { name: "Show files" });
    showFilesBtn.focus();
    await act(async () => {
      fireEvent.keyDown(showFilesBtn, {
        key: "n",
        code: "KeyN",
        altKey: true,
        ctrlKey: true,
      });
    });

    // The error banner MUST be visibly rendered in the editor with role="alert" containing the error message!
    await waitFor(() => {
      const alert = view.getByRole("alert");
      expect(alert).toBeDefined();
      expect(alert.textContent).toContain("Disk quota exceeded: cannot create note");
    });
  });

  it("successful preferred opener keeps the mobile view on Files instead of a blank editor", async () => {
    TestResizeObserver.width = 360;
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "proj", entries: [], annotateAvailable: false, sqlAvailable: false }),
      listTree: () => ({ rootName: "proj", entries: [], truncated: false, status: "ready" as const, indexedCount: 0, indexingSinceMs: null }),
      createNote: () => ({ scope: { kind: "thread" as const, threadId: "thread-1" }, path: "Untitled.md", name: "Untitled.md", absolutePath: "/workspace/Untitled.md", sha256: "sha-note" }),
      openFile: () => ({ delivered: 1 }),
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    const button = (await view.findAllByRole("button", { name: "New note" }))[0];
    await act(async () => { fireEvent.click(button); });
    const editor = view.container.querySelector(".bb-files-panel > div:first-child") as HTMLElement;
    const tree = view.container.querySelector("aside")!;
    expect(editor.style.display).toBe("none");
    expect(tree.parentElement!.style.display).not.toBe("none");
  });

  it("preferred opener rejection falls back to the created note's internal tab", async () => {
    TestResizeObserver.width = 360;
    let readCreatedNote = false;

    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "proj",
        entries: [],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      listTree: () => ({
        rootName: "proj",
        entries: [],
        truncated: false,
        status: "ready" as const,
        indexedCount: 0,
        indexingSinceMs: null,
      }),
      createNote: () => ({
        scope: { kind: "thread" as const, threadId: "thread-1" },
        path: "Untitled.md",
        name: "Untitled.md",
        absolutePath: "/workspace/Untitled.md",
        sha256: "sha-note",
      }),
      openFile: () => { throw new Error("Preferred opener unavailable"); },
      readFile: (input: any) => {
        if (input.path === "Untitled.md") readCreatedNote = true;
        return {
        state: "text" as const,
        path: input.path,
        sha256: "sha",
        sizeBytes: 0,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "# Internal editor content",
        };
      },
    });

    const view2 = render(<FilesPanel threadId="thread-1" params={null} />);
    const newNoteBtns2 = await view2.findAllByRole("button", { name: "New note" });
    await act(async () => {
      fireEvent.click(newNoteBtns2[0]);
    });

    // A rejected preferred opener still leaves the created file open internally.
    await waitFor(() => expect(readCreatedNote).toBe(true));
    expect(view2.container.querySelector('.bb-files-mobile-picker')?.getAttribute("title")).toBe("Untitled.md");
    const editorContainer2 = view2.container.querySelector(".bb-files-panel > div:first-child") as HTMLElement;
    expect(editorContainer2.style.display).not.toBe("none");
  });

  it("does not display the previous source's HTML preview while a same-name tab URL is pending", async () => {
    const localScope = { kind: "thread" as const, threadId: "thread-1" };
    const foreignScope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
    window.localStorage.setItem(
      `bb-plugin-files:workspace:${JSON.stringify(localScope)}`,
      JSON.stringify({ version: 2, openFiles: [localScope, foreignScope].map((scope) => ({ version: 2, scope, path: "same.html" })), activeFileId: JSON.stringify([2, localScope, "same.html"]) }),
    );
    let finishForeignUrl!: (result: { url: string }) => void;
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => ({ state: "text" as const, path: input.path, sha256: input.scope.kind === "host" ? "foreign" : "local", sizeBytes: 1, mimeType: "text/html", modifiedAtMs: 1, content: "<p>Preview</p>" }),
      getDownloadUrl: (input: any) => input.scope.kind === "host" ? new Promise((resolve) => { finishForeignUrl = resolve; }) : { url: "https://files.test/local" },
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    await waitFor(() => expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain("/local"));
    fireEvent.click(view.getAllByTitle("same.html")[1]);
    await waitFor(() => expect(view.container.querySelector("iframe")?.getAttribute("src")).toBe("about:blank"));
    await act(async () => { finishForeignUrl({ url: "https://files.test/foreign" }); });
    await waitFor(() => expect(view.container.querySelector("iframe")?.getAttribute("src")).toContain("/foreign"));
  });

  it("restoration rejects non-canonical untrusted host roots before issuing reads", async () => {
    const unsafeScope = { kind: "host", hostId: "host_notes", rootPath: "/notes/../private" };
    window.localStorage.setItem(
      `bb-plugin-files:workspace:${JSON.stringify({ kind: "thread", threadId: "thread-1" })}`,
      JSON.stringify({ version: 2, openFiles: [{ version: 2, scope: unsafeScope, path: "private.md" }], activeFileId: JSON.stringify([2, unsafeScope, "private.md"]) }),
    );
    const readScopes: any[] = [];
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => { readScopes.push(input.scope); return { state: "text" as const, path: input.path, sha256: "sha", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "text" }; },
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => { await Promise.resolve(); });
    expect(hook.result.current.tabs).toHaveLength(0);
    expect(readScopes).toEqual([]);
  });

  it("tree downloads use the active scope while same-name tab downloads use exact tab scope", async () => {
    const foreignScope = { kind: "host" as const, hostId: "host_notes", rootPath: "/notes" };
    const requests: any[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: any) => ({ state: "text" as const, path: input.path, sha256: input.scope.kind === "host" ? "foreign" : "local", sizeBytes: 1, mimeType: "text/markdown", modifiedAtMs: 1, content: "text" }),
      getDownloadUrl: (input: any) => { requests.push(input); return { url: "https://files.test/download" }; },
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      await hook.result.current.openPath("Untitled.md");
      await hook.result.current.openPath("Untitled.md", foreignScope);
      await hook.result.current.downloadPath("Untitled.md");
    });
    expect(requests[0]).toEqual({ scope: { kind: "thread", threadId: "thread-1" }, path: "Untitled.md" });

    const foreignTab = hook.result.current.tabs.find((tab) => tab.scope.kind === "host")!;
    await act(async () => { await hook.result.current.downloadFile(foreignTab.id); });
    expect(requests[1]).toEqual({ scope: foreignScope, path: "Untitled.md" });
    click.mockRestore();
  });
});
