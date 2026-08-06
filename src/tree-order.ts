import type { FileTreeEntry } from "./hooks/useFilesWorkspace";

/** Parent path of a project-relative path; "" at the root. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function sortSiblings(list: FileTreeEntry[]): FileTreeEntry[] {
  return [...list].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/**
 * Depth-first pre-order: directories before files (alpha within a kind), with a
 * folder's subtree rendered directly beneath it rather than after every
 * root-level sibling. The host lister returns a flat list, so callers must
 * reconstruct the tree before display — sorting by parent path alone groups
 * whole depth layers, which pushes a folder's children far below its siblings.
 */
export function orderTreeEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  if (entries.length === 0) return [];
  const entryByPath = new Map<string, FileTreeEntry>();

  // 1. Index all existing entries
  for (const entry of entries) {
    entryByPath.set(entry.path, entry);
  }

  // 2. Synthesize any missing parent directories so no file is ever orphaned
  // (e.g. if the host lister truncated the results or omitted implicit dirs).
  for (const entry of entries) {
    let p = parentPath(entry.path);
    while (p.length > 0) {
      if (!entryByPath.has(p)) {
        entryByPath.set(p, {
          kind: "directory",
          path: p,
          name: p.slice(p.lastIndexOf("/") + 1),
          score: 0,
          positions: [],
        });
      }
      p = parentPath(p);
    }
  }

  const childrenByParent = new Map<string, FileTreeEntry[]>();
  for (const entry of entryByPath.values()) {
    const parent = parentPath(entry.path);
    const siblings = childrenByParent.get(parent);
    if (siblings === undefined) childrenByParent.set(parent, [entry]);
    else siblings.push(entry);
  }

  const ordered: FileTreeEntry[] = [];
  const walk = (parent: string) => {
    const siblings = childrenByParent.get(parent);
    if (siblings === undefined) return;
    for (const entry of sortSiblings(siblings)) {
      ordered.push(entry);
      if (entry.kind === "directory") walk(entry.path);
    }
  };
  walk("");
  return ordered;
}

/**
 * Search results: show every match (the host already filtered), grouped by
 * parent so siblings cluster. Directories sort before files within a parent.
 */
export function searchSortEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  return [...entries].sort((left, right) => {
    const parentOrder = parentPath(left.path).localeCompare(parentPath(right.path));
    if (parentOrder !== 0) return parentOrder;
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** Keep only entries whose every ancestor folder is expanded. */
export function filterVisibleEntries(
  entries: FileTreeEntry[],
  expanded: ReadonlySet<string>,
): FileTreeEntry[] {
  return entries.filter((entry) => {
    let parent = parentPath(entry.path);
    while (parent.length > 0) {
      if (!expanded.has(parent)) return false;
      parent = parentPath(parent);
    }
    return true;
  });
}
