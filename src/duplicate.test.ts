import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_COPY_LIMIT,
  duplicateDirectory,
  type FilesSdk,
} from "./duplicate";

function fakeFiles(overrides: Partial<FilesSdk> = {}): FilesSdk {
  return {
    createPreview: async () => ({ baseUrl: "/preview", expiresAtMs: 1 }),
    list: async () => ({ files: [], truncated: false }),
    listPaths: async () => ({ paths: [], truncated: false }),
    mkdir: async () => ({ ok: true }),
    move: async () => ({ ok: true }),
    read: async ({ path }) => ({
      path,
      content: "content",
      contentEncoding: "utf8",
      mimeType: "text/plain",
      sha256: "sha",
      sizeBytes: 7,
      modifiedAtMs: 1,
    }),
    remove: async () => ({ ok: true }),
    write: async () => ({ outcome: "written", sha256: "sha", sizeBytes: 7 }),
    ...overrides,
  };
}

const target = { hostId: "host_remote", rootPath: "/work/repo" };

describe("folder duplication", () => {
  it("rejects an oversized preflight before reserving a destination", async () => {
    const mkdir = vi.fn(async () => ({ ok: true as const }));
    const files = fakeFiles({
      mkdir,
      listPaths: async () => ({
        paths: Array.from({ length: DIRECTORY_COPY_LIMIT + 1 }, (_, index) => ({
          kind: "file" as const,
          path: `file-${index}.txt`,
          name: `file-${index}.txt`,
          score: 0,
          positions: [],
        })),
        truncated: false,
      }),
    });

    await expect(
      duplicateDirectory({
        files,
        target,
        sourcePath: "source",
        destinationPath: "copy",
      }),
    ).rejects.toThrow("limited to 500 entries");
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("reserves the root, creates directories first, then copies files", async () => {
    const operations: string[] = [];
    const files = fakeFiles({
      listPaths: async () => ({
        paths: [
          { kind: "file", path: "nested/a.txt", name: "a.txt", score: 0, positions: [] },
          { kind: "directory", path: "nested", name: "nested", score: 0, positions: [] },
        ],
        truncated: false,
      }),
      mkdir: async ({ path }) => {
        operations.push(`mkdir:${path}`);
        return { ok: true };
      },
      read: async ({ path }) => {
        operations.push(`read:${path}`);
        return {
          path,
          content: "a",
          contentEncoding: "utf8",
          mimeType: "text/plain",
          sha256: "sha-a",
          sizeBytes: 1,
          modifiedAtMs: 1,
        };
      },
      write: async ({ path, expectedSha256 }) => {
        operations.push(`write:${path}:${String(expectedSha256)}`);
        return { outcome: "written", sha256: "sha-copy", sizeBytes: 1 };
      },
    });

    const result = await duplicateDirectory({
      files,
      target,
      sourcePath: "source",
      destinationPath: "copy",
    });

    expect(result).toEqual({
      outcome: "copied",
      createdPaths: ["copy", "copy/nested", "copy/nested/a.txt"],
    });
    expect(operations).toEqual([
      "mkdir:/work/repo/copy",
      "mkdir:/work/repo/copy/nested",
      "read:/work/repo/source/nested/a.txt",
      "write:/work/repo/copy/nested/a.txt:null",
    ]);
  });

  it("reports created paths when a post-reservation copy fails", async () => {
    const files = fakeFiles({
      listPaths: async () => ({
        paths: [{ kind: "file", path: "a.txt", name: "a.txt", score: 0, positions: [] }],
        truncated: false,
      }),
      write: async () => {
        throw new Error("remote disconnected");
      },
    });

    await expect(
      duplicateDirectory({
        files,
        target,
        sourcePath: "source",
        destinationPath: "copy",
      }),
    ).resolves.toEqual({
      outcome: "partial",
      createdPaths: ["copy"],
      error: "remote disconnected",
    });
  });
});
