import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { createFileService } from "./file-service";

type Bb = Parameters<typeof createFileService>[0];

function service(threads: { get: ReturnType<typeof vi.fn> }) {
  return createFileService({ sdk: { threads } } as unknown as Bb);
}

const op = { id: "op", subject: "op" };

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

  it("re-roots an absolute host link at the file's own directory", async () => {
    const threads = { get: vi.fn() };
    const files = service(threads);

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
    expect(threads.get).not.toHaveBeenCalled();
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

  it("falls back to this machine without a thread to resolve", async () => {
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

  it("reports a source it cannot place instead of guessing a root", async () => {
    const threads = { get: vi.fn() };
    const files = service(threads);

    await expect(
      files.resolveOpenerFile({
        source: { kind: "thread-storage", threadId: "thread-1" },
        path: "notes/todo.md",
      }),
    ).resolves.toEqual({ kind: "unsupported", reason: "thread-storage" });

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
