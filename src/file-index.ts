import { readdir, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import { Fzf, type FzfResultItem } from "fzf";
import { parseRelativePath } from "./path-policy";
import type { FileScope } from "./environment";

export interface IndexEntry {
  kind: "file" | "directory";
  path: string;
  /**
   * Lowercased `path`, kept so the per-keystroke prefilter allocates nothing.
   * The file name is derived from the path when a hit is produced, which keeps
   * a 250k-path index around 70 MB instead of 110 MB. Neither is ever returned
   * to the client as-is.
   */
  lower: string;
}

export interface SearchHit extends Omit<IndexEntry, "lower"> {
  name: string;
  score: number;
  positions: number[];
}

export interface IndexStatus {
  status: "ready" | "indexing";
  /** Paths in a ready index; paths scanned so far while one is building. */
  indexedCount: number;
  indexedAtMs: number | null;
  indexingSinceMs: number | null;
  truncated: boolean;
}

export interface BuiltIndex {
  entries: IndexEntry[];
  truncated: boolean;
}

export interface SearchOutcome extends IndexStatus {
  entries: SearchHit[];
}

/**
 * Names the walk never descends into: the host daemon's own skip list
 * (`DEFAULT_PATH_LIST_EXCLUDE_NAMES`) plus `.git`, which it always skips.
 */
export const INDEX_SKIP_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".turbo",
  ".next",
  ".cache",
  "__pycache__",
  ".DS_Store",
]);

/** Ceilings for one build: whichever hits first stops the walk. A home
 * directory holds a few hundred thousand paths, so the entry ceiling sits above
 * that: the budget is the real bound for a pathological tree. */
export const MAX_INDEX_ENTRIES = 400_000;
export const MAX_INDEX_MS = 45_000;

/** How long a search waits for a fresh build before reporting progress. */
const MAX_INDEX_WAIT_MS = 15_000;

/** Results kept per query, matching the file-manager plugin's ceiling. */
export const MAX_SEARCH_RESULTS = 500;

/**
 * Cheap subsequence gate run over the whole index before the fzf pass — fzf
 * precomputes runes for every item it is given, which is far too much work for
 * a 250k-path index on every keystroke.
 */
const MAX_RANKED_CANDIDATES = 20_000;

const THREAD_INDEX_TTL_MS = 30_000;
const HOST_INDEX_TTL_MS = 5 * 60_000;

function defaultTtlMs(scope: FileScope): number {
  return scope.kind === "thread" ? THREAD_INDEX_TTL_MS : HOST_INDEX_TTL_MS;
}

/** Scope key: the same root must never share a cache entry with another one. */
export function scopeKey(scope: FileScope): string {
  return scope.kind === "thread"
    ? `thread:${scope.threadId}`
    : `host:${scope.hostId ?? ""}:${scope.rootPath ?? ""}`;
}

function toRelative(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join("/");
}

async function classifySymlink(
  absolutePath: string,
  statImpl: (target: string) => Promise<Stats>,
): Promise<"file" | "directory" | null> {
  try {
    const target = await statImpl(absolutePath);
    if (target.isDirectory()) return "directory";
    if (target.isFile()) return "file";
    return null;
  } catch {
    // A broken link is not browsable, exactly as `listLocalDirectory` treats it.
    return null;
  }
}

/**
 * Breadth-first, bounded walk of one root: shallow paths first, so a truncated
 * index still covers the tree the user sees. Adapted from the file-manager
 * plugin's `searchDir` (bounded walk, symlink safety, unreadable directories
 * skipped) — but its depth cap and substring match are dropped, because this
 * walk feeds a full index that a fuzzy ranker then queries.
 *
 * `onProgress` reports the running entry count, which is what makes the index
 * build report real progress instead of an opaque spinner.
 */
