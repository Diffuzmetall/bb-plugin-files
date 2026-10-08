// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPanel, FILE_OPENER_EXTENSIONS } from "./app";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: (props: {
    onChange?: (elements: never[], appState: object, files: object) => void;
  }) => {
    useEffect(() => {
      props.onChange?.([], {}, {});
    }, [props.onChange]);
    return <div data-testid="mock-files-excalidraw">Drawing</div>;
  },
  loadFromBlob: async () => ({ elements: [], appState: {}, files: {} }),
  serializeAsJSON: () =>
    JSON.stringify({ type: "excalidraw", elements: [], appState: {}, files: {} }),
}));
import {
  getCapturedPluginApp,
  getOpenThreadPanelCalls,
  setBbContext,
  setRpcHandlers,
} from "./test/plugin-sdk-app-runtime";

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
  disconnect() { TestResizeObserver.panels.delete(this); }
  unobserve() {}
}

// JSDOM has no native dialog API; only Chromium checks focus trapping/Escape.
const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
};

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) { this.open = true; },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  TestResizeObserver.width = 900;
  TestResizeObserver.panels.clear();
  setBbContext({ projectId: null, threadId: "thread-1" });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  );
  vi.stubGlobal("navigator", {
    ...navigator,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  for (const key of ["showModal", "close"] as const) {
    if (dialogMethods[key]) Object.defineProperty(HTMLDialogElement.prototype, key, dialogMethods[key]!);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
  }
  window.localStorage.clear();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  vi.unstubAllGlobals();
});

