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

describe("createNote", () => {
  it("creates a note in the active workspace root when destination is not configured", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const filesWrite = vi.fn(async () => ({
      outcome: "written" as const,
      sha256: "sha-note-1",
      sizeBytes: 0,
    }));
    const files = service(threads, undefined, { write: filesWrite });

    const result = await files.createNote({
      currentScope: { kind: "thread", threadId: "thread-1" },
    });

    expect(result).toEqual({
      scope: { kind: "thread", threadId: "thread-1" },
      path: "Untitled.md",
      name: "Untitled.md",
      absolutePath: "/workspace/Untitled.md",
      sha256: "sha-note-1",
    });
    expect(filesWrite).toHaveBeenCalledWith({
      hostId: "host-1",
      rootPath: "/workspace",
      path: "/workspace/Untitled.md",
      content: "",
      contentEncoding: "utf8",
      expectedSha256: null,
    });
  });

  it("creates a note in configured project destination from a different workspace", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-thread", path: "/projects/current" },
      })),
    };
    const projects = {
      get: vi.fn(async ({ projectId }: { projectId: string }) => ({
        id: projectId,
        sources: [
          {
            hostId: "host-vault",
            path: "/home/ubuntu/Projects/notes-system",
            isDefault: true,
          },
        ],
      })),
      list: vi.fn(async () => []),
    };
    const filesWrite = vi.fn(async () => ({
      outcome: "written" as const,
      sha256: "sha-note-vault",
      sizeBytes: 0,
    }));
    const settings = {
      get: vi.fn(async () => ({
        defaultNotesDestination: "proj_notes_vault",
      })),
    };

    const filesService = createFileService(
      {
        sdk: {
          threads,
          hosts: { pathsExist: vi.fn(async () => ({ existence: {} })) },
          files: { write: filesWrite },
          projects,
        },
      } as unknown as Bb,
      settings,
    );

    const result = await filesService.createNote({
      currentScope: { kind: "thread", threadId: "thread-curr" },
    });

    expect(projects.get).toHaveBeenCalledWith({ projectId: "proj_notes_vault" });
    expect(result).toEqual({
      scope: {
        kind: "host",
        hostId: "host-vault",
        rootPath: "/home/ubuntu/Projects/notes-system",
      },
      path: "Untitled.md",
      name: "Untitled.md",
      absolutePath: "/home/ubuntu/Projects/notes-system/Untitled.md",
      sha256: "sha-note-vault",
    });
    expect(filesWrite).toHaveBeenCalledWith({
      hostId: "host-vault",
      rootPath: "/home/ubuntu/Projects/notes-system",
      path: "/home/ubuntu/Projects/notes-system/Untitled.md",
      content: "",
      contentEncoding: "utf8",
      expectedSha256: null,
    });
  });

  it("creates a note in configured absolute path destination", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const filesWrite = vi.fn(async () => ({
      outcome: "written" as const,
      sha256: "sha-abs-note",
      sizeBytes: 0,
    }));
    const settings = {
      get: vi.fn(async () => ({
        defaultNotesDestination: "/home/ubuntu/Projects/notes-system",
        defaultNotesHostId: "host_5rncjk8fs2",
      })),
    };

    const filesService = createFileService(
      {
        sdk: {
          threads,
          hosts: { pathsExist: vi.fn(async () => ({ existence: {} })) },
          files: { write: filesWrite },
          projects: { list: vi.fn(async () => []) },
        },
      } as unknown as Bb,
      settings,
    );

    const result = await filesService.createNote({
      currentScope: { kind: "thread", threadId: "thread-1" },
    });

    expect(result).toEqual({
      scope: {
        kind: "host",
        hostId: "host_5rncjk8fs2",
        rootPath: "/home/ubuntu/Projects/notes-system",
      },
      path: "Untitled.md",
      name: "Untitled.md",
      absolutePath: "/home/ubuntu/Projects/notes-system/Untitled.md",
      sha256: "sha-abs-note",
    });
  });

  it("explicit directory override (New note here) overrides configured destination", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const filesWrite = vi.fn(async () => ({
      outcome: "written" as const,
      sha256: "sha-override-note",
      sizeBytes: 0,
    }));
    const mkdir = vi.fn(async () => ({ ok: true }));
    const settings = {
      get: vi.fn(async () => ({
        defaultNotesDestination: "proj_notes_vault", // configured to vault
      })),
    };

    const filesService = createFileService(
      {
        sdk: {
          threads,
          hosts: { pathsExist: vi.fn(async () => ({ existence: {} })) },
          files: { write: filesWrite, mkdir },
          projects: { get: vi.fn() },
        },
      } as unknown as Bb,
      settings,
    );

    // Right-clicked "docs" folder in current workspace
    const result = await filesService.createNote({
      currentScope: { kind: "thread", threadId: "thread-1" },
      directory: "docs",
    });

    expect(result).toEqual({
      scope: { kind: "thread", threadId: "thread-1" },
      path: "docs/Untitled.md",
      name: "Untitled.md",
      absolutePath: "/workspace/docs/Untitled.md",
      sha256: "sha-override-note",
    });
    expect(mkdir).toHaveBeenCalledWith({
      hostId: "host-1",
      rootPath: "/workspace",
      path: "/workspace/docs",
      recursive: true,
    });
  });

  it("retries on collision to allocate Untitled 1.md, Untitled 2.md etc", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const attempts: string[] = [];
    const filesWrite = vi.fn(async ({ path }: { path: string }) => {
      attempts.push(path);
      if (path === "/workspace/Untitled.md") {
        return { outcome: "conflict" as const, currentSha256: "existing-sha-0" };
      }
      if (path === "/workspace/Untitled 1.md") {
        return { outcome: "conflict" as const, currentSha256: "existing-sha-1" };
      }
      return {
        outcome: "written" as const,
        sha256: "new-sha-2",
        sizeBytes: 0,
      };
    });

    const files = service(threads, undefined, { write: filesWrite });
    const result = await files.createNote({
      currentScope: { kind: "thread", threadId: "thread-1" },
    });

    expect(result.name).toBe("Untitled 2.md");
    expect(result.path).toBe("Untitled 2.md");
    expect(attempts).toEqual([
      "/workspace/Untitled.md",
      "/workspace/Untitled 1.md",
      "/workspace/Untitled 2.md",
    ]);
  });

  it("never retries non-collision write errors", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const filesWrite = vi.fn(async () => {
      throw new Error("EACCES: permission denied");
    });

    const files = service(threads, undefined, { write: filesWrite });

    await expect(
      files.createNote({
        currentScope: { kind: "thread", threadId: "thread-1" },
      }),
    ).rejects.toThrow("EACCES: permission denied");

    expect(filesWrite).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid or traversal directory paths", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const filesWrite = vi.fn();
    const files = service(threads, undefined, { write: filesWrite });

    await expect(
      files.createNote({
        currentScope: { kind: "thread", threadId: "thread-1" },
        directory: "../escape",
      }),
    ).rejects.toThrow();

    expect(filesWrite).not.toHaveBeenCalled();
  });

  it("fails when bounded retry limit (100) is exceeded", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const filesWrite = vi.fn(async () => ({
      outcome: "conflict" as const,
      currentSha256: "existing",
    }));

    const files = service(threads, undefined, { write: filesWrite });

    await expect(
      files.createNote({
        currentScope: { kind: "thread", threadId: "thread-1" },
      }),
    ).rejects.toThrow("Could not allocate a unique note name after 100 attempts.");

    expect(filesWrite).toHaveBeenCalledTimes(100);
  });

  it("creates a note in configured project name destination with subdirectory", async () => {
    const threads = {
      get: vi.fn(async () => ({
        environment: { hostId: "host-1", path: "/workspace" },
      })),
    };
    const projects = {
      list: vi.fn(async () => [
        {
          id: "proj_notes_sys",
          name: "notes-system",
          sources: [
            {
              isDefault: true,
              path: "/home/ubuntu/Projects/notes-system",
              hostId: "host-vault",
            },
          ],
        },
      ]),
    };
    const filesWrite = vi.fn(async () => ({
      outcome: "written" as const,
      sha256: "sha-proj-sub-note",
      sizeBytes: 0,
    }));
    const mkdir = vi.fn(async () => ({ ok: true }));
    const settings = {
      get: vi.fn(async () => ({
        defaultNotesDestination: "notes-system/daily",
      })),
    };

    const filesService = createFileService(
      {
        sdk: {
          threads,
          hosts: { pathsExist: vi.fn(async () => ({ existence: {} })) },
          files: { write: filesWrite, mkdir },
          projects,
        },
      } as unknown as Bb,
      settings,
    );

    const result = await filesService.createNote({
      currentScope: { kind: "thread", threadId: "thread-curr" },
    });

    expect(result).toEqual({
      scope: {
        kind: "host",
        hostId: "host-vault",
        rootPath: "/home/ubuntu/Projects/notes-system",
      },
      path: "daily/Untitled.md",
      name: "Untitled.md",
      absolutePath: "/home/ubuntu/Projects/notes-system/daily/Untitled.md",
      sha256: "sha-proj-sub-note",
    });
    expect(filesWrite).toHaveBeenCalledWith({
      hostId: "host-vault",
      rootPath: "/home/ubuntu/Projects/notes-system",
      path: "/home/ubuntu/Projects/notes-system/daily/Untitled.md",
      content: "",
      contentEncoding: "utf8",
      expectedSha256: null,
    });
  });
});

