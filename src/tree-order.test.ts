import { describe, expect, it } from "vitest";
import {
  filterVisibleEntries,
  orderTreeEntries,
  parentPath,
} from "./tree-order";
import type { FileTreeEntry } from "./hooks/useFilesWorkspace";

function file(path: string): FileTreeEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    score: 0,
    positions: [],
  };
}
function dir(path: string): FileTreeEntry {
  return {
    kind: "directory",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    score: 0,
    positions: [],
  };
}

// Host lister order is arbitrary; the entries are deliberately shuffled so the
// test proves the tree is reconstructed, not just echoed back.
const TREE: FileTreeEntry[] = [
  dir("src"),
  file("app.tsx"),
  file("src/a.ts"),
  dir("src/components"),
  file("src/components/B.tsx"),
];

describe("orderTreeEntries", () => {
  it("renders a folder's subtree directly beneath it, not after root siblings", () => {
    const ordered = orderTreeEntries(TREE);
    expect(ordered.map((entry) => entry.path)).toEqual([
      "src",
      "src/components",
      "src/components/B.tsx",
      "src/a.ts",
      "app.tsx",
    ]);
    const srcIdx = ordered.findIndex((entry) => entry.path === "src");
    const componentsIdx = ordered.findIndex(
      (entry) => entry.path === "src/components",
    );
    const appIdx = ordered.findIndex((entry) => entry.path === "app.tsx");
    expect(componentsIdx).toBe(srcIdx + 1);
    expect(appIdx).toBeGreaterThan(componentsIdx);
  });

  it("lists directories before files within the same parent", () => {
    const ordered = orderTreeEntries([
      dir("root"),
      file("root/z.txt"),
      dir("root/zzz"),
      dir("root/a"),
      file("root/a.txt"),
    ]);
    expect(ordered.map((entry) => entry.path)).toEqual([
      "root",
      "root/a",
      "root/zzz",
      "root/a.txt",
      "root/z.txt",
    ]);
  });

  it("synthesizes missing parent directories so no file is orphaned", () => {
    // We provide a file inside "nested/deep", but omit the "nested" and
    // "nested/deep" directory entries.
    const ordered = orderTreeEntries([
      file("app.tsx"),
      file("nested/deep/config.json"),
    ]);
    expect(ordered.map((entry) => entry.path)).toEqual([
      "nested",
      "nested/deep",
      "nested/deep/config.json",
      "app.tsx",
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(orderTreeEntries([])).toEqual([]);
  });
});

describe("filterVisibleEntries", () => {
  it("hides a collapsed folder's descendants but keeps its siblings", () => {
    const visible = filterVisibleEntries(
      orderTreeEntries(TREE),
      new Set(["src"]),
    );
    expect(visible.map((entry) => entry.path)).toEqual([
      "src",
      "src/components",
      "src/a.ts",
      "app.tsx",
    ]);
  });

  it("reveals the full subtree when every ancestor is expanded", () => {
    const visible = filterVisibleEntries(
      orderTreeEntries(TREE),
      new Set(["src", "src/components"]),
    );
    expect(visible.map((entry) => entry.path)).toEqual([
      "src",
      "src/components",
      "src/components/B.tsx",
      "src/a.ts",
      "app.tsx",
    ]);
  });
});

describe("parentPath", () => {
  it("returns the parent of a nested path and '' at the root", () => {
    expect(parentPath("src/components/B.tsx")).toBe("src/components");
    expect(parentPath("src")).toBe("");
    expect(parentPath("app.tsx")).toBe("");
  });
});