describe("Files plugin app", () => {
  function responsiveFiles(content = "# Hello", readFile?: (input: unknown) => unknown) {
    const entries = ["README.md", "notes.md"].map((path) => ({
      kind: "file" as const, path, name: path, score: 0, positions: [],
    }));
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries, annotateAvailable: false, sqlAvailable: false }),
      listTree: (input: unknown) => ({ rootName: "repo", entries: entries.filter((entry) => entry.path.includes((input as { query: string }).query)), truncated: false, status: "ready", indexedCount: 2, indexingSinceMs: null }),
      readFile: readFile ?? ((input: unknown) => ({ state: "text", path: (input as { path: string }).path, sha256: "sha", sizeBytes: content.length, mimeType: "text/markdown", modifiedAtMs: 1, content })),
      saveFile: () => ({ outcome: "conflict", currentSha256: "external-change" }),
    });
    return render(<FilesPanel threadId="thread-1" params={null} />);
  }

  it("keeps the mobile HTML preview link scoped, disabled while loading, and isolated from its opener", async () => {
    TestResizeObserver.width = 390;
    const entries = [{ kind: "file", path: "page.html", name: "page.html", score: 0, positions: [] }];
    let resolvePreview!: (result: { url: string }) => void;
    const preview = new Promise<{ url: string }>((resolve) => { resolvePreview = resolve; });
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries, annotateAvailable: false, sqlAvailable: false }),
      listTree: () => ({ rootName: "repo", entries, truncated: false, status: "ready", indexedCount: 1, indexingSinceMs: null }),
      readFile: () => ({ state: "text", path: "page.html", sha256: "sha", sizeBytes: 11, mimeType: "text/html", modifiedAtMs: 1, content: "<p>Demo</p>" }),
      getDownloadUrl: () => preview,
    });
    const view = render(<FilesPanel threadId="html-preview-test" params={null} />);
    fireEvent.click(await view.findByRole("treeitem", { name: /page\.html/ }));
    fireEvent.click(await view.findByRole("button", { name: "File actions" }));
    const link = await view.findByRole("link", { name: "Open preview" });
    expect(link.getAttribute("href")).toBeNull();
    expect(link.getAttribute("aria-disabled")).toBe("true");
    await act(async () => resolvePreview({ url: "/previews/demo/page.html" }));
    expect(link.getAttribute("href")).toBe("/previews/demo/page.html?t=sha");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link);
    await waitFor(() => expect(view.queryByRole("dialog", { name: "File actions" })).toBeNull());
  });

  it("wraps keyboard focus at both mobile sheet boundaries", async () => {
    TestResizeObserver.width = 390;
    const view = responsiveFiles();
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    for (const name of ["Open files", "File actions"]) {
      const trigger = await view.findByRole("button", { name });
      fireEvent.click(trigger);
      const sheet = await view.findByRole("dialog", { name });
      const controls = sheet.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]:not([aria-disabled="true"])');
      const first = controls[0];
      const last = controls[controls.length - 1];
      first.focus();
      expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(last);
      expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
      expect(document.activeElement).toBe(first);
      fireEvent.click(view.getByRole("button", { name: "Close dialog" }));
      expect(document.activeElement).toBe(trigger);
    }
  });

  it("returns to files without closing the document and retains Raw, search and open files", async () => {
    TestResizeObserver.width = 390;
    const view = responsiveFiles();
    const search = view.getByRole("textbox", { name: "Search files" });
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    await view.findByRole("textbox", { name: "Editing preview of README.md" });
    fireEvent.click(view.getByRole("button", { name: "Raw" }));
    const editor = await view.findByLabelText("Editing README.md");
    fireEvent.click(view.getByRole("button", { name: "Show files" }));
    expect(editor.isConnected).toBe(true);
    expect(view.getByRole("textbox", { name: "Search files" })).toBe(search);
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "notes" } });
    fireEvent.click(view.getByRole("button", { name: "Return to document" }));
    expect(view.getByLabelText("Editing README.md")).toBe(editor);
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Open files" }));
    fireEvent.click(view.getByRole("button", { name: "Show files" }));
    fireEvent.click(await view.findByRole("treeitem", { name: /notes\.md/ }));
    const switcher = await view.findByRole("button", { name: "Open files" });
    const back = view.getByRole("button", { name: "Show files" });
    expect(back.textContent).toBe("");
    expect(back.querySelector('[data-icon="FolderOpen"]')).toBeTruthy();
    expect(view.queryByRole("button", { name: "Download file" })).toBeNull();
    fireEvent.click(switcher);
    const picker = await view.findByRole("dialog", { name: "Open files" });
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Close dialog" }));
    expect(picker.querySelectorAll('[aria-label^="Switch to "]')).toHaveLength(2);
    fireEvent.click(view.getByRole("button", { name: "Close dialog" }));
    expect(document.activeElement).toBe(switcher);
    fireEvent.click(switcher);
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(picker, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect((picker as HTMLDialogElement).open).toBe(false);
    expect(document.activeElement).toBe(switcher);
    fireEvent.click(switcher);
    fireEvent.change(view.getByRole("searchbox", { name: "Search open files" }), { target: { value: "readme" } });
    expect(view.queryByRole("button", { name: "Switch to notes.md" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Switch to README.md" }));
    await view.findByRole("textbox", { name: "Editing preview of README.md" });
    fireEvent.click(view.getByRole("button", { name: "Show files" }));
    expect((search as HTMLInputElement).value).toBe("notes");
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    expect(await view.findByRole("button", { name: "Open files" })).toBe(switcher);
    fireEvent.click(view.getByRole("button", { name: "File actions" }));
    expect(view.getByRole("button", { name: "Download file" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close file" }));
    await view.findByRole("textbox", { name: "Editing preview of notes.md" });
    fireEvent.click(switcher);
    fireEvent.click(view.getByRole("button", { name: "Close notes.md" }));
    await waitFor(() => expect(view.queryByRole("button", { name: "Open files" })).toBeNull());
    expect(view.getByRole("textbox", { name: "Search files" })).toBe(search);
  });

  it("does not leave the file list when an earlier document read completes", async () => {
    TestResizeObserver.width = 390;
    let finishRead!: (reply: unknown) => void;
    const pendingRead = new Promise((resolve) => { finishRead = resolve; });
    const readFile = () => pendingRead;
    const view = responsiveFiles("# Hello", readFile);
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    fireEvent.click(await view.findByRole("button", { name: "Show files" }));
    const search = view.getByRole("textbox", { name: "Search files" });
    fireEvent.change(search, { target: { value: "notes" } });
    await act(async () => finishRead({ state: "text", path: "README.md", sha256: "sha", sizeBytes: 7, mimeType: "text/markdown", modifiedAtMs: 1, content: "# Hello" }));
    await view.findByText("Hello");
    expect(view.getByRole("textbox", { name: "Search files" })).toBe(search);
    expect((search as HTMLInputElement).value).toBe("notes");
    expect(view.queryByRole("button", { name: "Open files" })).toBeNull();
    expect(document.activeElement).toBe(search);
    fireEvent.click(view.getByRole("button", { name: "Return to document" }));
    expect((await view.findByRole("button", { name: "Open files" })).getAttribute("title")).toBe("README.md");
  });

  it("keeps an empty document editable and retains a draft when closing encounters a conflict", async () => {
    TestResizeObserver.width = 390;
    const view = responsiveFiles("");
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    const preview = await view.findByRole("textbox", { name: "Editing preview of README.md" });
    expect(view.getByRole("button", { name: "Open files" })).toBeTruthy();
    const paragraph = preview.querySelector("p")!;
    paragraph.textContent = "My draft";
    fireEvent.input(paragraph);
    await view.findByText("Unsaved");
    fireEvent.click(view.getByRole("button", { name: "Show files" }));
    fireEvent.click(view.getByRole("button", { name: "Return to document" }));
    expect(view.getByRole("textbox", { name: "Editing preview of README.md" })).toBe(preview);
    expect(preview.textContent).toContain("My draft");
    fireEvent.click(view.getByRole("button", { name: "File actions" }));
    fireEvent.click(view.getByRole("button", { name: "Close file" }));
    expect((await view.findByRole("alert")).textContent).toContain("Your draft is preserved");
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByRole("button", { name: "Open files" }).getAttribute("title")).toBe("README.md");
    expect(preview.textContent).toContain("My draft");
  });

  it("shows the preserved draft when closing a background mobile tab encounters a conflict", async () => {
    TestResizeObserver.width = 390;
    const view = responsiveFiles("");
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    await view.findByRole("textbox", { name: "Editing preview of README.md" });
    fireEvent.click(view.getByRole("button", { name: "Show files" }));
    fireEvent.click(view.getByRole("treeitem", { name: /notes\.md/ }));
    const preview = await view.findByRole("textbox", { name: "Editing preview of notes.md" });
    const paragraph = preview.querySelector("p")!;
    paragraph.textContent = "Background draft";
    fireEvent.input(paragraph);
    await view.findByText("Unsaved");
    fireEvent.click(view.getByRole("button", { name: "Open files" }));
    fireEvent.click(view.getByRole("button", { name: "Switch to README.md" }));
    expect(view.getByRole("button", { name: "Open files" }).getAttribute("title")).toBe("README.md");
    fireEvent.click(view.getByRole("button", { name: "Open files" }));
    fireEvent.click(view.getByRole("button", { name: "Close notes.md" }));
    expect((await view.findByRole("alert")).textContent).toContain("Your draft is preserved");
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByRole("button", { name: "Open files" }).getAttribute("title")).toBe("notes.md");
    expect(view.getByRole("textbox", { name: "Editing preview of notes.md" }).textContent).toContain("Background draft");
  });

  it("clamps the file tree on parent resize, restores preference and preserves panes across the breakpoint", async () => {
    const view = responsiveFiles();
    const row = await view.findByRole("treeitem", { name: /README\.md/ });
    const tree = view.container.querySelector("aside")!;
    const separator = view.getByRole("separator", { name: "Resize file tree" });
    fireEvent.keyDown(separator, { key: "End" });
    expect(tree.parentElement!.style.width).toBe("699px");
    act(() => TestResizeObserver.resize(739));
    expect(tree.parentElement!.style.width).toBe("538px");
    act(() => TestResizeObserver.resize(900));
    expect(tree.parentElement!.style.width).toBe("699px");
    fireEvent.click(row);
    await view.findByRole("textbox", { name: "Editing preview of README.md" });
    fireEvent.click(view.getByRole("button", { name: "Raw" }));
    const editor = await view.findByLabelText("Editing README.md");
    act(() => TestResizeObserver.resize(679));
    expect(view.getByLabelText("Editing README.md")).toBe(editor);
    expect(tree.parentElement!.style.display).toBe("none");
    fireEvent.click(view.getByRole("button", { name: "Show files" }));
    expect(tree.parentElement!.style.width).toBe("");
    act(() => TestResizeObserver.resize(680));
    expect(view.getByLabelText("Editing README.md")).toBe(editor);
    expect(tree).toBe(view.container.querySelector("aside"));
    expect(tree.parentElement!.style.width).toBe("479px");
    fireEvent.click(view.getByRole("button", { name: "Narrow file tree" }));
    expect(tree.parentElement!.style.width).toBe("439px");
    fireEvent.click(view.getByRole("button", { name: "Widen file tree" }));
    expect(tree.parentElement!.style.width).toBe("479px");
    const restoredSeparator = view.getByRole("separator", { name: "Resize file tree" });
    fireEvent.keyDown(restoredSeparator, { key: "Home" });
    expect(tree.parentElement!.style.width).toBe("150px");
    fireEvent.keyDown(restoredSeparator, { key: "ArrowLeft" });
    expect(tree.parentElement!.style.width).toBe("190px");
    fireEvent.keyDown(restoredSeparator, { key: "ArrowRight" });
    expect(tree.parentElement!.style.width).toBe("150px");
  });

  it("ends resizing on cancel, capture loss and breakpoint changes, and restores a hidden sidebar", async () => {
    const view = responsiveFiles();
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    await view.findByRole("textbox", { name: "Editing preview of README.md" });
    const panel = view.container.querySelector(".bb-files-panel")!;
    const tree = view.container.querySelector("aside")!;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ right: 900 } as DOMRect);
    let captured = false;
    const capture = {
      setPointerCapture: () => { captured = true; },
      hasPointerCapture: () => captured,
      releasePointerCapture: () => { captured = false; },
    };
    const separator = view.getByRole("separator", { name: "Resize file tree" });
    Object.assign(separator, capture);
    fireEvent.pointerDown(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 500 });
    expect(tree.parentElement!.style.width).toBe("400px");
    fireEvent.pointerCancel(separator, { pointerId: 1 });
    expect(captured).toBe(false);
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 200 });
    expect(tree.parentElement!.style.width).toBe("400px");
    fireEvent.pointerDown(separator, { pointerId: 1 });
    captured = false;
    fireEvent.lostPointerCapture(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 200 });
    expect(tree.parentElement!.style.width).toBe("400px");
    fireEvent.pointerDown(separator, { pointerId: 1 });
    act(() => TestResizeObserver.resize(679));
    act(() => TestResizeObserver.resize(900));
    const restoredSeparator = view.getByRole("separator", { name: "Resize file tree" });
    Object.assign(restoredSeparator, capture);
    fireEvent.pointerMove(restoredSeparator, { pointerId: 1, clientX: 200 });
    expect(tree.parentElement!.style.width).toBe("400px");
    fireEvent.pointerDown(restoredSeparator, { pointerId: 1 });
    fireEvent.pointerMove(restoredSeparator, { pointerId: 1, clientX: 850 });
    expect(tree.parentElement!.style.display).toBe("none");
    expect(captured).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Show sidebar" }));
    expect(tree.parentElement!.style.display).toBe("");
    expect(tree.parentElement!.style.width).toBe("400px");
  });

  it("registers one default flush thread action", () => {
    expect(getCapturedPluginApp().threadPanelActions).toEqual([
      expect.objectContaining({
        id: "files",
        title: "Files",
        icon: "FolderOpen",
        layout: "flush",
      }),
    ]);
    expect(getCapturedPluginApp().threadPanelActions[0]).not.toHaveProperty("run");
  });

  it("registers one left-sidebar panel that owns the global root route", () => {
    expect(getCapturedPluginApp().navPanels).toEqual([
      expect.objectContaining({
        id: "files",
        title: "Files",
        icon: "FolderOpen",
        path: "files",
      }),
    ]);
  });

  it("reads the host root from the sidebar panel, which has no thread", async () => {
    setBbContext({ projectId: null, threadId: null });
    const listDirectory = vi.fn(() => ({
      path: "",
      rootName: "Home",
      entries: [],
      annotateAvailable: false,
      sqlAvailable: false,
    }));
    setRpcHandlers({ listDirectory });
    const view = render(<FilesPanel subPath="" />);

    await view.findByText("This folder is empty.");
    // A thread-less route used to be refused outright; the sidebar panel must
    // read the host root instead, and name it after the scope rather than after
    // a directory segment.
    expect(view.queryByRole("alert")).toBeNull();
    expect(await view.findByText("Home")).toBeTruthy();
    expect(listDirectory).toHaveBeenCalledWith({
      scope: { kind: "host" },
      path: "",
    });
  });

  it("registers itself as BB's file opener for the editable extensions", () => {
    const openers = getCapturedPluginApp().fileOpeners;
    expect(openers).toHaveLength(1);
    expect(openers[0]).toEqual(
      expect.objectContaining({ id: "files", title: "Files" }),
    );
    expect(openers[0].extensions).toEqual(FILE_OPENER_EXTENSIONS);
    expect(FILE_OPENER_EXTENSIONS.length).toBeGreaterThan(0);
    for (const extension of FILE_OPENER_EXTENSIONS) {
      expect(extension).toBe(extension.toLowerCase());
      expect(extension).not.toContain(".");
    }
    expect(FILE_OPENER_EXTENSIONS).toContain("md");
  });

  it("uploads files selected from the local file picker", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      return url.endsWith("/token") // ubs:ignore — test route suffix and fixture value are not credentials
        ? new Response(JSON.stringify({ token: "plugin-token" }), { // ubs:ignore — inert test fixture
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(
            JSON.stringify({ path: "photo.png", sha256: "sha", sizeBytes: 3 }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
    });
    vi.stubGlobal("fetch", fetchMock);
    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "repo",
        entries: [],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    await view.findByText("This folder is empty.");

    fireEvent.click(view.getByRole("button", { name: "Upload files" }));
    const file = new File(["png"], "photo.png", { type: "image/png" });
    fireEvent.change(view.getByLabelText("Choose files to upload"), {
      target: { files: [file] },
    });

    expect(await view.findByText("Uploaded 1 file to the root.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/api/v1/plugins/files/http/upload?scope=thread&threadId=thread-1&directory=&fileName=photo.png",
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: file,
    });
  });

  it("uploads dropped files into the target folder", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      return url.endsWith("/token") // ubs:ignore — test route suffix and fixture value are not credentials
        ? new Response(JSON.stringify({ token: "plugin-token" }), { // ubs:ignore — inert test fixture
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(
            JSON.stringify({ path: "assets/notes.md", sha256: "sha", sizeBytes: 5 }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
    });
    vi.stubGlobal("fetch", fetchMock);
    setRpcHandlers({
      listDirectory: (input) => {
        const path = (input as { path: string }).path;
        return {
          path,
          rootName: "repo",
          entries: path.length === 0
            ? [
                {
                  kind: "directory" as const,
                  path: "assets",
                  name: "assets",
                  score: 0,
                  positions: [],
                },
              ]
            : [],
          annotateAvailable: false,
          sqlAvailable: false,
        };
      },
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    const folder = await view.findByRole("treeitem", { name: /assets/ });
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });
    const dataTransfer = { files: [file], types: ["Files"], dropEffect: "none" };

    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });

    expect(await view.findByText("Uploaded 1 file to assets.")).toBeTruthy();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "directory=assets&fileName=notes.md",
    );
  });

  it("opens Markdown in an editable Preview and exposes Raw", async () => {
    const content = "# Project\n\nOriginal body.";
    const saveFile = vi.fn((_input: unknown) => ({
      outcome: "written" as const,
      sha256: "sha-2",
      sizeBytes: content.length,
    }));
    setRpcHandlers({
      saveFile,
      listDirectory: () => ({
        path: "",
        rootName: "repo",
        entries: [
          {
            kind: "file",
            path: "README.md",
            name: "README.md",
            score: 0,
            positions: [],
          },
        ],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      readFile: () => ({
        state: "text",
        path: "README.md",
        sha256: "sha-1",
        sizeBytes: content.length,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content,
      }),
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);

    const row = await view.findByRole("treeitem", { name: /README\.md/ });
    fireEvent.click(row);
    const raw = await view.findByRole("button", { name: "Raw" });
    const preview = await view.findByRole("textbox", {
      name: "Editing preview of README.md",
    });
    expect(preview.textContent).toContain("Project");
    const body = await view.findByText("Original body.");
    body.textContent = "Updated body.";
    fireEvent.input(body);
    expect(await view.findByText("Unsaved")).toBeTruthy();
    fireEvent.keyDown(preview, { key: "s", metaKey: true });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(saveFile.mock.calls.at(-1)?.[0]).toMatchObject({
      content: "# Project\n\nUpdated body.",
    });
    fireEvent.click(raw);
    expect(await view.findByLabelText("Editing README.md")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Open in Annotate" })).toBeNull();
  });

  it("reopens markdown with the preferred BB file viewer", async () => {
    const openFile = vi.fn(() => ({ delivered: 1 }));
    setRpcHandlers({
      openFile,
      listDirectory: () => ({
        path: "",
        rootName: "repo",
        entries: [
          {
            kind: "file",
            path: "README.md",
            name: "README.md",
            score: 0,
            positions: [],
          },
        ],
        annotateAvailable: true, sqlAvailable: false,
      }),
      readFile: () => ({
        state: "text",
        path: "README.md",
        sha256: "sha-1",
        sizeBytes: 9,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "# Project",
      }),
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);

    fireEvent.click(
      await view.findByRole("treeitem", { name: /README\.md/ }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Open in Annotate" }),
    );

    expect(openFile).toHaveBeenCalledWith({
      scope: { kind: "thread", threadId: "thread-1" },
      path: "README.md",
    });
  });

  it("opens .excalidraw files as a drawing instead of source JSON", async () => {
    const content = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {},
    });
    const saveFile = vi.fn(() => ({
      outcome: "written" as const,
      sha256: "saved-scene-sha",
      sizeBytes: content.length,
    }));
    setRpcHandlers({
      listDirectory: () => ({
        path: "",
        rootName: "repo",
        entries: [
          {
            kind: "file",
            path: "AI+MAN.excalidraw",
            name: "AI+MAN.excalidraw",
            score: 0,
            positions: [],
          },
        ],
        annotateAvailable: false,
        sqlAvailable: false,
      }),
      readFile: () => ({
        state: "text",
        path: "AI+MAN.excalidraw",
        sha256: "scene-sha",
        sizeBytes: content.length,
        mimeType: "application/json",
        modifiedAtMs: 1,
        content,
      }),
      saveFile,
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);

    fireEvent.click(
      await view.findByRole("treeitem", { name: /AI\+MAN\.excalidraw/ }),
    );
    expect(await view.findByTestId("mock-files-excalidraw")).toBeTruthy();
    expect(view.queryByLabelText("Editing AI+MAN.excalidraw")).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("restores open tabs after the Files panel remounts", async () => {
    const { useFilesWorkspace } = await import(
      "./src/hooks/useFilesWorkspace"
    );
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: unknown) => {
        const path =
          typeof input === "object" &&
          input !== null &&
          "path" in input &&
          typeof input.path === "string"
            ? input.path
            : "";
        return {
          state: "text",
          path,
          sha256: `sha-${path}`,
          sizeBytes: path.length,
          mimeType: "text/plain",
          modifiedAtMs: 1,
          content: `content:${path}`,
        };
      },
    });

    setBbContext({ projectId: null, threadId: "thread-restore" });
    const first = renderHook(() => useFilesWorkspace());
    await act(async () => {
      await first.result.current.openPath("README.md");
      await first.result.current.openPath("src/app.tsx");
    });
    act(() => first.result.current.setActiveTabId(first.result.current.tabs.find((tab) => tab.path === "README.md")!.id));

    await waitFor(() => {
      expect(window.localStorage.getItem('bb-plugin-files:workspace:{"kind":"thread","threadId":"thread-restore"}')).toContain("src/app.tsx");
    });
    first.unmount();

    const second = renderHook(() => useFilesWorkspace());
    expect(second.result.current.tabs.map((tab) => tab.path)).toEqual([
      "README.md",
      "src/app.tsx",
    ]);
    expect(second.result.current.activeTab?.path).toBe("README.md");
    await waitFor(() => {
      expect(second.result.current.tabs.every((tab) => tab.file !== null)).toBe(true);
    });
  });

  it("keeps identical paths separate across host roots", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: unknown) => ({ state: "text", path: (input as { path: string }).path, sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "x" }),
    });
    setBbContext({ projectId: "project-a", threadId: "thread-1" });
    const first = renderHook(() => useFilesWorkspace(null, { kind: "host", hostId: "host-a", rootPath: "/repo" }));
    const second = renderHook(() => useFilesWorkspace(null, { kind: "host", hostId: "host-b", rootPath: "/repo" }));
    await act(async () => { await first.result.current.openPath("README.md"); await second.result.current.openPath("README.md"); });
    expect(first.result.current.tabs[0].id).not.toBe(second.result.current.tabs[0].id);
    expect(first.result.current.tabs).toHaveLength(1);
    expect(second.result.current.tabs).toHaveLength(1);
  });

  it.each([
    { kind: "host" as const, threadId: "thread-1", environmentId: null, projectId: null },
    { kind: "workspace" as const, threadId: "thread-1", environmentId: "foreign-environment", projectId: null },
    { kind: "workspace" as const, threadId: "thread-1", environmentId: null, projectId: "foreign-project" },
  ])("does not authorize file-opener sources without a host context", async (source) => {
    const listDirectory = vi.fn();
    const readFile = vi.fn();
    setBbContext({ projectId: null, threadId: null });
    setRpcHandlers({ listDirectory, readFile });
    render(
      <FilesPanel path="README.md" source={source} Original={() => null} />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(listDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("re-roots a pinned foreign host link without active-thread routing", async () => {
    const resolveOpenerFile = vi.fn(() => ({
      kind: "file",
      scope: { kind: "host", hostId: "host-7", rootPath: "/home/ada" },
      path: ".zshrc",
    }));
    const listDirectory = vi.fn(() => ({
      path: "",
      rootName: "ada",
      entries: [
        { kind: "file", path: ".zshrc", name: ".zshrc", score: 0, positions: [] },
      ],
      annotateAvailable: false,
      sqlAvailable: false,
    }));
    const readFile = vi.fn(() => ({
      state: "text",
      path: ".zshrc",
      sha256: "sha-1",
      sizeBytes: 15,
      mimeType: null,
      modifiedAtMs: 1,
      content: "export EDITOR=vi",
    }));
    setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
    setBbContext({ projectId: "project-a", threadId: "active-thread" });
    const navigationCallCount = getOpenThreadPanelCalls();

    const view = render(
      <FilesPanel
        path="/home/ada/.zshrc"
        source={{
          kind: "host",
          threadId: "foreign-thread",
          environmentId: "env-1",
          projectId: "project-a",
          experimental_hostId: "host-7",
        }}
        Original={() => null}
      />,
    );
    await view.findByRole("treeitem", { name: /\.zshrc/ });

    // The link's own directory — not the whole machine, and not the thread
    // workspace — is the root the panel reads the file through.
    expect(resolveOpenerFile).toHaveBeenCalledWith({
      source: {
        kind: "host",
        threadId: "foreign-thread",
        experimental_hostId: "host-7",
      },
      path: "/home/ada/.zshrc",
    });
    expect(listDirectory).toHaveBeenCalledWith({
      scope: { kind: "host", hostId: "host-7", rootPath: "/home/ada" },
      path: "",
    });
    expect(readFile).toHaveBeenCalledWith({
      scope: { kind: "host", hostId: "host-7", rootPath: "/home/ada" },
      path: ".zshrc",
    });
    expect(view.queryByRole("alert")).toBeNull();
    expect(getOpenThreadPanelCalls()).toBe(navigationCallCount);
  });

  it("opens a host source when no thread is active", async () => {
    const resolveOpenerFile = vi.fn(() => ({
      kind: "file",
      scope: { kind: "host", hostId: "host-7", rootPath: "/repo" },
      path: "src/index.ts",
    }));
    const listDirectory = vi.fn(() => ({
      path: "",
      rootName: "repo",
      entries: [{ kind: "directory", path: "src", name: "src", score: 0, positions: [] }],
      annotateAvailable: false,
      sqlAvailable: false,
    }));
    const readFile = vi.fn(() => ({
      state: "text",
      path: "src/index.ts",
      sha256: "sha-1",
      sizeBytes: 13,
      mimeType: "text/plain",
      modifiedAtMs: 1,
      content: "export const x = 1;",
    }));
    setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
    setBbContext({ projectId: null, threadId: null });

    const view = render(
      <FilesPanel
        path="/repo/src/index.ts"
        source={{ kind: "host", threadId: null, environmentId: null, projectId: null }}
        Original={() => null}
      />,
    );
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({
      scope: { kind: "host", hostId: "host-7", rootPath: "/repo" },
      path: "src/index.ts",
    }));
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("retains thread-storage ownership for reads and preview links", async () => {
    const resolveOpenerFile = vi.fn(() => ({
      kind: "file",
      scope: { kind: "thread-storage", threadId: "thread-1" },
      path: "prototypes/pi-subagents-v2.html",
    }));
    const listDirectory = vi.fn(() => ({
      path: "",
      rootName: "thread-1",
      entries: [],
      annotateAvailable: false,
      sqlAvailable: false,
    }));
    const readFile = vi.fn(() => ({
      state: "text",
      path: "prototypes/pi-subagents-v2.html",
      sha256: "sha-1",
      sizeBytes: 14,
      mimeType: "text/html",
      modifiedAtMs: 1,
      content: "<img src='./asset.png'>",
    }));
    setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
    setBbContext({ projectId: "other-project", threadId: null });

    render(
      <FilesPanel
        path="prototypes/pi-subagents-v2.html"
        source={{ kind: "thread-storage", threadId: "thread-1", environmentId: "env-1", projectId: null }}
        Original={() => null}
      />,
    );
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({
      scope: { kind: "thread-storage", threadId: "thread-1" },
      path: "prototypes/pi-subagents-v2.html",
    }));
    expect(listDirectory).toHaveBeenCalledWith({
      scope: { kind: "thread-storage", threadId: "thread-1" },
      path: "prototypes",
    });
  });

  it("keeps a foreign workspace opener out of the active thread's Files bus", async () => {
    const resolveOpenerFile = vi.fn(() => ({
      kind: "file",
      scope: { kind: "thread", threadId: "foreign-thread" },
      path: "src/foreign.ts",
    }));
    const listDirectory = vi.fn(() => ({
      path: "src",
      entries: [{ kind: "file", path: "src/foreign.ts", name: "foreign.ts", score: 0, positions: [] }],
    }));
    const readFile = vi.fn(() => ({
      state: "text",
      path: "src/foreign.ts",
      sha256: "sha-1",
      sizeBytes: 1,
      mimeType: "text/plain",
      modifiedAtMs: 1,
      content: "x",
    }));
    setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
    setBbContext({ projectId: "active-project", threadId: "active-thread" });
    const navigationCalls = getOpenThreadPanelCalls();

    render(
      <FilesPanel
        path="src/foreign.ts"
        source={{ kind: "workspace", threadId: "foreign-thread", environmentId: null, projectId: null }}
        Original={() => null}
      />,
    );
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({
      scope: { kind: "thread", threadId: "foreign-thread" },
      path: "src/foreign.ts",
    }));
    expect(resolveOpenerFile).toHaveBeenCalled();
    expect(getOpenThreadPanelCalls()).toBe(navigationCalls);
  });

  it("ignores stale host-link resolution after a newer file is requested", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    const resolveOpenerFile = vi.fn((input: unknown) => new Promise((resolve) => {
      const path = (input as { path: string }).path;
      resolvers.set(path, resolve);
    }));
    const readFile = vi.fn((input: unknown) => ({
      state: "text",
      path: (input as { path: string }).path,
      sha256: "sha-1",
      sizeBytes: 1,
      mimeType: "text/plain",
      modifiedAtMs: 1,
      content: "x",
    }));
    const listDirectory = vi.fn(() => ({ path: "", entries: [] }));
    setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
    setBbContext({ projectId: null, threadId: null });
    const source = { kind: "host" as const, threadId: null, environmentId: null, projectId: null };
    const view = render(<FilesPanel path="/repo/first.ts" source={source} Original={() => null} />);
    await waitFor(() => expect(resolveOpenerFile).toHaveBeenCalledTimes(1));
    view.rerender(<FilesPanel path="/repo/second.ts" source={source} Original={() => null} />);
    await waitFor(() => expect(resolveOpenerFile).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolvers.get("/repo/first.ts")?.({
        kind: "file",
        scope: { kind: "host", hostId: "host-old", rootPath: "/old" },
        path: "first.ts",
      });
      resolvers.get("/repo/second.ts")?.({
        kind: "file",
        scope: { kind: "host", hostId: "host-current", rootPath: "/repo" },
        path: "second.ts",
      });
    });
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({
      scope: { kind: "host", hostId: "host-current", rootPath: "/repo" },
      path: "second.ts",
    }));
    expect(readFile).not.toHaveBeenCalledWith({
      scope: { kind: "host", hostId: "host-old", rootPath: "/old" },
      path: "first.ts",
    });
  });

  it("hides a resolved target while its source changes and preserves same-root drafts", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    const resolveOpenerFile = vi.fn((input: unknown) => new Promise((resolve) => {
      const threadId = (input as { source: { threadId: string } }).source.threadId;
      resolvers.set(threadId, resolve);
    }));
    const listDirectory = vi.fn(() => ({
      path: "",
      rootName: "repo",
      entries: [
        { kind: "file", path: "first.md", name: "first.md", score: 0, positions: [] },
        { kind: "file", path: "second.md", name: "second.md", score: 0, positions: [] },
      ],
      annotateAvailable: false,
      sqlAvailable: false,
    }));
    const readFile = vi.fn((input: unknown) => {
      const path = (input as { path: string }).path;
      const content = path === "first.md" ? "# First\n\nOriginal body." : "# Second\n\nSecond body.";
      return {
        state: "text",
        path,
        sha256: path,
        sizeBytes: content.length,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content,
      };
    });
    setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
    setBbContext({ projectId: null, threadId: null });
    const firstSource = {
      kind: "host" as const,
      threadId: "source-first",
      environmentId: null,
      projectId: null,
      experimental_hostId: "host-shared",
    };
    const view = render(
      <FilesPanel path="/repo/first.md" source={firstSource} Original={() => null} />,
    );
    await waitFor(() => expect(resolveOpenerFile).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolvers.get("source-first")?.({
        kind: "file",
        scope: { kind: "host", hostId: "host-shared", rootPath: "/repo" },
        path: "first.md",
      });
    });
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({
      scope: { kind: "host", hostId: "host-shared", rootPath: "/repo" },
      path: "first.md",
    }));
    const body = await view.findByText("Original body.");
    body.textContent = "Edited draft.";
    fireEvent.input(body);
    expect(await view.findByText("Unsaved")).toBeTruthy();

    view.rerender(
      <FilesPanel
        path="/repo/second.md"
        source={{ ...firstSource, threadId: "source-second" }}
        Original={() => null}
      />,
    );
    await waitFor(() => expect(resolveOpenerFile).toHaveBeenCalledTimes(2));
    expect((await view.findByRole("status")).textContent).toContain("Opening file");
    expect(view.queryByRole("treeitem", { name: /first\.md/ })).toBeNull();
    await act(async () => {
      resolvers.get("source-second")?.({
        kind: "file",
        scope: { kind: "host", hostId: "host-shared", rootPath: "/repo" },
        path: "second.md",
      });
    });
    await waitFor(() => expect(readFile).toHaveBeenCalledWith({
      scope: { kind: "host", hostId: "host-shared", rootPath: "/repo" },
      path: "second.md",
    }));
    expect(await view.findByRole("textbox", {
      name: "Editing preview of second.md",
    })).toBeTruthy();

    fireEvent.click(view.getAllByText("first.md", { selector: "span" })[0]!);
    const firstPreview = await view.findByRole("textbox", {
      name: "Editing preview of first.md",
    });
    expect(firstPreview.textContent).toContain("Edited draft.");
  });

  it.each(["success", "failure"] as const)(
    "ignores the earlier A→B→A %s after the newest A resolves",
    async (oldOutcome) => {
      const pending: {
        threadId: string;
        resolve(value: unknown): void;
        reject(reason: unknown): void;
      }[] = [];
      const resolveOpenerFile = vi.fn((input: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const threadId = (input as { source: { threadId: string } }).source.threadId;
          pending.push({ threadId, resolve, reject });
        }),
      );
      const listDirectory = vi.fn(() => ({ path: "", rootName: "repo", entries: [] }));
      const readFile = vi.fn((input: unknown) => {
        const path = (input as { path: string }).path;
        const content = `# ${path}\\n\\nBody.`;
        return {
          state: "text",
          path,
          sha256: path,
          sizeBytes: content.length,
          mimeType: "text/markdown",
          modifiedAtMs: 1,
          content,
        };
      });
      setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
      setBbContext({ projectId: null, threadId: null });
      const sourceA = {
        kind: "host" as const,
        threadId: "source-a",
        environmentId: null,
        projectId: null,
        experimental_hostId: "host-pinned",
      };
      const sourceB = { ...sourceA, threadId: "source-b" };
      const renderSource = (source: typeof sourceA, path: string) => (
        <StrictMode>
          <FilesPanel path={path} source={source} Original={() => null} />
        </StrictMode>
      );
      const view = render(renderSource(sourceA, "/repo/a.md"));
      await waitFor(() => expect(pending).toHaveLength(1));
      view.rerender(renderSource(sourceB, "/repo/b.md"));
      await waitFor(() => expect(pending).toHaveLength(2));
      view.rerender(renderSource(sourceA, "/repo/a.md"));
      await waitFor(() => expect(pending).toHaveLength(3));

      await act(async () => {
        pending[2]!.resolve({
          kind: "file",
          scope: { kind: "host", hostId: "host-pinned", rootPath: "/repo" },
          path: "current.md",
        });
      });
      expect(await view.findByRole("textbox", { name: "Editing preview of current.md" })).toBeTruthy();
      await act(async () => {
        pending[1]!.resolve({
          kind: "file",
          scope: { kind: "host", hostId: "host-pinned", rootPath: "/b" },
          path: "stale-b.md",
        });
      });

      await act(async () => {
        if (oldOutcome === "success") {
          pending[0]!.resolve({
            kind: "file",
            scope: { kind: "host", hostId: "host-pinned", rootPath: "/old" },
            path: "stale-a.md",
          });
        } else {
          pending[0]!.reject(new Error("stale A failed"));
        }
      });

      expect(view.getByRole("textbox", { name: "Editing preview of current.md" })).toBeTruthy();
      expect(view.queryByRole("alert")).toBeNull();
      expect(readFile).not.toHaveBeenCalledWith({
        scope: { kind: "host", hostId: "host-pinned", rootPath: "/old" },
        path: "stale-a.md",
      });
    },
  );

  it("refuses a link the server cannot place instead of reading an unrelated file", async () => {
    const resolveOpenerFile = vi.fn(() => ({
      kind: "unsupported",
      reason: "thread-storage",
    }));
    const listDirectory = vi.fn();
    const readFile = vi.fn();
    setRpcHandlers({ resolveOpenerFile, listDirectory, readFile });
    setBbContext({ projectId: "project-a", threadId: "thread-1" });

    const view = render(
      <FilesPanel
        path="notes/todo.md"
        source={{
          kind: "thread-storage",
          threadId: "thread-1",
          environmentId: "env-1",
          projectId: "project-a",
        }}
        Original={() => null}
      />,
    );
    await view.findByRole("alert");

    expect(listDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("opens a workspace file link without asking the server where it lives", async () => {
    const resolveOpenerFile = vi.fn();
    const listDirectory = vi.fn(() => ({
      path: "",
      rootName: "repo",
      entries: [],
      annotateAvailable: false,
      sqlAvailable: false,
    }));
    setRpcHandlers({
      resolveOpenerFile,
      listDirectory,
      readFile: vi.fn(() => ({
        state: "text",
        path: "README.md",
        sha256: "sha-1",
        sizeBytes: 6,
        mimeType: null,
        modifiedAtMs: 1,
        content: "# Docs",
      })),
    });
    setBbContext({ projectId: "project-a", threadId: "thread-1" });

    render(
      <FilesPanel
        path="README.md"
        source={{
          kind: "workspace",
          threadId: "thread-1",
          environmentId: "env-1",
          projectId: "project-a",
        }}
        Original={() => null}
      />,
    );
    await waitFor(() =>
      expect(listDirectory).toHaveBeenCalledWith({
        scope: { kind: "thread", threadId: "thread-1" },
        path: "",
      }),
    );
    expect(resolveOpenerFile).not.toHaveBeenCalled();
  });

  it("fails closed for unauthorized callback invocations", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    const handlers = { openFile: vi.fn(), saveFile: vi.fn(), createFile: vi.fn(), createDirectory: vi.fn(), movePath: vi.fn(), removePath: vi.fn(), readFile: vi.fn(), listDirectory: vi.fn() };
    setRpcHandlers(handlers);
    setBbContext({ projectId: null, threadId: null });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      await hook.result.current.openInPreferredViewer("README.md");
      await hook.result.current.save("README.md");
      await hook.result.current.createFile("README.md");
      await hook.result.current.createDirectory("src");
      await hook.result.current.movePath("README.md", "src/README.md");
      await hook.result.current.removePath("README.md", false);
    });
    expect(Object.values(handlers).every((handler) => handler.mock.calls.length === 0)).toBe(true);
  });

  it("migrates the selected legacy tab and isolates ambiguous legacy hosts", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    const source = {
      kind: "workspace",
      threadId: "thread-migration",
      environmentId: "env-1",
      projectId: "project-1",
    };
    const legacyRecord = (path: string) => ({ version: 1, source, path });
    const activeLegacyId = JSON.stringify([
      1,
      source.kind,
      source.threadId,
      source.environmentId,
      source.projectId,
      "src/second.ts",
    ]);
    window.localStorage.setItem(
      'bb-plugin-files:workspace:{"kind":"thread","threadId":"thread-migration"}',
      JSON.stringify({
        version: 2,
        openFiles: [legacyRecord("src/first.ts"), legacyRecord("src/second.ts")],
        activeFileId: activeLegacyId,
      }),
    );
    setBbContext({ projectId: "project-1", threadId: "thread-migration" });
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [] }),
      readFile: (input: unknown) => {
        const path = (input as { path: string }).path;
        return { state: "text", path, sha256: path, sizeBytes: 1, mimeType: null, modifiedAtMs: 1, content: path };
      },
    });

    const threadHook = renderHook(() =>
      useFilesWorkspace(null, { kind: "thread", threadId: "thread-migration" }),
    );
    expect(threadHook.result.current.tabs.map((tab) => tab.path)).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    expect(threadHook.result.current.activeTab?.path).toBe("src/second.ts");

    const oldHostRecord = {
      version: 1,
      source: {
        kind: "host",
        threadId: null,
        environmentId: "env-1",
        projectId: "/repo",
      },
      path: "src/old.ts",
    };
    window.localStorage.setItem(
      'bb-plugin-files:workspace:{"kind":"host","rootPath":"/repo"}',
      JSON.stringify({
        version: 2,
        openFiles: [oldHostRecord],
        activeFileId: JSON.stringify([1, "host", null, "env-1", "/repo", "src/old.ts"]),
      }),
    );
    const hostHook = renderHook(() =>
      useFilesWorkspace(null, { kind: "host", rootPath: "/repo" }),
    );
    expect(hostHook.result.current.tabs).toEqual([]);
  });

  it("does not import legacy thread-only state", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    window.localStorage.setItem("bb-plugin-files:workspace:thread-1", JSON.stringify({ version: 1, openPaths: ["README.md", "src/../bad", "x".repeat(4097)], activePath: "README.md" }));
    setBbContext({ projectId: "project-a", threadId: "thread-1" });
    const first = renderHook(() => useFilesWorkspace());
    expect(first.result.current.tabs).toEqual([]);
    expect(window.localStorage.getItem("bb-plugin-files:workspace:thread-1")).not.toBeNull();
    first.unmount();
    setBbContext({ projectId: "project-b", threadId: "thread-1" });
    const second = renderHook(() => useFilesWorkspace());
    expect(second.result.current.tabs).toEqual([]);
  });

  it("focuses an existing tab for the same source and path", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({ listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }), readFile: () => ({ state: "text", path: "README.md", sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "x" }) });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => { await hook.result.current.openPath("README.md"); await hook.result.current.openPath("README.md"); });
    expect(hook.result.current.tabs).toHaveLength(1);
  });

  it("drops forged source records from v2 persistence", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    window.localStorage.setItem('bb-plugin-files:workspace:["thread-1","environment-a","project-a"]', JSON.stringify({ version: 2, openFiles: [{ version: 1, source: { kind: "workspace", threadId: "thread-1", environmentId: "forged", projectId: "project-a" }, path: "README.md" }], activeFileId: "forged" }));
    setBbContext({ projectId: "project-a", threadId: "thread-1" });
    const hook = renderHook(() => useFilesWorkspace());
    expect(hook.result.current.tabs).toEqual([]);
  });

  it("resets panel state when the trusted host source changes", async () => {
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [{ kind: "file", path: "README.md", name: "README.md", score: 0, positions: [] }], annotateAvailable: false, sqlAvailable: false }),
      readFile: () => ({ state: "text", path: "README.md", sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "x" }),
    });
    const view = render(<FilesPanel threadId="thread-1" params={null} />);
    fireEvent.click(await view.findByRole("treeitem", { name: /README\.md/ }));
    expect(await view.findByRole("button", { name: "Raw" })).toBeTruthy();
    setBbContext({ projectId: "project-2", threadId: "thread-2" });
    view.rerender(<FilesPanel threadId="thread-1" params={null} />);
    await waitFor(() => expect(view.queryByRole("button", { name: "Raw" })).toBeNull());
  });

  it("evicts the oldest clean tab while retaining the requested open file", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: unknown) => {
        const path = (input as { path: string }).path;
        return { state: "text", path, sha256: path, sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: path };
      },
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await hook.result.current.openPath(`src/${index}.ts`);
    });
    await waitFor(() => expect(hook.result.current.tabs.every((tab) => !tab.loading)).toBe(true));
    await act(async () => expect(await hook.result.current.openPath("src/20.ts")).toBe(true));
    expect(hook.result.current.tabs).toHaveLength(20);
    expect(hook.result.current.tabs.map((tab) => tab.path)).not.toContain("src/0.ts");
    expect(hook.result.current.tabs.map((tab) => tab.path)).toContain("src/20.ts");
    expect(hook.result.current.activeTab?.path).toBe("src/20.ts");
  });

  it("does not evict the oldest dirty tab", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: unknown) => ({ state: "text", path: (input as { path: string }).path, sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "saved" }),
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await hook.result.current.openPath(`src/${index}.ts`);
    });
    await waitFor(() => expect(hook.result.current.tabs.every((tab) => !tab.loading)).toBe(true));
    act(() => hook.result.current.setDraftText(hook.result.current.tabs[0].id, "dirty"));
    await act(async () => expect(await hook.result.current.openPath("src/requested.ts")).toBe(true));
    expect(hook.result.current.tabs.map((tab) => tab.path)).toContain("src/0.ts");
    expect(hook.result.current.tabs.map((tab) => tab.path)).not.toContain("src/1.ts");
    expect(hook.result.current.tabs.map((tab) => tab.path)).toContain("src/requested.ts");
  });

  it("does not evict the oldest CAS-conflicted tab", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: unknown) => ({ state: "text", path: (input as { path: string }).path, sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "saved" }),
      saveFile: () => ({ outcome: "conflict", currentSha256: "new-sha" }),
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await hook.result.current.openPath(`src/${index}.ts`);
    });
    await waitFor(() => expect(hook.result.current.tabs.every((tab) => !tab.loading)).toBe(true));
    act(() => hook.result.current.setDraftText(hook.result.current.tabs[0].id, "dirty"));
    await act(async () => expect(await hook.result.current.save(hook.result.current.tabs[0].id)).toBe(false));
    await act(async () => expect(await hook.result.current.openPath("src/requested.ts")).toBe(true));
    expect(hook.result.current.tabs.find((tab) => tab.path === "src/0.ts")?.saveState.kind).toBe("conflict");
    expect(hook.result.current.tabs.map((tab) => tab.path)).not.toContain("src/1.ts");
  });

  it("rejects an open without evicting when all tabs have unsaved changes", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: unknown) => ({ state: "text", path: (input as { path: string }).path, sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "saved" }),
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      for (let index = 0; index < 20; index += 1) await hook.result.current.openPath(`src/${index}.ts`);
    });
    await waitFor(() => expect(hook.result.current.tabs.every((tab) => !tab.loading)).toBe(true));
    act(() => {
      for (let index = 0; index < 20; index += 1) hook.result.current.setDraftText(hook.result.current.tabs[index].id, "dirty");
    });
    await act(async () => expect(await hook.result.current.openPath("src/requested.ts")).toBe(false));
    expect(hook.result.current.tabs).toHaveLength(20);
    expect(hook.result.current.tabs.map((tab) => tab.path)).not.toContain("src/requested.ts");
    expect(hook.result.current.treeError).toMatch(/Cannot open src\/requested\.ts/);
  });

  it("migrates descendant tabs and the active path after a directory rename", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: (input: unknown) => {
        const path = (input as { path: string }).path;
        return { state: "text", path, sha256: path, sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: path };
      },
      movePath: () => undefined,
    });
    const hook = renderHook(() => useFilesWorkspace());
    await act(async () => {
      await hook.result.current.openPath("src/a.ts");
      await hook.result.current.openPath("src/nested/b.ts");
      await hook.result.current.movePath("src", "lib");
    });
    expect(hook.result.current.tabs.map((tab) => tab.path)).toEqual(["lib/a.ts", "lib/nested/b.ts"]);
    expect(hook.result.current.activeTab?.path).toBe("lib/nested/b.ts");
  });

  it("preserves a dirty draft and reports a CAS conflict", async () => {
    const { useFilesWorkspace } = await import(
      "./src/hooks/useFilesWorkspace"
    );
    setRpcHandlers({
      listDirectory: () => ({ path: "", rootName: "repo", entries: [], annotateAvailable: false, sqlAvailable: false }),
      readFile: () => ({
        state: "text",
        path: "README.md",
        sha256: "sha-old",
        sizeBytes: 3,
        mimeType: "text/markdown",
        modifiedAtMs: 1,
        content: "old",
      }),
      saveFile: () => ({ outcome: "conflict", currentSha256: "sha-new" }),
    });
    const { renderHook } = await import("@testing-library/react");
    const hook = renderHook(() => useFilesWorkspace());

    await act(async () => {
      await hook.result.current.openPath("README.md");
    });
    act(() => hook.result.current.setDraftText(hook.result.current.tabs[0].id, "my draft"));
    await act(async () => {
      expect(await hook.result.current.save(hook.result.current.tabs[0].id)).toBe(false);
    });

    await waitFor(() => {
      expect(hook.result.current.tabs.find(t => t.path === "README.md")?.saveState).toEqual({
        kind: "conflict",
        currentSha256: "sha-new",
      });
    });
    expect(hook.result.current.tabs.find(t => t.path === "README.md")?.draftText).toBe("my draft");
    expect(hook.result.current.activeTab?.path).toBe("README.md");
  });

  it("lazily loads a directory's children on expand and drops them on collapse", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    const listDirectory = vi.fn((input: unknown) => {
      const path = (input as { path: string }).path;
      if (path === "") {
        return {
          path: "",
          rootName: "repo",
          annotateAvailable: false, sqlAvailable: false,
          entries: [{ kind: "directory", path: "src", name: "src", score: 0, positions: [] }],
        };
      }
      if (path === "src") {
        return {
          path: "src",
          entries: [{ kind: "file", path: "src/a.ts", name: "a.ts", score: 0, positions: [] }],
        };
      }
      throw new Error(`unexpected listDirectory path: ${path}`);
    });
    setRpcHandlers({ listDirectory });
    const hook = renderHook(() => useFilesWorkspace());

    await waitFor(() => {
      expect(hook.result.current.entries.map((entry) => entry.path)).toEqual(["src"]);
    });
    expect(hook.result.current.expandedDirs.has("src")).toBe(false);

    await act(async () => {
      hook.result.current.toggleDirectory("src");
    });
    await waitFor(() => {
      expect(hook.result.current.entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(["src", "src/a.ts"]),
      );
    });
    expect(hook.result.current.expandedDirs.has("src")).toBe(true);
    expect(listDirectory).toHaveBeenCalledWith(expect.objectContaining({ path: "src" }));

    // Collapsing drops the fetched children from state instead of merely
    // hiding them, so re-expanding fetches fresh data.
    act(() => hook.result.current.toggleDirectory("src"));
    expect(hook.result.current.expandedDirs.has("src")).toBe(false);
    expect(hook.result.current.entries.map((entry) => entry.path)).toEqual(["src"]);
  });
});
