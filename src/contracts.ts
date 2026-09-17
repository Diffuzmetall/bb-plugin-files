import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

const threadIdSchema = z.string().trim().min(1);

/**
 * The root a request runs against. `thread` is the thread's live workspace;
 * `host` is an absolute root on a machine — with no `rootPath` it is this
 * machine's home directory, which is what the left-sidebar Files panel opens.
 */
export const fileScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: threadIdSchema }).strict(),
  z
    .object({
      kind: z.literal("host"),
      hostId: z.string().trim().min(1).optional(),
      rootPath: z.string().min(1).optional(),
    })
    .strict(),
]);
const relativePathSchema = z.string();
const targetPathSchema = z.string().min(1);

/**
 * A file link handed over by another surface, as BB passes it to an opener.
 * `experimental_hostId` is BB's explicit host for a host link and is absent on
 * older hosts; the server falls back to the thread's own environment.
 */
const openerSourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: threadIdSchema.nullable(),
    experimental_hostId: z.string().trim().min(1).optional(),
  })
  .strict();

export const treeEntrySchema = z
  .object({
    kind: z.enum(["file", "directory"]),
    path: z.string().min(1),
    name: z.string().min(1),
    score: z.number(),
    positions: z.array(z.number().int().nonnegative()),
  })
  .strict();

const fileMetadataShape = {
  path: z.string().min(1),
  sha256: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().nullable(),
  modifiedAtMs: z.number().nullable(),
};

export const readFileResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("text"),
      ...fileMetadataShape,
      content: z.string(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unsupported"),
      ...fileMetadataShape,
      reason: z.enum(["binary", "too-large"]),
    })
    .strict(),
]);

const mutationOkSchema = z.object({ ok: z.literal(true) }).strict();
const writeResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("written"),
      sha256: z.string().min(1),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("conflict"),
      currentSha256: z.string().nullable(),
    })
    .strict(),
]);

const duplicateResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("copied"),
      createdPaths: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("partial"),
      createdPaths: z.array(z.string()),
      error: z.string().min(1),
    })
    .strict(),
]);

export const filesRpcContract = defineRpcContract({
  listTree: {
    input: z
      .object({
        scope: fileScopeSchema,
        query: z.string(),
        /** Rebuild the scope's path index instead of searching the cached one. */
        force: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        rootName: z.string().min(1),
        entries: z.array(treeEntrySchema),
        truncated: z.boolean(),
        annotateAvailable: z.boolean(),
        sqlAvailable: z.boolean(),
        /** `indexing` means the walk is still running: poll again. */
        status: z.enum(["ready", "indexing"]),
        /** Paths in the index, or paths scanned so far while it builds. */
        indexedCount: z.number().int().nonnegative(),
        indexedAtMs: z.number().nullable(),
        indexingSinceMs: z.number().nullable(),
      })
      .strict(),
  },
  // Single-level directory listing for the lazily-expanding tree. Unlike
  // listTree (a recursive walk used only for search), this reads exactly one
  // directory so expanding a folder costs one shallow call instead of
  // re-scanning the whole workspace.
  listDirectory: {
    input: z.object({ scope: fileScopeSchema, path: z.string() }).strict(),
    output: z
      .object({
        path: z.string(),
        entries: z.array(treeEntrySchema),
        // Present only for the root ("") listing.
        rootName: z.string().min(1).optional(),
        annotateAvailable: z.boolean().optional(),
        sqlAvailable: z.boolean().optional(),
      })
      .strict(),
  },
  readFile: {
    input: z
      .object({ scope: fileScopeSchema, path: targetPathSchema })
      .strict(),
    output: readFileResultSchema,
  },
  openFile: {
    input: z
      .object({ scope: fileScopeSchema, path: targetPathSchema })
      .strict(),
    output: z.object({ delivered: z.number().int().nonnegative() }).strict(),
  },
  // A file link from another surface arrives as a path plus the source it
  // belongs to. A workspace link stays in the thread scope; a host link is
  // absolute on the thread's machine and becomes a host root at the file's own
  // directory. Thread storage is not a root this panel can read.
  resolveOpenerFile: {
    input: z
      .object({ source: openerSourceSchema, path: z.string().min(1) })
      .strict(),
    output: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("file"),
          scope: fileScopeSchema,
          path: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("unsupported"),
          reason: z.enum([
            "thread-storage",
            "not-absolute",
            "no-file-name",
            "no-thread",
          ]),
        })
        .strict(),
    ]),
  },
  saveFile: {
    input: z
      .object({
        scope: fileScopeSchema,
        path: targetPathSchema,
        content: z.string(),
        expectedSha256: z.string().min(1),
      })
      .strict(),
    output: writeResultSchema,
  },
  overwriteFile: {
    input: z
      .object({
        scope: fileScopeSchema,
        path: targetPathSchema,
        content: z.string(),
      })
      .strict(),
    output: writeResultSchema,
  },
  createFile: {
    input: z
      .object({ scope: fileScopeSchema, path: targetPathSchema })
      .strict(),
    output: writeResultSchema,
  },
  createDirectory: {
    input: z
      .object({ scope: fileScopeSchema, path: targetPathSchema })
      .strict(),
    output: mutationOkSchema,
  },
  movePath: {
    input: z
      .object({
        scope: fileScopeSchema,
        sourcePath: targetPathSchema,
        destinationPath: targetPathSchema,
      })
      .strict(),
    output: mutationOkSchema,
  },
  removePath: {
    input: z
      .object({
        scope: fileScopeSchema,
        path: targetPathSchema,
        recursive: z.boolean(),
      })
      .strict(),
    output: mutationOkSchema,
  },
  duplicatePath: {
    input: z
      .object({
        scope: fileScopeSchema,
        kind: z.enum(["file", "directory"]),
        sourcePath: targetPathSchema,
        destinationPath: targetPathSchema,
      })
      .strict(),
    output: duplicateResultSchema,
  },
  getDownloadUrl: {
    input: z
      .object({ scope: fileScopeSchema, path: targetPathSchema })
      .strict(),
    output: z.object({ url: z.string().min(1) }).strict(),
  },
});

export type FileScope = z.infer<typeof fileScopeSchema>;
export type TreeEntry = z.infer<typeof treeEntrySchema>;
export type ReadFileResult = z.infer<typeof readFileResultSchema>;

// Kept exported for tests and UI helpers that need to validate a tree scope.
export const treeScopePathSchema = relativePathSchema;
