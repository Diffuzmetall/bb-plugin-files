import type { BbPluginApi } from "@bb/plugin-sdk";
import { posix } from "node:path";
import type { CreateNoteRequest } from "./contracts";
import {
  hostTargetForAbsolutePath,
  resolveFileRoot,
  resolveThreadEnvironment,
  type FileRoot,
  type FileScope,
} from "./environment";
import { duplicateDirectory, duplicateFile } from "./duplicate";
import {
  fileIndexCache,
  indexFromPaths,
  MAX_SEARCH_RESULTS,
  walkDirectoryIndex,
  type BuiltIndex,
  type IndexEntry,
} from "./file-index";
import { listLocalDirectory } from "./host-directory";
import {
  joinProjectPaths,
  parseRelativePath,
  projectBasename,
  resolveProjectPath,
} from "./path-policy";

export const TREE_LIMIT = 10_000;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Sibling-plugin availability changes rarely and costs two RPCs to ask. */
const OPENER_FLAGS_TTL_MS = 10_000;

const ROOT_DOTFILE_PROBES = [
  ".gitignore",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".pi",
  ".github",
  ".vscode",
  ".cursorrules",
  ".cursorignore",
  ".npmrc",
  ".nvmrc",
  ".yarnrc",
  ".dockerignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
];

type FilesSdk = BbPluginApi["sdk"]["files"];

interface TreeEntryLike {
  kind: "file" | "directory";
  path: string;
  name: string;
  score: number;
  positions: number[];
}

/** Совместимый UI-бандл плагина готов принимать file-open через host. */
async function pluginUiAvailable(
  bb: BbPluginApi,
  pluginId: string,
): Promise<boolean> {
  const { plugins } = await bb.sdk.plugins.list();
  const plugin = plugins.find((entry) => entry.id === pluginId);
  return (
    plugin?.status === "running" &&
    plugin.app.hasApp &&
    plugin.app.bundle?.compatible === true
  );
}

async function openerPluginFlags(bb: BbPluginApi): Promise<{
  annotateAvailable: boolean;
  sqlAvailable: boolean;
}> {
  const [annotateAvailable, sqlAvailable] = await Promise.all([
    pluginUiAvailable(bb, "md-annotate"),
    pluginUiAvailable(bb, "sql"),
  ]);
  return { annotateAvailable, sqlAvailable };
}

/**
 * host.list_paths/browse_directory both hide dotfiles, but common config
 * dotfiles are still worth surfacing at the workspace root. Probes each by
 * name and appends whatever exists (as a file, or walked one level deep as a
 * directory) directly onto `entries`.
 */
/**
 * The name the tree shows for a root. An implicit host scope is the local
 * home directory, which reads better as "Home" than as its last segment.
 */
function rootLabel(scope: FileScope, rootPath: string): string {
  return scope.kind === "host" && scope.rootPath === undefined
    ? "Home"
    : projectBasename(rootPath);
}

async function appendRootDotfileProbes(
  bb: BbPluginApi,
  environment: FileRoot,
  entries: TreeEntryLike[],
): Promise<void> {
  const probe = async (name: string): Promise<void> => {
    try {
      const resolved = resolveProjectPath(environment.rootPath, name, {
        allowEmpty: false,
      });
      try {
        // Try reading as file
        await bb.sdk.files.read({
          hostId: environment.hostId,
          rootPath: environment.rootPath,
          path: resolved.absolutePath,
        });
        entries.push({
          kind: "file",
          path: name,
          name: name,
          score: 0,
          positions: [],
        });
      } catch (e: any) {
        // If it's a 404, it doesn't exist
        const errorStr = String(e?.message || e);
        if (
          errorStr.includes("404") ||
          errorStr.includes("not exist") ||
          errorStr.includes("path_not_found")
        ) {
          return; // Skip, it really doesn't exist
        }

        // If it failed but it's not a 404, it might be a directory
        const dirResult = await bb.sdk.files.listPaths({
          hostId: environment.hostId,
          path: resolved.absolutePath,
          includeFiles: true,
          includeDirectories: true,
          limit: 1000,
        });
        entries.push({
          kind: "directory",
          path: name,
          name: name,
          score: 0,
          positions: [],
        });
        for (const child of dirResult.paths) {
          entries.push({
            kind: child.kind,
            path: `${name}/${child.path}`,
            name: child.name,
            score: 0,
            positions: [],
          });
        }
      }
    } catch {
      // Item does not exist, ignore
    }
  };

  await Promise.all(ROOT_DOTFILE_PROBES.map(probe));
}

