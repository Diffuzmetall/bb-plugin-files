import type { BbPluginApi } from "@bb/plugin-sdk";
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
  ".gitignore", ".env", ".env.local", ".env.development", ".env.production",
  ".pi", ".github", ".vscode", ".cursorrules", ".cursorignore",
  ".npmrc", ".nvmrc", ".yarnrc",
  ".dockerignore", ".editorconfig",
  ".prettierrc", ".eslintrc", ".eslintrc.json", ".eslintrc.js"
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
      const resolved = resolveProjectPath(environment.rootPath, name, { allowEmpty: false });
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
        if (errorStr.includes("404") || errorStr.includes("not exist") || errorStr.includes("path_not_found")) {
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

export function createFileService(bb: BbPluginApi) {
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
        includeHidden: scope.kind === "thread",
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
          outcome.truncated ||
          outcome.entries.length >= MAX_SEARCH_RESULTS,
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

    // A file link from another surface names its own source, and only an
    // absolute host path has to be re-rooted: the panel cannot read outside its
    // root, so it moves to the file's directory instead of widening the root.
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
      if (source.kind === "thread-storage") {
        return {
          kind: "unsupported" as const,
          reason: "thread-storage" as const,
        };
      }
      if (source.kind === "workspace" && !path.startsWith("/")) {
        if (source.threadId === null) {
          return { kind: "unsupported" as const, reason: "no-thread" as const };
        }
        return {
          kind: "file" as const,
          scope: { kind: "thread" as const, threadId: source.threadId },
          path,
        };
      }
      if (!path.startsWith("/")) {
        return {
          kind: "unsupported" as const,
          reason: "not-absolute" as const,
        };
      }
      // A host link is only readable on the machine that owns it, so an
      // explicit host wins and otherwise the thread's own machine does.
      const hostId =
        source.experimental_hostId ??
        (source.threadId === null
          ? undefined
          : (await resolveThreadEnvironment(bb.sdk, source.threadId)).hostId);
      const target = hostTargetForAbsolutePath(path, hostId);
      return target === null
        ? { kind: "unsupported" as const, reason: "no-file-name" as const }
        : { kind: "file" as const, scope: target.scope, path: target.path };
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
        return { state: "unsupported" as const, ...metadata, reason: "binary" as const };
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

    async createDirectory({
      scope,
      path,
    }: {
      scope: FileScope;
      path: string;
    }) {
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
  };
}
