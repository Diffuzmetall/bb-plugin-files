import { describe, expect, it, vi } from "vitest";
import { createFileService } from "./file-service";

type Bb = Parameters<typeof createFileService>[0];

function service(
  threads: {
    get: ReturnType<typeof vi.fn>;
    storageLocation?: ReturnType<typeof vi.fn>;
  },
  pathsExist: ReturnType<typeof vi.fn> = vi.fn(async () => ({ existence: {} })),
  files: Record<string, ReturnType<typeof vi.fn>> = {},
) {
  return createFileService({
    sdk: { threads, hosts: { pathsExist }, files },
  } as unknown as Bb);
}

describe("resolveOpenerFile", () => {
  it("keeps a workspace link in the thread scope", async () => {
    const threads = { get: vi.fn() };
    const files = service(threads);

    await expect(
      files.resolveOpenerFile({
        source: { kind: "workspace", threadId: "thread-1" },
        path: "src/app.tsx",
      }),
    ).resolves.toEqual({
      kind: "file",
      scope: { kind: "thread", threadId: "thread-1" },
      path: "src/app.tsx",
    });
    expect(threads.get).not.toHaveBeenCalled();
  });

  it("re-roots a host link at the nearest Git root", async () => {
    const threads = { get: vi.fn() };
    const pathsExist = vi.fn(async ({ paths }: { paths: string[] }) => ({
      existence: Object.fromEntries(paths.map((path) => [path, path === "/home/ada/.git"])),
    }));
    const files = service(threads, pathsExist);

    await expect(
      files.resolveOpenerFile({
        source: { kind: "host", threadId: "thread-1", experimental_hostId: "host-7" },
        path: "/home/ada/.zshrc",
      }),
    ).resolves.toEqual({
      kind: "file",
      scope: { kind: "host", hostId: "host-7", rootPath: "/home/ada" },
      path: ".zshrc",
    });
    // An explicit host is authoritative, so no environment lookup is needed.
    expect(pathsExist).toHaveBeenCalledWith({
      hostId: "host-7",
      paths: ["/home/ada/.git", "/home/.git", "/.git"],
    });
    expect(threads.get).not.toHaveBeenCalled();
  });

  it("falls back to the containing directory when Git-root discovery fails", async () => {
    const threads = { get: vi.fn() };
    const pathsExist = vi.fn(async () => { throw new Error("host probe unavailable"); });
    const files = service(threads, pathsExist);

    await expect(files.resolveOpenerFile({
      source: { kind: "host", threadId: null, experimental_hostId: "host-7" },
      path: "/repo/sub/file.ts",
    })).resolves.toEqual({
      kind: "file",
      scope: { kind: "host", hostId: "host-7", rootPath: "/repo/sub" },
      path: "file.ts",
    });
  });

  it("uses the thread's own machine when the source names no host", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-3", path: "/workspace" },
      })),
    };
    const files = service(threads);

    await expect(
      files.resolveOpenerFile({
        source: { kind: "host", threadId: "thread-1" },
        path: "/etc/hosts",
      }),
    ).resolves.toEqual({
      kind: "file",
      scope: { kind: "host", hostId: "host-3", rootPath: "/etc" },
      path: "hosts",
    });
    expect(threads.get).toHaveBeenCalledWith({
      threadId: "thread-1",
      include: "environment",
    });
  });

  it("uses the containing folder when a local source has no host ID", async () => {
    const threads = { get: vi.fn() };
    const files = service(threads);

    await expect(
      files.resolveOpenerFile({
        source: { kind: "host", threadId: null },
        path: "/tmp/report.md",
      }),
    ).resolves.toEqual({
      kind: "file",
      scope: { kind: "host", rootPath: "/tmp" },
      path: "report.md",
    });
    expect(threads.get).not.toHaveBeenCalled();
  });

  it("resolves storage links against the SDK storage location", async () => {
    const storageLocation = vi.fn(async () => ({ hostId: "storage-host", storageRootPath: "/srv/thread" }));
    const threads = { get: vi.fn(), storageLocation };
    const sdkFiles = {
      read: vi.fn(async () => ({ contentEncoding: "utf8", content: "<img src='./asset.png'>", sha256: "sha", sizeBytes: 26, mimeType: "text/html", modifiedAtMs: 1 })),
      createPreview: vi.fn(async () => ({ baseUrl: "https://preview/thread" })),
    };
    const files = service(threads, undefined, sdkFiles);

    await expect(files.resolveOpenerFile({
      source: { kind: "thread-storage", threadId: "thread-1" },
      path: "./index.html",
    })).resolves.toEqual({
      kind: "file",
      scope: { kind: "thread-storage", threadId: "thread-1" },
      path: "index.html",
    });
    expect(storageLocation).not.toHaveBeenCalled();
    expect(threads.get).not.toHaveBeenCalled();
    await files.readFile({
      scope: { kind: "thread-storage", threadId: "thread-1" },
      path: "index.html",
    });
    await expect(files.getDownloadUrl({
      scope: { kind: "thread-storage", threadId: "thread-1" },
      path: "index.html",
    })).resolves.toEqual({ url: "https://preview/thread/index.html" });
    expect(sdkFiles.read).toHaveBeenCalledWith({
      hostId: "storage-host",
      rootPath: "/srv/thread",
      path: "/srv/thread/index.html",
    });
    expect(sdkFiles.createPreview).toHaveBeenCalledWith({
      hostId: "storage-host",
      rootPath: "/srv/thread",
    });
    expect(storageLocation).toHaveBeenCalledTimes(2);
    expect(threads.get).not.toHaveBeenCalled();
  });

  it("reports a source it cannot place instead of guessing a root", async () => {
    const threads = { get: vi.fn() };
    const files = service(threads);

    await expect(
      files.resolveOpenerFile({
        source: { kind: "host", threadId: "thread-1" },
        path: "relative.md",
      }),
    ).resolves.toEqual({ kind: "unsupported", reason: "not-absolute" });

    await expect(
      files.resolveOpenerFile({
        source: { kind: "host", threadId: null },
        path: "/",
      }),
    ).resolves.toEqual({ kind: "unsupported", reason: "no-file-name" });

    await expect(
      files.resolveOpenerFile({
        source: { kind: "workspace", threadId: null },
        path: "README.md",
      }),
    ).resolves.toEqual({ kind: "unsupported", reason: "no-thread" });

    expect(threads.get).not.toHaveBeenCalled();
  });
});