function fileMetadata(
  relativePath: string,
  file: Awaited<ReturnType<FilesSdk["read"]>>,
) {
  return {
    path: relativePath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    mimeType: file.mimeType ?? null,
    modifiedAtMs: file.modifiedAtMs ?? null,
  };
}

export interface NotesSettingsHandle {
  get(): Promise<{
    defaultNotesDestination?: string;
    defaultNotesHostId?: string;
  }>;
}

interface ResolvedNotesDestination {
  scope: FileScope;
  directory: string;
}

async function resolveNotesDestination(
  bb: BbPluginApi,
  input: CreateNoteRequest,
  settings?: NotesSettingsHandle,
): Promise<ResolvedNotesDestination> {
  if (input.directory !== undefined) {
    const parsed = parseRelativePath(input.directory, { allowEmpty: true });
    return {
      scope: input.currentScope ?? { kind: "host" },
      directory: parsed.normalized,
    };
  }

  let rawDestination = (input.destination ?? "").trim();
  let rawHostId = (input.hostId ?? "").trim() || undefined;

  if (rawDestination.length === 0 && settings !== undefined) {
    try {
      const stored = await settings.get();
      rawDestination = (stored.defaultNotesDestination ?? "").trim();
      if (rawHostId === undefined) {
        rawHostId = (stored.defaultNotesHostId ?? "").trim() || undefined;
      }
    } catch {
      // Treat unreadable or missing settings as empty fallback
    }
  }

  if (rawDestination.length === 0) {
    return {
      scope: input.currentScope ?? { kind: "host" },
      directory: "",
    };
  }

  if (rawDestination.startsWith("proj_")) {
    const slashIndex = rawDestination.indexOf("/");
    const projectId = slashIndex === -1 ? rawDestination : rawDestination.slice(0, slashIndex);
    const subfolder = slashIndex === -1 ? "" : rawDestination.slice(slashIndex + 1);

    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources?.find((s) => s.isDefault) ?? project.sources?.[0];
    if (!source || !source.path) {
      throw new Error(`Configured notes project ${projectId} has no valid directory source.`);
    }

    const hostId = rawHostId ?? source.hostId;
    const rootPath = posix.normalize(source.path);
    const directory = subfolder.length > 0
      ? parseRelativePath(subfolder, { allowEmpty: true }).normalized
      : "";

    return {
      scope: hostId ? { kind: "host", hostId, rootPath } : { kind: "host", rootPath },
      directory,
    };
  }

  if (rawDestination.startsWith("/")) {
    if (rawDestination.includes("\0")) {
      throw new Error("Path must not contain NUL bytes.");
    }
    const normalizedTarget = posix.normalize(rawDestination);
    let hostId = rawHostId;
    if (hostId === undefined && input.currentScope !== undefined) {
      hostId = (await resolveFileRoot(bb.sdk, input.currentScope)).hostId;
      if (input.currentScope.kind !== "host" && !hostId) {
        throw new Error("Cannot resolve the notes destination's owning host; configure a notes host explicitly.");
      }
    }

    let rootPath = normalizedTarget;
    try {
      const projects = await bb.sdk.projects.list();
      const projectList = Array.isArray(projects) ? projects : [];
      const roots = projectList.flatMap((project) => project.sources ?? [])
        .filter((source) => (source.hostId ?? undefined) === hostId && source.path?.startsWith("/") && !source.path.includes("\0"))
        .map((source) => posix.normalize(source.path!))
        .filter((root) => normalizedTarget === root || normalizedTarget.startsWith(root === "/" ? "/" : `${root}/`))
        .sort((a, b) => b.length - a.length);
      rootPath = roots[0] ?? rootPath;
    } catch {
      // Host ownership is already resolved; an unavailable project list cannot change it.
    }

    if (rootPath === normalizedTarget && hostId !== undefined) {
      const ancestors: string[] = [];
      for (let candidate = rootPath; ; candidate = posix.dirname(candidate)) {
        ancestors.push(candidate);
        if (candidate === "/") break;
      }
      const markers = ancestors.map((candidate) => posix.join(candidate, ".git"));
      try {
        const { existence } = await bb.sdk.hosts.pathsExist({ hostId, paths: markers });
        rootPath = ancestors.find((candidate) => existence[posix.join(candidate, ".git")]) ?? rootPath;
      } catch {
        // Fall back to target directory
      }
    }

    const relative = posix.relative(rootPath, normalizedTarget);
    const directory = relative.length === 0 || relative === "." ? "" : parseRelativePath(relative, { allowEmpty: true }).normalized;

    return {
      scope: hostId ? { kind: "host", hostId, rootPath } : { kind: "host", rootPath },
      directory,
    };
  }

  let projectList: Awaited<ReturnType<typeof bb.sdk.projects.list>> = [];
  try {
    const projects = await bb.sdk.projects.list();
    projectList = Array.isArray(projects) ? projects : [];
  } catch {
    // Relative folders remain usable if project listing is unavailable.
  }

  const slashIndex = rawDestination.indexOf("/");
  const projectNameCandidate = slashIndex === -1 ? rawDestination : rawDestination.slice(0, slashIndex);
  const subfolderCandidate = slashIndex === -1 ? "" : rawDestination.slice(slashIndex + 1);
  const matches = projectList.filter(
    (project) =>
      project.name === rawDestination ||
      (slashIndex !== -1 && project.name === projectNameCandidate),
  );
  if (matches.length > 1) {
    throw new Error(`Notes destination ${rawDestination} matches multiple projects; use a project ID.`);
  }
  const matched = matches[0];
  if (matched) {
    const source = matched.sources?.find((candidate) => candidate.isDefault) ?? matched.sources?.[0];
    if (!source?.path) {
      throw new Error(`Configured notes project ${matched.name} has no valid directory source.`);
    }
    const hostId = rawHostId ?? source.hostId;
    const rootPath = posix.normalize(source.path);
    const subfolder = matched.name === projectNameCandidate && slashIndex !== -1 ? subfolderCandidate : "";
    const directory = subfolder.length > 0
      ? parseRelativePath(subfolder, { allowEmpty: true }).normalized
      : "";
    return {
      scope: hostId ? { kind: "host", hostId, rootPath } : { kind: "host", rootPath },
      directory,
    };
  }

  const parsed = parseRelativePath(rawDestination, { allowEmpty: false });
  return {
    scope: input.currentScope ?? { kind: "host" },
    directory: parsed.normalized,
  };
}

