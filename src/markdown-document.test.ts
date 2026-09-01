import { describe, expect, it } from "vitest";
import { parseMarkdownDocument } from "./markdown-document";

describe("parseMarkdownDocument", () => {
  it("preserves YAML frontmatter outside the editable body", () => {
    expect(
      parseMarkdownDocument(
        "---\r\ntitle: Notes\r\ntags:\r\n  - draft\r\n---\r\n\r\n# Body\r\n",
      ),
    ).toEqual({
      frontmatter:
        "---\r\ntitle: Notes\r\ntags:\r\n  - draft\r\n---\r\n",
      body: "\r\n# Body\r\n",
    });
  });

  it("keeps a leading thematic break when the fenced content is prose", () => {
    const content = "---\n\nIntroduction\n\n---\n\nMore text\n";
    expect(parseMarkdownDocument(content)).toEqual({
      frontmatter: "",
      body: content,
    });
  });

  it("keeps invalid YAML visible", () => {
    const content = "---\ntitle: [invalid\n---\n\nBody\n";
    expect(parseMarkdownDocument(content)).toEqual({
      frontmatter: "",
      body: content,
    });
  });
});
