import type { BbPluginApi } from "@bb/plugin-sdk";
import { resolveThreadEnvironment } from "./environment";
import { duplicateDirectory, duplicateFile } from "./duplicate";
import {
  parseRelativePath,
  projectBasename,
  resolveProjectPath,
} from "./path-policy";

export const TREE_LIMIT = 10_000;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

type FilesSdk = BbPluginApi["sdk"]["files"];

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
  async function target(threadId: string) {
    return resolveThreadEnvironment(bb.sdk, threadId);
  }

  return {
    async listTree({ threadId, query }: { threadId: string; query: string }) {
      const environment = await target(threadId);
      const result = await bb.sdk.files.listPaths({
        hostId: environment.hostId,
        path: environment.rootPath,
        includeFiles: true,
        includeDirectories: true,
        limit: TREE_LIMIT,
        ...(query.length > 0 ? { query } : {}),
      });
      const entries = result.paths.map((entry) => {
        const parsed = parseRelativePath(entry.path, { allowEmpty: false });
        return {
          kind: entry.kind,
          path: parsed.normalized,
          name: entry.name,
          score: entry.score,
          positions: entry.positions,
        };
      });

      if (query.length === 0) {
        const probes = [
          ".gitignore", ".env", ".env.local", ".env.development", ".env.production",
          ".pi", ".github", ".vscode", ".cursorrules", ".cursorignore",
          ".npmrc", ".nvmrc", ".yarnrc",
          ".dockerignore", ".editorconfig",
          ".prettierrc", ".eslintrc", ".eslintrc.json", ".eslintrc.js"
        ];
        await Promise.all(
          probes.map(async (name) => {
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
                  const childPath = name + "/" + child.path;
                  entries.push({
                    kind: child.kind,
                    path: childPath,
                    name: child.name,
                    score: 0,
                    positions: [],
                  });
                }
              }
            } catch {
              // Item does not exist, ignore
            }
          })
        );
      }

      return {
        rootName: projectBasename(environment.rootPath),
        entries,
        truncated: result.truncated,
      };
    },

    async openFile({ threadId, path }: { threadId: string; path: string }) {
      const parsed = parseRelativePath(path, { allowEmpty: false });
      return bb.sdk.threads.open({
        threadId,
        file: {
          source: "workspace",
          path: parsed.normalized,
          lineNumber: null,
        },
      });
    },

    async readFile({ threadId, path }: { threadId: string; path: string }) {
      const environment = await target(threadId);
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
      threadId: string;
      path: string;
      content: string;
      expectedSha256: string;
    }) {
      const environment = await target(input.threadId);
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
      threadId: string;
      path: string;
      content: string;
    }) {
      const environment = await target(input.threadId);
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

    async createFile({ threadId, path }: { threadId: string; path: string }) {
      const environment = await target(threadId);
      const resolved = resolveProjectPath(environment.rootPath, path, {
        allowEmpty: false,
      });
      return bb.sdk.files.write({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        content: "",
        contentEncoding: "utf8",
        expectedSha256: null,
      });
    },

    async createDirectory({
      threadId,
      path,
    }: {
      threadId: string;
      path: string;
    }) {
      const environment = await target(threadId);
      const resolved = resolveProjectPath(environment.rootPath, path, {
        allowEmpty: false,
      });
      return bb.sdk.files.mkdir({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        recursive: false,
      });
    },

    async movePath(input: {
      threadId: string;
      sourcePath: string;
      destinationPath: string;
    }) {
      const environment = await target(input.threadId);
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
      return bb.sdk.files.move({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        sourcePath: source.absolutePath,
        destinationPath: destination.absolutePath,
      });
    },

    async removePath(input: {
      threadId: string;
      path: string;
      recursive: boolean;
    }) {
      const environment = await target(input.threadId);
      const resolved = resolveProjectPath(environment.rootPath, input.path, {
        allowEmpty: false,
      });
      return bb.sdk.files.remove({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        recursive: input.recursive,
      });
    },

    async duplicatePath(input: {
      threadId: string;
      kind: "file" | "directory";
      sourcePath: string;
      destinationPath: string;
    }) {
      const environment = await target(input.threadId);
      const args = {
        files: bb.sdk.files,
        target: environment,
        sourcePath: input.sourcePath,
        destinationPath: input.destinationPath,
      };
      return input.kind === "file"
        ? duplicateFile(args)
        : duplicateDirectory(args);
    },

    async getDownloadUrl({ threadId, path }: { threadId: string; path: string }) {
      const environment = await target(threadId);
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
