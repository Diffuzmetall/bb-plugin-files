// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./components/MarkdownEditor";

beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Range.prototype, "getClientRects");
});

describe("MarkdownEditor", () => {
  it("edits rendered Markdown without emitting an initial change", async () => {
    const onChange = vi.fn();
    const view = render(
      <MarkdownEditor
        filePath="notes.md"
        value={"# Notes\n\nOriginal body."}
        onChange={onChange}
        onSave={vi.fn()}
      />,
    );

    const body = await view.findByText("Original body.");
    expect(view.container.querySelector("h1")?.textContent).toBe("Notes");
    expect(onChange).not.toHaveBeenCalled();

    body.textContent = "Edited body.";
    fireEvent.input(body);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0]).toContain("# Notes\n\nEdited body.");
  });

  it("preserves frontmatter while editing the rendered body", async () => {
    const onChange = vi.fn();
    const frontmatter = "---\r\ntitle: Notes\r\ntype: draft\r\n---\r\n";
    const view = render(
      <MarkdownEditor
        filePath="notes.md"
        value={`${frontmatter}\r\n# Notes\r\n\r\nOriginal body.`}
        onChange={onChange}
        onSave={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".tiptap")?.textContent).not.toContain(
      "type: draft",
    );
    const body = await view.findByText("Original body.");
    body.textContent = "Edited body.";
    fireEvent.input(body);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0]).toMatch(
      /^---\r\ntitle: Notes\r\ntype: draft\r\n---\r\n\r\n# Notes\n\nEdited body\./,
    );
  });

  it("applies external reloads without reporting them as user edits", async () => {
    const onChange = vi.fn();
    const view = render(
      <MarkdownEditor
        filePath="notes.md"
        value="Original"
        onChange={onChange}
        onSave={vi.fn()}
      />,
    );
    expect(await view.findByText("Original")).toBeTruthy();

    view.rerender(
      <MarkdownEditor
        filePath="notes.md"
        value="Reloaded externally"
        onChange={onChange}
        onSave={vi.fn()}
      />,
    );

    expect(await view.findByText("Reloaded externally")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("handles Cmd/Ctrl+S inside the preview editor", async () => {
    const onSave = vi.fn();
    const view = render(
      <MarkdownEditor
        filePath="notes.md"
        value="Save me"
        onChange={vi.fn()}
        onSave={onSave}
      />,
    );
    const editor = await waitFor(() => {
      const element = view.container.querySelector<HTMLElement>(".tiptap");
      expect(element).not.toBeNull();
      return element!;
    });

    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