export function createFileService(bb: BbPluginApi, settings?: NotesSettingsHandle) {
  async function target(scope: FileScope) {
    return resolveFileRoot(bb.sdk, scope);
  }

  let openerFlagsCache: {
    atMs: number;
    value: { annotateAvailable: boolean; sqlAvailable: boolean };
  } | null = null;
  async function cachedOpenerFlags() {
    if (
      openerFlagsCache !== null &&
      Date.now() - openerFlagsCache.atMs < OPENER_FLAGS_TTL_MS
    ) {
      return openerFlagsCache.value;
    }
    const value = await openerPluginFlags(bb);
    openerFlagsCache = { atMs: Date.now(), value };
    return value;
  }

  /**
   * Build a scope's index. The local host is walked directly — this server
   * runs on that machine — which is what lets the build report progress and
   * stop at a budget. Another machine's root can only be listed through the
   * daemon, which reports nothing until it returns.
   */
  function buildIndex(
    scope: FileScope,
    environment: FileRoot,
    onProgress: (scanned: number, entries: IndexEntry[]) => void,
  ): Promise<BuiltIndex> {
    if (environment.hostId === undefined) {
      return walkDirectoryIndex({
        rootPath: environment.rootPath,
        // The panel's tree hides dot-entries on a host root, so the global
        // index does too. A workspace keeps them: `.github` and `.pi` are
        // exactly what one searches a repository for.
        includeHidden: scope.kind !== "host",
        onProgress,
      });
    }
    return bb.sdk.files
      .listPaths({
        hostId: environment.hostId,
        path: environment.rootPath,
        includeFiles: true,
        includeDirectories: true,
        limit: TREE_LIMIT,
      })
      .then((result) => ({
        ...indexFromPaths(result.paths),
        truncated: result.truncated,
      }));
  }

  return {
    async listTree({
      scope,
      query,
      force,
    }: {
      scope: FileScope;
      query: string;
      force?: boolean;
    }) {
      const environment = await target(scope);
      const outcome = await fileIndexCache.search(scope, query, {
        force,
        build: (onProgress) => buildIndex(scope, environment, onProgress),
      });
      const openerFlags = await cachedOpenerFlags();

      return {
        rootName: rootLabel(scope, environment.rootPath),
        entries: outcome.entries,
        // Either the index stops at its own ceiling (there are more paths than
        // it holds) or the hit list is full, which also means "there is more".
        truncated:
          outcome.truncated || outcome.entries.length >= MAX_SEARCH_RESULTS,
        ...openerFlags,
        status: outcome.status,
        indexedCount: outcome.indexedCount,
        indexedAtMs: outcome.indexedAtMs,
        indexingSinceMs: outcome.indexingSinceMs,
      };
    },

    // Single-level directory read for the lazily-expanding tree. Costs one
    // shallow host.browse_directory call regardless of workspace size,
    // unlike listTree's recursive host.list_paths walk.
    async listDirectory({ scope, path }: { scope: FileScope; path: string }) {
      const environment = await target(scope);
      const resolved = resolveProjectPath(environment.rootPath, path, {
        allowEmpty: true,
      });
      const hostId = environment.hostId;
      const children =
        hostId === undefined
          ? await listLocalDirectory(resolved.absolutePath)
          : (
              await bb.sdk.hosts.directory({
                hostId,
                path: resolved.absolutePath,
              })
            ).entries;
      const entries: TreeEntryLike[] = children.map((entry) => ({
        kind: entry.kind,
        path: joinProjectPaths(resolved.relativePath, entry.name),
        name: entry.name,
        score: 0,
        positions: [],
      }));

      if (resolved.relativePath.length > 0) {
        return { path: resolved.relativePath, entries };
      }

      if (scope.kind === "thread") {
        await appendRootDotfileProbes(bb, environment, entries);
      }

      const openerFlags = await cachedOpenerFlags();

      return {
        path: "",
        entries,
        rootName: rootLabel(scope, environment.rootPath),
        ...openerFlags,
      };
    },

    async openFile({ scope, path }: { scope: FileScope; path: string }) {
      if (scope.kind !== "thread") {
        throw new Error(
          "Opening a file in BB's own preview needs an active thread.",
        );
      }
      const parsed = parseRelativePath(path, { allowEmpty: false });
      return bb.sdk.threads.open({
        threadId: scope.threadId,
        file: {
          source: "workspace",
          path: parsed.normalized,
          lineNumber: null,
        },
      });
    },

    // A file link from another surface names its own source. Resolve it without
    // consulting the active thread and keep that identity for later operations.
    async resolveOpenerFile({
      source,
      path,
    }: {
      source: {
        kind: "workspace" | "host" | "thread-storage";
        threadId: string | null;
        experimental_hostId?: string;
      };
      path: string;
    }) {
      if (source.kind === "workspace") {
        if (source.threadId === null) {
          return { kind: "unsupported" as const, reason: "no-thread" as const };
        }
        try {
          const normalized = parseRelativePath(
            path.replace(/^(?:\.\/)+/u, ""),
            { allowEmpty: false },
          ).normalized;
          return {
            kind: "file" as const,
            scope: { kind: "thread" as const, threadId: source.threadId },
            path: normalized,
          };
        } catch {
          return { kind: "unsupported" as const, reason: "invalid-path" as const };
        }
      }
      if (source.kind === "thread-storage") {
        if (source.threadId === null) {
          return { kind: "unsupported" as const, reason: "no-thread" as const };
        }
        try {
          const normalized = parseRelativePath(
            path.replace(/^(?:\.\/)+/u, ""),
            { allowEmpty: false },
          ).normalized;
          return {
            kind: "file" as const,
            scope: { kind: "thread-storage" as const, threadId: source.threadId },
            path: normalized,
          };
        } catch {
          return { kind: "unsupported" as const, reason: "invalid-path" as const };
        }
      }
      if (!path.startsWith("/")) {
        return { kind: "unsupported" as const, reason: "not-absolute" as const };
      }
      const hostId =
        source.experimental_hostId ??
        (source.threadId === null
          ? undefined
          : (await resolveThreadEnvironment(bb.sdk, source.threadId)).hostId);
      const initialTarget = hostTargetForAbsolutePath(path, hostId);
      if (initialTarget === null) {
        return { kind: "unsupported" as const, reason: "no-file-name" as const };
      }
      let rootPath = posix.dirname(posix.normalize(path));
      if (hostId !== undefined) {
        const ancestors: string[] = [];
        for (let candidate = rootPath; ; candidate = posix.dirname(candidate)) {
          ancestors.push(candidate);
          if (candidate === "/") break;
        }
        const markers = ancestors.map((candidate) => posix.join(candidate, ".git"));
        try {
          const { existence } = await bb.sdk.hosts.pathsExist({ hostId, paths: markers });
          rootPath = ancestors.find((candidate) => existence[posix.join(candidate, ".git")]) ?? rootPath;
        } catch {
          // A failed root probe never widens the containing-directory boundary.
        }
      }
      const absolutePath = posix.normalize(path);
      const relativePath = posix.relative(rootPath, absolutePath);
      try {
        const normalized = parseRelativePath(relativePath, { allowEmpty: false }).normalized;
        return {
          kind: "file" as const,
          scope:
            hostId === undefined
              ? { kind: "host" as const, rootPath }
              : { kind: "host" as const, hostId, rootPath },
          path: normalized,
        };
      } catch {
        return { kind: "unsupported" as const, reason: "invalid-path" as const };
      }
    },

    async readFile({ scope, path }: { scope: FileScope; path: string }) {
      const environment = await target(scope);
      const resolved = resolveProjectPath(environment.rootPath, path, {
        allowEmpty: false,
      });
      const file = await bb.sdk.files.read({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
      });
      const metadata = fileMetadata(resolved.relativePath, file);
      if (file.contentEncoding !== "utf8") {
        return {
          state: "unsupported" as const,
          ...metadata,
          reason: "binary" as const,
        };
      }
      if (file.sizeBytes > MAX_TEXT_BYTES) {
        return {
          state: "unsupported" as const,
          ...metadata,
          reason: "too-large" as const,
        };
      }
      return { state: "text" as const, ...metadata, content: file.content };
    },

    async saveFile(input: {
      scope: FileScope;
      path: string;
      content: string;
      expectedSha256: string;
    }) {
      const environment = await target(input.scope);
      const resolved = resolveProjectPath(environment.rootPath, input.path, {
        allowEmpty: false,
      });
      return bb.sdk.files.write({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        content: input.content,
        contentEncoding: "utf8",
        expectedSha256: input.expectedSha256,
      });
    },

    async overwriteFile(input: {
      scope: FileScope;
      path: string;
      content: string;
    }) {
      const environment = await target(input.scope);
      const resolved = resolveProjectPath(environment.rootPath, input.path, {
        allowEmpty: false,
      });
      return bb.sdk.files.write({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        content: input.content,
        contentEncoding: "utf8",
      });
    },

    async createFile({ scope, path }: { scope: FileScope; path: string }) {
      const environment = await target(scope);
      const resolved = resolveProjectPath(environment.rootPath, path, {
        allowEmpty: false,
      });
      const result = await bb.sdk.files.write({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        content: "",
        contentEncoding: "utf8",
        expectedSha256: null,
      });
      fileIndexCache.invalidate(scope);
      return result;
    },

    async createDirectory({ scope, path }: { scope: FileScope; path: string }) {
      const environment = await target(scope);
      const resolved = resolveProjectPath(environment.rootPath, path, {
        allowEmpty: false,
      });
      const result = await bb.sdk.files.mkdir({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        recursive: false,
      });
      fileIndexCache.invalidate(scope);
      return result;
    },

    async movePath(input: {
      scope: FileScope;
      sourcePath: string;
      destinationPath: string;
    }) {
      const environment = await target(input.scope);
      const source = resolveProjectPath(
        environment.rootPath,
        input.sourcePath,
        { allowEmpty: false },
      );
      const destination = resolveProjectPath(
        environment.rootPath,
        input.destinationPath,
        { allowEmpty: false },
      );
      const result = await bb.sdk.files.move({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        sourcePath: source.absolutePath,
        destinationPath: destination.absolutePath,
      });
      fileIndexCache.invalidate(input.scope);
      return result;
    },

    async removePath(input: {
      scope: FileScope;
      path: string;
      recursive: boolean;
    }) {
      const environment = await target(input.scope);
      const resolved = resolveProjectPath(environment.rootPath, input.path, {
        allowEmpty: false,
      });
      const result = await bb.sdk.files.remove({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        recursive: input.recursive,
      });
      fileIndexCache.invalidate(input.scope);
      return result;
    },

    async duplicatePath(input: {
      scope: FileScope;
      kind: "file" | "directory";
      sourcePath: string;
      destinationPath: string;
    }) {
      const environment = await target(input.scope);
      const args = {
        files: bb.sdk.files,
        target: environment,
        sourcePath: input.sourcePath,
        destinationPath: input.destinationPath,
      };
      const result =
        input.kind === "file"
          ? await duplicateFile(args)
          : await duplicateDirectory(args);
      fileIndexCache.invalidate(input.scope);
      return result;
    },

    async getDownloadUrl({ scope, path }: { scope: FileScope; path: string }) {
      const environment = await target(scope);
      const resolved = resolveProjectPath(environment.rootPath, path, {
        allowEmpty: false,
      });
      const preview = await bb.sdk.files.createPreview({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
      });
      const encodedPath = resolved.relativePath
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return { url: `${preview.baseUrl}/${encodedPath}` };
    },

    async createNote(input: CreateNoteRequest) {
      const targetDest = await resolveNotesDestination(bb, input, settings);
      const environment = await target(targetDest.scope);

      if (targetDest.directory.length > 0) {
        const dirResolved = resolveProjectPath(environment.rootPath, targetDest.directory, {
          allowEmpty: true,
        });
        try {
          await bb.sdk.files.mkdir({
            hostId: environment.hostId,
            rootPath: environment.rootPath,
            path: dirResolved.absolutePath,
            recursive: true,
          });
        } catch {
          // Ignore if directory already exists
        }
      }

      const MAX_ATTEMPTS = 100;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const fileName = attempt === 0 ? "Untitled.md" : `Untitled ${attempt}.md`;
        const relativePath =
          targetDest.directory.length === 0
            ? fileName
            : `${targetDest.directory}/${fileName}`;
        const resolved = resolveProjectPath(environment.rootPath, relativePath, {
          allowEmpty: false,
        });

        const result = await bb.sdk.files.write({
          hostId: environment.hostId,
          rootPath: environment.rootPath,
          path: resolved.absolutePath,
          content: "",
          contentEncoding: "utf8",
          expectedSha256: null,
        });

        if (result.outcome === "written") {
          fileIndexCache.invalidate(targetDest.scope);
          return {
            scope: targetDest.scope,
            path: resolved.relativePath,
            name: fileName,
            absolutePath: resolved.absolutePath,
            sha256: result.sha256,
          };
        }

        if (result.outcome === "conflict") {
          continue;
        }

        throw new Error(
          `Write failed with unexpected outcome: ${(result as { outcome: string }).outcome}`,
        );
      }

      throw new Error(
        `Could not allocate a unique note name after ${MAX_ATTEMPTS} attempts.`,
      );
    },
  };
}
