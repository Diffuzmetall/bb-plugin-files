import { parse } from "yaml";

export interface MarkdownDocument {
  frontmatter: string;
  body: string;
}

interface MarkdownLine {
  start: number;
  nextStart: number;
  text: string;
}

function readLine(content: string, start: number): MarkdownLine {
  const newline = content.indexOf("\n", start);
  const end = newline === -1 ? content.length : newline;
  const textEnd = end > start && content[end - 1] === "\r" ? end - 1 : end;
  return {
    start,
    nextStart: newline === -1 ? content.length : newline + 1,
    text: content.slice(start, textEnd),
  };
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidFrontmatter(source: string): boolean {
  let metadata: unknown;
  try {
    metadata = parse(source, { maxAliasCount: 20 });
  } catch {
    return false;
  }
  return metadata === null || metadata === undefined || isMapping(metadata);
}

/**
 * Separates YAML frontmatter from the editable body. A leading thematic break
 * remains visible unless the fenced content parses as a YAML mapping.
 */
export function parseMarkdownDocument(content: string): MarkdownDocument {
  const firstLineStart = content.startsWith("\uFEFF") ? 1 : 0;
  const firstLine = readLine(content, firstLineStart);
  if (firstLine.text !== "---") {
    return { frontmatter: "", body: content };
  }

  let lineStart = firstLine.nextStart;
  while (lineStart < content.length) {
    const line = readLine(content, lineStart);
    if (line.text === "---" || line.text === "...") {
      const frontmatterSource = content.slice(firstLine.nextStart, line.start);
      if (!hasValidFrontmatter(frontmatterSource)) break;
      return {
        frontmatter: content.slice(0, line.nextStart),
        body: content.slice(line.nextStart),
      };
    }
    if (line.nextStart === lineStart) break;
    lineStart = line.nextStart;
  }

  return { frontmatter: "", body: content };
}
