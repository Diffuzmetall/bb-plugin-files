import type { BbPluginApi } from "@bb/plugin-sdk";
import { joinProjectPaths, resolveProjectPath } from "./path-policy";
import type { ThreadEnvironmentTarget } from "./environment";

export const DIRECTORY_COPY_LIMIT = 500;

export type FilesSdk = BbPluginApi["sdk"]["files"];

export type DuplicateResult =
  | { outcome: "copied"; createdPaths: string[] }
  | { outcome: "partial"; createdPaths: string[]; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function duplicateFile(args: {
  files: FilesSdk;
  target: ThreadEnvironmentTarget;
  sourcePath: string;
  destinationPath: string;
}): Promise<DuplicateResult> {
  const source = resolveProjectPath(args.target.rootPath, args.sourcePath, {
    allowEmpty: false,
  });
  const destination = resolveProjectPath(
    args.target.rootPath,
    args.destinationPath,
    { allowEmpty: false },
  );
  const file = await args.files.read({
    hostId: args.target.hostId,
    rootPath: args.target.rootPath,
    path: source.absolutePath,
  });
  const written = await args.files.write({
    hostId: args.target.hostId,
    rootPath: args.target.rootPath,
    path: destination.absolutePath,
    content: file.content,
    contentEncoding: file.contentEncoding,
    expectedSha256: null,
  });
  if (written.outcome === "conflict") {
    throw new Error(`Destination already exists: ${destination.relativePath}`);
  }
  return { outcome: "copied", createdPaths: [destination.relativePath] };
}

export async function duplicateDirectory(args: {
  files: FilesSdk;
  target: ThreadEnvironmentTarget;
  sourcePath: string;
  destinationPath: string;
}): Promise<DuplicateResult> {
  const source = resolveProjectPath(args.target.rootPath, args.sourcePath, {
    allowEmpty: false,
  });
  const destination = resolveProjectPath(
    args.target.rootPath,
    args.destinationPath,
    { allowEmpty: false },
  );
  const listing = await args.files.listPaths({
    hostId: args.target.hostId,
    path: source.absolutePath,
    includeFiles: true,
    includeDirectories: true,
    limit: DIRECTORY_COPY_LIMIT + 1,
  });
  if (listing.truncated || listing.paths.length > DIRECTORY_COPY_LIMIT) {
    throw new Error(
      `Folder duplication is limited to ${DIRECTORY_COPY_LIMIT} entries.`,
    );
  }

  const entries = listing.paths.map((entry) => ({
    ...entry,
    sourceRelative: joinProjectPaths(source.relativePath, entry.path),
    destinationRelative: joinProjectPaths(
      destination.relativePath,
      entry.path,
    ),
  }));
  const directories = entries
    .filter((entry) => entry.kind === "directory")
    .sort(
      (left, right) =>
        left.destinationRelative.split("/").length -
        right.destinationRelative.split("/").length,
    );
  const files = entries.filter((entry) => entry.kind === "file");
  const createdPaths: string[] = [];

  try {
    await args.files.mkdir({
      hostId: args.target.hostId,
      rootPath: args.target.rootPath,
      path: destination.absolutePath,
      recursive: false,
    });
    createdPaths.push(destination.relativePath);

    for (const directory of directories) {
      const resolved = resolveProjectPath(
        args.target.rootPath,
        directory.destinationRelative,
        { allowEmpty: false },
      );
      await args.files.mkdir({
        hostId: args.target.hostId,
        rootPath: args.target.rootPath,
        path: resolved.absolutePath,
        recursive: false,
      });
      createdPaths.push(directory.destinationRelative);
    }

    for (const entry of files) {
      const sourceFile = resolveProjectPath(
        args.target.rootPath,
        entry.sourceRelative,
        { allowEmpty: false },
      );
      const destinationFile = resolveProjectPath(
        args.target.rootPath,
        entry.destinationRelative,
        { allowEmpty: false },
      );
      const content = await args.files.read({
        hostId: args.target.hostId,
        rootPath: args.target.rootPath,
        path: sourceFile.absolutePath,
      });
      const written = await args.files.write({
        hostId: args.target.hostId,
        rootPath: args.target.rootPath,
        path: destinationFile.absolutePath,
        content: content.content,
        contentEncoding: content.contentEncoding,
        expectedSha256: null,
      });
      if (written.outcome === "conflict") {
        throw new Error(`Destination already exists: ${entry.destinationRelative}`);
      }
      createdPaths.push(entry.destinationRelative);
    }
  } catch (error) {
    if (createdPaths.length === 0) throw error;
    return {
      outcome: "partial",
      createdPaths,
      error: errorMessage(error),
    };
  }

  return { outcome: "copied", createdPaths };
}
