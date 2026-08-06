import path from "node:path";

export interface ParsedRelativePath {
  normalized: string;
  segments: readonly string[];
}

function looksAbsolute(value: string): boolean {
  return (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
  );
}

/**
 * Parse an untrusted project-relative path. Hidden segments are rejected as
 * well as traversal because the host tree API intentionally omits them.
 */
export function parseRelativePath(
  value: string,
  options: { allowEmpty: boolean },
): ParsedRelativePath {
  if (value.length === 0) {
    if (options.allowEmpty) return { normalized: "", segments: [] };
    throw new Error("Path must not be empty.");
  }
  if (value.trim() !== value) {
    throw new Error("Path must not start or end with whitespace.");
  }
  if (looksAbsolute(value)) {
    throw new Error("Path must be project-relative, not absolute.");
  }

  const slashPath = value.replaceAll("\\", "/");
  const segments = slashPath.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error("Path must not contain empty segments.");
    }
    if (segment === "." || segment === "..") {
      throw new Error("Path must not contain dot or traversal segments.");
    }
    if (segment.startsWith(".")) {
      throw new Error("Hidden paths are not supported by Files.");
    }
    if (segment.includes("\0")) {
      throw new Error("Path must not contain NUL bytes.");
    }
  }
  return { normalized: segments.join("/"), segments };
}

function pathFlavor(rootPath: string): typeof path.posix | typeof path.win32 {
  if (path.posix.isAbsolute(rootPath)) return path.posix;
  if (/^[a-zA-Z]:[\\/]/u.test(rootPath) || rootPath.startsWith("\\\\")) {
    return path.win32;
  }
  throw new Error("Thread environment root must be absolute.");
}

/** Resolve a validated project-relative path beneath a server-owned root. */
export function resolveProjectPath(
  rootPath: string,
  relativePath: string,
  options: { allowEmpty: boolean },
): { absolutePath: string; relativePath: string } {
  const parsed = parseRelativePath(relativePath, options);
  const flavor = pathFlavor(rootPath);
  const root = flavor.resolve(rootPath);
  const absolutePath = flavor.resolve(root, ...parsed.segments);
  const relativeToRoot = flavor.relative(root, absolutePath);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${flavor.sep}`) ||
    flavor.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Path escapes the thread environment.");
  }
  return { absolutePath, relativePath: parsed.normalized };
}

export function projectBasename(rootPath: string): string {
  const flavor = pathFlavor(rootPath);
  return flavor.basename(flavor.resolve(rootPath)) || rootPath;
}

export function joinProjectPaths(parent: string, child: string): string {
  const parentParsed = parseRelativePath(parent, { allowEmpty: true });
  const childParsed = parseRelativePath(child, { allowEmpty: false });
  return [...parentParsed.segments, ...childParsed.segments].join("/");
}
