// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPanel } from "./app";
import {
  getCapturedPluginApp,
  setRpcHandlers,
} from "./test/plugin-sdk-app-runtime";

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback(
      [{ contentRect: { width: 900 } } as ResizeObserverEntry],
      this,
    );
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
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
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Files plugin app", () => {
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

  it("uses BB Markdown for Preview and exposes Raw", async () => {
    setRpcHandlers({
      listTree: () => ({
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
        truncated: false,
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

    const row = await view.findByRole("treeitem", { name: /README\.md/ });
    fireEvent.click(row);
    expect(await view.findByRole("button", { name: "Raw" })).toBeTruthy();
    expect((await view.findByTestId("native-markdown")).textContent).toBe(
      "# Project",
    );
    expect(view.queryByRole("button", { name: "Open in Annotate" })).toBeNull();
  });

  it("reopens markdown with the preferred BB file viewer", async () => {
    const openFile = vi.fn(() => ({ delivered: 1 }));
    setRpcHandlers({
      openFile,
      listTree: () => ({
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
        truncated: false,
        annotateAvailable: true,
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
      threadId: "thread-1",
      path: "README.md",
    });
  });

  it("restores open tabs after the Files panel remounts", async () => {
    const { useFilesWorkspace } = await import(
      "./src/hooks/useFilesWorkspace"
    );
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listTree: () => ({ rootName: "repo", entries: [], truncated: false }),
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

    const first = renderHook(() => useFilesWorkspace("thread-restore"));
    await act(async () => {
      await first.result.current.openPath("README.md");
      await first.result.current.openPath("src/app.tsx");
    });
    act(() => first.result.current.setActivePath("README.md"));

    await waitFor(() => {
      expect(window.localStorage.getItem('bb-plugin-files:workspace:["thread-restore",null,null]')).toContain("src/app.tsx");
    });
    first.unmount();

    const second = renderHook(() => useFilesWorkspace("thread-restore"));
    expect(second.result.current.tabs.map((tab) => tab.path)).toEqual([
      "README.md",
      "src/app.tsx",
    ]);
    expect(second.result.current.activePath).toBe("README.md");
    await waitFor(() => {
      expect(second.result.current.tabs.every((tab) => tab.file !== null)).toBe(true);
    });
  });

  it("keeps identical paths separate across workspace source identities", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({
      listTree: () => ({ rootName: "repo", entries: [], truncated: false }),
      readFile: (input: unknown) => ({ state: "text", path: (input as { path: string }).path, sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "x" }),
    });
    const first = renderHook(() => useFilesWorkspace("thread-1", { kind: "workspace", threadId: "thread-1", environmentId: "environment-a", projectId: "project-a" }));
    const second = renderHook(() => useFilesWorkspace("thread-1", { kind: "workspace", threadId: "thread-1", environmentId: "environment-b", projectId: "project-a" }));
    await act(async () => { await first.result.current.openPath("README.md"); await second.result.current.openPath("README.md"); });
    expect(first.result.current.tabs[0].id).not.toBe(second.result.current.tabs[0].id);
    expect(first.result.current.tabs).toHaveLength(1);
    expect(second.result.current.tabs).toHaveLength(1);
  });

  it.each([
    { kind: "host" as const, threadId: "thread-1", environmentId: null, projectId: null },
    { kind: "workspace" as const, threadId: "thread-1", environmentId: "foreign-environment", projectId: null },
    { kind: "workspace" as const, threadId: "thread-1", environmentId: null, projectId: "foreign-project" },
  ])("does not call Files RPCs for incompatible file-opener sources", async (source) => {
    const listTree = vi.fn();
    const readFile = vi.fn();
    setRpcHandlers({ listTree, readFile });
    render(<FilesPanel path="README.md" source={source} />);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(listTree).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("fails closed for unauthorized callback invocations", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    const handlers = { openFile: vi.fn(), saveFile: vi.fn(), createFile: vi.fn(), createDirectory: vi.fn(), movePath: vi.fn(), removePath: vi.fn(), readFile: vi.fn(), listTree: vi.fn() };
    setRpcHandlers(handlers);
    const hook = renderHook(() => useFilesWorkspace("thread-1", { kind: "workspace", threadId: "thread-1", environmentId: null, projectId: null }, null, false));
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

  it("does not import legacy thread-only state", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    window.localStorage.setItem("bb-plugin-files:workspace:thread-1", JSON.stringify({ version: 1, openPaths: ["README.md", "src/../bad", "x".repeat(4097)], activePath: "README.md" }));
    const source = { kind: "workspace" as const, threadId: "thread-1", environmentId: "environment-a", projectId: "project-a" };
    const first = renderHook(() => useFilesWorkspace("thread-1", source));
    expect(first.result.current.tabs).toEqual([]);
    expect(window.localStorage.getItem("bb-plugin-files:workspace:thread-1")).not.toBeNull();
    first.unmount();
    const second = renderHook(() => useFilesWorkspace("thread-1", { ...source, environmentId: "environment-b" }));
    expect(second.result.current.tabs).toEqual([]);
  });

  it("focuses an existing tab for the same source and path", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    setRpcHandlers({ listTree: () => ({ rootName: "repo", entries: [], truncated: false }), readFile: () => ({ state: "text", path: "README.md", sha256: "sha", sizeBytes: 1, mimeType: null, modifiedAtMs: null, content: "x" }) });
    const hook = renderHook(() => useFilesWorkspace("thread-1"));
    await act(async () => { await hook.result.current.openPath("README.md"); await hook.result.current.openPath("README.md"); });
    expect(hook.result.current.tabs).toHaveLength(1);
  });

  it("drops forged source records from v2 persistence", async () => {
    const { useFilesWorkspace } = await import("./src/hooks/useFilesWorkspace");
    const { renderHook } = await import("@testing-library/react");
    window.localStorage.setItem('bb-plugin-files:workspace:["thread-1","environment-a","project-a"]', JSON.stringify({ version: 2, openFiles: [{ version: 1, source: { kind: "workspace", threadId: "thread-1", environmentId: "forged", projectId: "project-a" }, path: "README.md" }], activeFileId: "forged" }));
    const hook = renderHook(() => useFilesWorkspace("thread-1", { kind: "workspace", threadId: "thread-1", environmentId: "environment-a", projectId: "project-a" }));
    expect(hook.result.current.tabs).toEqual([]);
  });

  it("preserves a dirty draft and reports a CAS conflict", async () => {
    const { useFilesWorkspace } = await import(
      "./src/hooks/useFilesWorkspace"
    );
    setRpcHandlers({
      listTree: () => ({ rootName: "repo", entries: [], truncated: false }),
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
    const hook = renderHook(() => useFilesWorkspace("thread-1"));

    await act(async () => {
      await hook.result.current.openPath("README.md");
    });
    act(() => hook.result.current.setDraftText("README.md", "my draft"));
    await act(async () => {
      expect(await hook.result.current.save("README.md")).toBe(false);
    });

    await waitFor(() => {
      expect(hook.result.current.tabs.find(t => t.path === "README.md")?.saveState).toEqual({
        kind: "conflict",
        currentSha256: "sha-new",
      });
    });
    expect(hook.result.current.tabs.find(t => t.path === "README.md")?.draftText).toBe("my draft");
    expect(hook.result.current.activePath).toBe("README.md");
  });
});