export async function walkDirectoryIndex(options: {
  rootPath: string;
  includeHidden: boolean;
  maxEntries?: number;
  budgetMs?: number;
  onProgress?: (scanned: number, entries: IndexEntry[]) => void;
  now?: () => number;
  /** Injectable for tests; both default to node's own filesystem calls. */
  readdirImpl?: (directory: string) => Promise<Dirent[]>;
  statImpl?: (target: string) => Promise<Stats>;
}): Promise<BuiltIndex> {
  const maxEntries = options.maxEntries ?? MAX_INDEX_ENTRIES;
  const budgetMs = options.budgetMs ?? MAX_INDEX_MS;
  const now = options.now ?? (() => Date.now());
  const readDirectory =
    options.readdirImpl ??
    ((directory: string) => readdir(directory, { withFileTypes: true }));
  const statTarget = options.statImpl ?? ((target: string) => stat(target));
  const deadline = now() + budgetMs;
  const root = path.resolve(options.rootPath);
  const entries: IndexEntry[] = [];
  let truncated = false;

  let frontier: string[] = [root];
  while (frontier.length > 0 && !truncated) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (now() >= deadline || entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      let dirents;
      try {
        dirents = await readDirectory(dir);
      } catch {
        continue; // Unreadable directory: skipped, never failing the whole walk.
      }
      for (const dirent of dirents) {
        if (INDEX_SKIP_NAMES.has(dirent.name)) continue;
        if (!options.includeHidden && dirent.name.startsWith(".")) continue;
        const absolutePath = path.join(dir, dirent.name);
        let kind: "file" | "directory" | null;
        if (dirent.isSymbolicLink()) kind = await classifySymlink(absolutePath, statTarget);
        else if (dirent.isDirectory()) kind = "directory";
        else if (dirent.isFile()) kind = "file";
        else kind = null; // Sockets, fifos, devices: not browsable.
        if (kind === null) continue;
        let relativePath: string;
        try {
          relativePath = parseRelativePath(toRelative(root, absolutePath), {
            allowEmpty: false,
          }).normalized;
        } catch {
          continue; // Names the path policy rejects are not addressable anyway.
        }
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        entries.push({
          kind,
          path: relativePath,
          lower: relativePath.toLowerCase(),
        });
        if (kind === "directory" && !dirent.isSymbolicLink()) next.push(absolutePath);
      }
      options.onProgress?.(entries.length, entries);
      if (truncated) break;
    }
    frontier = next;
  }

  return { entries, truncated };
}

/** Index of the host daemon: same entries as its own `list_paths` walk. */
export function indexFromPaths(
  paths: ReadonlyArray<{ kind: "file" | "directory"; path: string; name: string }>,
): BuiltIndex {
  const entries: IndexEntry[] = [];
  for (const entry of paths) {
    let relativePath: string;
    try {
      relativePath = parseRelativePath(entry.path, { allowEmpty: false }).normalized;
    } catch {
      continue;
    }
    entries.push({
      kind: entry.kind,
      path: relativePath,
      lower: relativePath.toLowerCase(),
    });
  }
  return { entries, truncated: false };
}

function isSubsequence(haystack: string, needle: string): boolean {
  let index = 0;
  for (let cursor = 0; cursor < haystack.length && index < needle.length; cursor += 1) {
    if (haystack[cursor] === needle[index]) index += 1;
  }
  return index === needle.length;
}

/** Gate the index down to candidates worth fzf's rune precomputation. */
function prefilter(entries: IndexEntry[], query: string): IndexEntry[] {
  const needle = query.toLowerCase();
  const candidates: IndexEntry[] = [];
  for (const entry of entries) {
    if (!isSubsequence(entry.lower, needle)) continue;
    candidates.push(entry);
    if (candidates.length >= MAX_RANKED_CANDIDATES) break;
  }
  return candidates;
}

/**
 * Rank an index against one query. fzf is the same scorer BB's own file search
 * runs inside the host daemon, so ordering matches what the rest of BB shows;
 * `positions` drive the match highlight in the panel.
 */
export function rankIndex(
  entries: readonly IndexEntry[],
  query: string,
  limit = MAX_SEARCH_RESULTS,
): SearchHit[] {
  if (query.length === 0) return [];
  const candidates = prefilter(entries as IndexEntry[], query);
  if (candidates.length === 0) return [];
  const finder = new Fzf(candidates, {
    selector: (entry: IndexEntry) => entry.path,
    casing: "smart-case",
    limit,
    tiebreakers: [
      (a: FzfResultItem<IndexEntry>, b: FzfResultItem<IndexEntry>) =>
        a.item.path.length - b.item.path.length,
      (a: FzfResultItem<IndexEntry>, b: FzfResultItem<IndexEntry>) =>
        a.item.path.localeCompare(b.item.path),
    ],
  });
  return finder.find(query).map((hit) => ({
    kind: hit.item.kind,
    path: hit.item.path,
    name: hit.item.path.slice(hit.item.path.lastIndexOf("/") + 1),
    score: hit.score,
    positions: [...hit.positions].sort((left, right) => left - right),
  }));
}

interface ReadyIndex {
  entries: IndexEntry[];
  truncated: boolean;
  builtAtMs: number;
}

