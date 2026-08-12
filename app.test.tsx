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
      expect(window.localStorage.getItem("bb-plugin-files:workspace:thread-restore")).toContain("src/app.tsx");
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