describe("sameSource", () => {
  it("preserves distinction between thread and thread-storage scopes", async () => {
    const { sameSource } = await import("./file-scope");
    const threadScope = { kind: "thread" as const, threadId: "t-1" };
    const storageScope = { kind: "thread-storage" as const, threadId: "t-1" };
    expect(sameSource(threadScope, storageScope)).toBe(false);
    expect(sameSource(storageScope, threadScope)).toBe(false);
    expect(sameSource(threadScope, { kind: "thread", threadId: "t-1" })).toBe(true);
    expect(sameSource(storageScope, { kind: "thread-storage", threadId: "t-1" })).toBe(true);
  });

  it("is immune to host property ordering and treats undefined and null equally", async () => {
    const { sameSource } = await import("./file-scope");
    const hostA = { kind: "host" as const, hostId: "h-1", rootPath: "/notes" };
    const hostB = { kind: "host" as const, rootPath: "/notes", hostId: "h-1" };
    expect(sameSource(hostA, hostB)).toBe(true);

    const hostWithoutIdA = { kind: "host" as const, rootPath: "/notes" };
    const hostWithoutIdB = { kind: "host" as const, hostId: undefined, rootPath: "/notes" };
    expect(sameSource(hostWithoutIdA, hostWithoutIdB)).toBe(true);
  });

  it("inherits owning hosts for absolute notes paths in thread and storage scopes", async () => {
    for (const kind of ["thread", "thread-storage"] as const) {
      const writes: any[] = [];
      const service = createFileService({ sdk: {
        threads: {
          get: async () => ({ environment: { hostId: "remote-host", path: "/remote/workspace" } }),
          storageLocation: async () => ({ hostId: "storage-host", storageRootPath: "/remote/storage" }),
        },
        projects: { list: async () => [] },
        hosts: { pathsExist: async () => ({ existence: {} }) },
        files: { write: async (input: any) => { writes.push(input); return { outcome: "written", sha256: "created", sizeBytes: 0 }; } },
      } } as unknown as Bb);
      const result = await service.createNote({ currentScope: { kind, threadId: "remote-thread" }, destination: "/remote/notes" });
      const expectedHost = kind === "thread" ? "remote-host" : "storage-host";
      expect(result.scope).toEqual({ kind: "host", hostId: expectedHost, rootPath: "/remote/notes" });
      expect(writes[0].hostId).toBe(expectedHost);
    }
  });

  it("pairs absolute project roots with the selected host and honors explicit host overrides", async () => {
    const writes: any[] = [];
    const service = createFileService({ sdk: {
      threads: { get: async () => ({ environment: { hostId: "remote-host", path: "/workspace" } }) },
      projects: { list: async () => [
        { sources: [{ hostId: "wrong-host", path: "/remote" }] },
        { sources: [{ hostId: "override-host", path: "/remote/notes" }] },
        { sources: [{ hostId: "remote-host", path: "/remote/notes" }] },
      ] },
      hosts: { pathsExist: async () => ({ existence: {} }) },
      files: { write: async (input: any) => { writes.push(input); return { outcome: "written", sha256: "created", sizeBytes: 0 }; } },
    } } as unknown as Bb);
    const currentScope = { kind: "thread" as const, threadId: "remote-thread" };
    const inherited = await service.createNote({ currentScope, destination: "/remote/notes/daily" });
    expect(inherited.scope).toEqual({ kind: "host", hostId: "remote-host", rootPath: "/remote/notes" });
    expect(inherited.path).toBe("daily/Untitled.md");
    const overridden = await service.createNote({ currentScope, destination: "/remote/notes/daily", hostId: "override-host" });
    expect(overridden.scope).toEqual({ kind: "host", hostId: "override-host", rootPath: "/remote/notes" });
    expect(writes.map((write) => write.hostId)).toEqual(["remote-host", "override-host"]);
  });

  it("fails closed if a thread destination's owning host cannot be resolved", async () => {
    const write = vi.fn();
    const service = createFileService({ sdk: {
      threads: { get: async () => ({ environment: { path: "/workspace" } }) },
      projects: { list: async () => [] },
      files: { write },
    } } as unknown as Bb);
    await expect(service.createNote({ currentScope: { kind: "thread", threadId: "unknown-host" }, destination: "/remote/notes" })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("fails instead of creating in the active workspace when a matched project has no destination source", async () => {
    const filesWrite = vi.fn(async () => ({ outcome: "written" as const, sha256: "created", sizeBytes: 0 }));
    const projectList = vi.fn(async () => [{ id: "proj_notes", name: "notes", sources: [] }]);
    const filesService = createFileService(
      {
        sdk: {
          threads: { get: vi.fn(async () => ({ environment: { hostId: "host-current", path: "/workspace" } })) },
          hosts: { pathsExist: vi.fn(async () => ({ existence: {} })) },
          files: { write: filesWrite },
          projects: { list: projectList },
        },
      } as unknown as Bb,
      { get: vi.fn(async () => ({ defaultNotesDestination: "notes/daily" })) },
    );

    await expect(filesService.createNote({ currentScope: { kind: "thread", threadId: "thread-1" } }))
      .rejects.toThrow(/project.*no valid directory source/i);
    expect(projectList).toHaveBeenCalledOnce();
    expect(filesWrite).not.toHaveBeenCalled();
  });
});
