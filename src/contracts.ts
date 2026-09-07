import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

const threadIdSchema = z.string().trim().min(1);
const relativePathSchema = z.string();
const targetPathSchema = z.string().min(1);

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
      .object({ threadId: threadIdSchema, query: z.string() })
      .strict(),
    output: z
      .object({
        rootName: z.string().min(1),
        entries: z.array(treeEntrySchema),
        truncated: z.boolean(),
        annotateAvailable: z.boolean(),
        sqlAvailable: z.boolean(),
      })
      .strict(),
  },
  // Single-level directory listing for the lazily-expanding tree. Unlike
  // listTree (a recursive walk used only for search), this reads exactly one
  // directory so expanding a folder costs one shallow call instead of
  // re-scanning the whole workspace.
  listDirectory: {
    input: z
      .object({ threadId: threadIdSchema, path: z.string() })
      .strict(),
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
      .object({ threadId: threadIdSchema, path: targetPathSchema })
      .strict(),
    output: readFileResultSchema,
  },
  openFile: {
    input: z
      .object({ threadId: threadIdSchema, path: targetPathSchema })
      .strict(),
    output: z.object({ delivered: z.number().int().nonnegative() }).strict(),
  },
  saveFile: {
    input: z
      .object({
        threadId: threadIdSchema,
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
        threadId: threadIdSchema,
        path: targetPathSchema,
        content: z.string(),
      })
      .strict(),
    output: writeResultSchema,
  },
  createFile: {
    input: z
      .object({ threadId: threadIdSchema, path: targetPathSchema })
      .strict(),
    output: writeResultSchema,
  },
  createDirectory: {
    input: z
      .object({ threadId: threadIdSchema, path: targetPathSchema })
      .strict(),
    output: mutationOkSchema,
  },
  movePath: {
    input: z
      .object({
        threadId: threadIdSchema,
        sourcePath: targetPathSchema,
        destinationPath: targetPathSchema,
      })
      .strict(),
    output: mutationOkSchema,
  },
  removePath: {
    input: z
      .object({
        threadId: threadIdSchema,
        path: targetPathSchema,
        recursive: z.boolean(),
      })
      .strict(),
    output: mutationOkSchema,
  },
  duplicatePath: {
    input: z
      .object({
        threadId: threadIdSchema,
        kind: z.enum(["file", "directory"]),
        sourcePath: targetPathSchema,
        destinationPath: targetPathSchema,
      })
      .strict(),
    output: duplicateResultSchema,
  },
  getDownloadUrl: {
    input: z
      .object({ threadId: threadIdSchema, path: targetPathSchema })
      .strict(),
    output: z.object({ url: z.string().min(1) }).strict(),
  },
});

export type TreeEntry = z.infer<typeof treeEntrySchema>;
export type ReadFileResult = z.infer<typeof readFileResultSchema>;

// Kept exported for tests and UI helpers that need to validate a tree scope.
export const treeScopePathSchema = relativePathSchema;