interface PendingIndex {
  startedAtMs: number;
  scanned: number;
  /** The live array the walk fills, so a search can rank what exists so far. */
  entries: IndexEntry[];
  done: Promise<void>;
}

/**
 * One in-memory path index per scope, rebuilt at most once per TTL — the point
 * of the whole change: search costs one walk per scope, not one per keystroke.
 * The host daemon only dedupes *concurrent* walks (`host.list_paths` drops its
 * list cache as soon as the walk resolves), so a query-per-keystroke search
 * re-walked the whole root every time.
 */
export class FileIndexCache {
  private readonly ready = new Map<string, ReadyIndex>();
  private readonly pending = new Map<string, PendingIndex>();

  constructor(
    private readonly ttlMs: (scope: FileScope) => number = defaultTtlMs,
    private readonly now: () => number = () => Date.now(),
  ) {}

  status(scope: FileScope): IndexStatus {
    const key = scopeKey(scope);
    const pending = this.pending.get(key);
    if (pending !== undefined) {
      return {
        status: "indexing",
        indexedCount: pending.scanned,
        indexedAtMs: null,
        indexingSinceMs: pending.startedAtMs,
        truncated: false,
      };
    }
    const ready = this.ready.get(key);
    if (ready === undefined) {
      return {
        status: "ready",
        indexedCount: 0,
        indexedAtMs: null,
        indexingSinceMs: null,
        truncated: false,
      };
    }
    return {
      status: "ready",
      indexedCount: ready.entries.length,
      indexedAtMs: ready.builtAtMs,
      indexingSinceMs: null,
      truncated: ready.truncated,
    };
  }

  /** Drop a scope's index so the next search rebuilds it. */
  invalidate(scope: FileScope): void {
    const key = scopeKey(scope);
    this.ready.delete(key);
  }

  async search(
    scope: FileScope,
    query: string,
    options: {
      force?: boolean;
      limit?: number;
      /**
       * How long a caller waits for a fresh build before being told the index
       * is still coming. A workspace walks in milliseconds, so it can answer in
       * one call; a home directory cannot, so it reports progress instead.
       */
      waitMs?: number;
      build: (onProgress: (scanned: number, entries: IndexEntry[]) => void) => Promise<BuiltIndex>;
    },
  ): Promise<SearchOutcome> {
    const key = scopeKey(scope);
    const cached = this.ready.get(key);
    const isFresh =
      options.force !== true &&
      cached !== undefined &&
      this.now() - cached.builtAtMs < this.ttlMs(scope);
    if (!isFresh) this.startBuild(scope, options.build);

    const pending = this.pending.get(key);
    const waitMs = options.waitMs ?? MAX_INDEX_WAIT_MS;
    if (pending !== undefined && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      // A build that finished first must not leave the wait timer holding the
      // event loop open until it expires.
      if (timer !== undefined) clearTimeout(timer);
    }

    const status = this.status(scope);
    const indexed = this.ready.get(key)?.entries ?? [];
    if (status.status === "indexing") {
      // Rank what the walk has reached so far: the first search on a large root
      // shows real hits immediately instead of an empty list, and they sharpen
      // as the index fills.
      return {
        ...status,
        entries: rankIndex(
          this.pending.get(key)?.entries ?? [],
          query,
          options.limit ?? MAX_SEARCH_RESULTS,
        ),
      };
    }
    return {
      ...status,
      entries: rankIndex(indexed, query, options.limit ?? MAX_SEARCH_RESULTS),
    };
  }

  /** Start (or join) a background build. Never throws to its caller. */
  private startBuild(
    scope: FileScope,
    build: (onProgress: (scanned: number, entries: IndexEntry[]) => void) => Promise<BuiltIndex>,
  ): void {
    const key = scopeKey(scope);
    if (this.pending.has(key)) return;
    const pending: PendingIndex = {
      startedAtMs: this.now(),
      scanned: 0,
      entries: [],
      done: Promise.resolve(),
    };
    pending.done = build((scanned, entries) => {
      pending.scanned = scanned;
      pending.entries = entries;
    })
      .then((built) => {
        this.ready.set(key, {
          entries: built.entries,
          truncated: built.truncated,
          builtAtMs: this.now(),
        });
      })
      .catch(() => {
        // A failed walk leaves no index: the next search simply tries again.
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, pending);
  }
}

/**
 * The server's single index cache. Mutations invalidate through it directly,
 * so the RPC layer and the upload route cannot drift apart.
 */
export const fileIndexCache = new FileIndexCache();
