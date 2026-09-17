import { describe, expect, it } from "vitest";
import type { Dirent, Stats } from "node:fs";
import {
  FileIndexCache,
  indexFromPaths,
  rankIndex,
  scopeKey,
  walkDirectoryIndex,
  type BuiltIndex,
  type IndexEntry,
} from "./file-index";
import type { FileScope } from "./environment";

function dirent(name: string, kind: "file" | "directory" | "symlink"): Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  } as unknown as Dirent;
}

function walk(
  tree: Record<string, Dirent[]>,
  options: Partial<Parameters<typeof walkDirectoryIndex>[0]> = {},
) {
  return walkDirectoryIndex({
    rootPath: "/root",
    includeHidden: true,
    readdirImpl: async (directory) => {
      const entries = tree[directory];
      if (entries === undefined) throw new Error(`ENOENT ${directory}`);
      return entries;
    },
    statImpl: async () =>
      ({ isDirectory: () => true, isFile: () => false }) as unknown as Stats,
    ...options,
  });
}

describe("walkDirectoryIndex", () => {
  const tree: Record<string, Dirent[]> = {
    "/root": [dirent("src", "directory"), dirent("app.tsx", "file"), dirent("node_modules", "directory")],
    "/root/src": [
      dirent("components", "directory"),
      dirent("a.ts", "file"),
      dirent(".env", "file"),
      dirent("link", "symlink"),
    ],
    "/root/src/components": [dirent("B.tsx", "file")],
    "/root/src/link": [dirent("hidden-through-link.ts", "file")],
  };

  it("walks breadth-first and skips the daemon's skip list and symlinked directories", async () => {
    const built = await walk(tree);
    expect(built.entries.map((entry) => entry.path)).toEqual([
      "src",
      "app.tsx",
      "src/components",
      "src/a.ts",
      "src/.env",
      "src/link",
      "src/components/B.tsx",
    ]);
    expect(built.truncated).toBe(false);
  });

  it("drops hidden names when the root hides them, as a host root does", async () => {
    const built = await walk(tree, { includeHidden: false });
    expect(built.entries.map((entry) => entry.path)).not.toContain("src/.env");
  });

  it("classifies a symlink by its target without descending into it", async () => {
    const built = await walk(tree, { statImpl: async () => ({ isDirectory: () => false, isFile: () => true }) as unknown as Stats });
    const link = built.entries.find((entry) => entry.path === "src/link");
    expect(link?.kind).toBe("file");
    expect(built.entries.map((entry) => entry.path)).not.toContain("src/link/hidden-through-link.ts");
  });

  it("truncates at the entry ceiling instead of walking the whole tree", async () => {
    const built = await walk(tree, { maxEntries: 2 });
    expect(built.truncated).toBe(true);
    expect(built.entries).toHaveLength(2);
  });

  it("truncates when the time budget is spent", async () => {
    let clock = 0;
    const built = await walk(tree, {
      budgetMs: 5,
      now: () => {
        clock += 10;
        return clock;
      },
    });
    expect(built.truncated).toBe(true);
  });

  it("reports progress while it walks", async () => {
    const seen: number[] = [];
    await walk(tree, { onProgress: (scanned) => seen.push(scanned) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(7);
  });
});

describe("indexFromPaths", () => {
  it("keeps canonical paths and drops the ones the path policy rejects", () => {
    const built = indexFromPaths([
      { kind: "file", path: "src/a.ts", name: "a.ts" },
      { kind: "directory", path: "../escape", name: "escape" },
      { kind: "file", path: "src//b.ts", name: "b.ts" },
    ]);
    expect(built.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
  });
});

describe("rankIndex", () => {
  const entries: IndexEntry[] = [
    "docs/release-notes/deep/tree-order.md",
    "src/tree-order-extra/deep/nested/notes.txt",
    "src/tree-order.ts",
    "src/hooks/useFilesWorkspace.ts",
    "README.md",
  ].map((path) => ({
    kind: "file" as const,
    path,
    lower: path.toLowerCase(),
  }));

  it("ranks a match in the file name above one buried in a directory", () => {
    const hits = rankIndex(entries, "treeorder");
    expect(hits[0].path).toBe("src/tree-order.ts");
  });

  it("returns match positions so the panel can highlight them", () => {
    const [hit] = rankIndex(entries, "tree");
    expect(hit.path).toBe("src/tree-order.ts");
    expect(hit.positions.length).toBeGreaterThan(0);
    expect(hit.path.slice(hit.positions[0], hit.positions[0] + 4)).toBe("tree");
  });

  it("matches a camelCase name from a plain lowercase query", () => {
    const [hit] = rankIndex(entries, "usefilesworkspace");
    expect(hit.path).toBe("src/hooks/useFilesWorkspace.ts");
    expect(hit.name).toBe("useFilesWorkspace.ts");
  });

  it("returns nothing for an empty query and for a query with no subsequence", () => {
    expect(rankIndex(entries, "")).toEqual([]);
    expect(rankIndex(entries, "zzzz")).toEqual([]);
  });
});

describe("FileIndexCache", () => {
  const scope: FileScope = { kind: "thread", threadId: "thr_1" };
  const other: FileScope = { kind: "host", rootPath: "/home" };
  const entries: IndexEntry[] = ["src/a.ts", "src/b.ts", "docs/readme.md"].map(
    (path) => ({
      kind: "file" as const,
      path,
      lower: path,
    }),
  );

  function countingBuild(): { build: () => Promise<BuiltIndex>; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      build: async () => {
        calls += 1;
        return { entries, truncated: false };
      },
    };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("builds once and serves later searches from the index", async () => {
    const cache = new FileIndexCache();
    const counter = countingBuild();
    const started = await cache.search(scope, "a.ts", {
      build: counter.build,
      waitMs: 0,
    });
    expect(started.status).toBe("indexing");
    expect(started.entries).toEqual([]);

    await flush();
    const ready = await cache.search(scope, "a.ts", { build: counter.build });
    expect(ready.status).toBe("ready");
    expect(ready.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);

    await cache.search(scope, "readme", { build: counter.build });
    expect(counter.calls()).toBe(1);
  });

  it("answers in a single call when the build lands inside the wait", async () => {
    const cache = new FileIndexCache();
    const build = () =>
      new Promise<BuiltIndex>((resolve) => {
        setTimeout(() => resolve({ entries, truncated: false }), 5);
      });

    const outcome = await cache.search(scope, "a.ts", { build });
    expect(outcome.status).toBe("ready");
    expect(outcome.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
  });

  it("keeps one index per scope", async () => {
    const cache = new FileIndexCache();
    const counter = countingBuild();
    await cache.search(scope, "a", { build: counter.build, waitMs: 0 });
    await flush();
    await cache.search(other, "a", { build: counter.build, waitMs: 0 });
    await flush();
    expect(counter.calls()).toBe(2);
    cache.invalidate(scope);
    expect(cache.status(scope).indexedCount).toBe(0);
  });

  it("rebuilds on force and after the TTL", async () => {
    let clock = 0;
    const cache = new FileIndexCache(() => 1_000, () => clock);
    const counter = countingBuild();
    await cache.search(scope, "a", { build: counter.build, waitMs: 0 });
    await flush();

    clock += 1_500;
    await cache.search(scope, "a", { build: counter.build, waitMs: 0 });
    await flush();
    expect(counter.calls()).toBe(2);

    await cache.search(scope, "a", { build: counter.build, force: true, waitMs: 0 });
    expect(counter.calls()).toBe(3);
    expect(cache.status(scope).status).toBe("indexing");
  });

  it("ranks the paths scanned so far while the build is still running", async () => {
    const cache = new FileIndexCache();
    const build = (onProgress: (scanned: number, entries: IndexEntry[]) => void) =>
      new Promise<BuiltIndex>((resolve) => {
        onProgress(2, entries.slice(0, 2));
        void resolve;
      });

    const outcome = await cache.search(scope, "a.ts", { build, waitMs: 0 });
    expect(outcome.status).toBe("indexing");
    expect(outcome.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
  });

  it("joins an in-flight build instead of starting a second walk", async () => {
    const cache = new FileIndexCache();
    let calls = 0;
    let release: (built: BuiltIndex) => void = () => {};
    const build = () =>
      new Promise<BuiltIndex>((resolve) => {
        calls += 1;
        release = resolve;
      });

    await cache.search(scope, "a", { build, waitMs: 0 });
    await cache.search(scope, "b", { build, waitMs: 0 });
    expect(calls).toBe(1);
    expect(cache.status(scope).status).toBe("indexing");

    release({ entries, truncated: true });
    await flush();
    const ready = await cache.search(scope, "a", { build });
    expect(ready.status).toBe("ready");
    expect(ready.indexedCount).toBe(entries.length);
    expect(ready.truncated).toBe(true);
  });

  it("recovers when a build fails", async () => {
    const cache = new FileIndexCache();
    let calls = 0;
    const build = async () => {
      calls += 1;
      if (calls === 1) throw new Error("walk failed");
      return { entries, truncated: false };
    };
    await cache.search(scope, "a", { build, waitMs: 0 });
    await flush();
    expect(cache.status(scope).indexedCount).toBe(0);

    await cache.search(scope, "a", { build, waitMs: 0 });
    await flush();
    expect(cache.status(scope).indexedCount).toBe(entries.length);
  });
});

describe("scopeKey", () => {
  it("separates thread, host, and named roots", () => {
    expect(scopeKey({ kind: "thread", threadId: "t" })).toBe("thread:t");
    expect(scopeKey({ kind: "host" })).toBe("host::");
    expect(scopeKey({ kind: "host", rootPath: "/home" })).toBe("host::/home");
  });
});
