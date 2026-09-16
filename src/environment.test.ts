import { homedir } from "node:os";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { resolveFileRoot } from "./environment";

type Sdk = BbPluginApi["sdk"];

describe("resolveFileRoot", () => {
  it("resolves a thread scope from the live environment", async () => {
    const sdk = {
      threads: {
        get: vi.fn(async () => ({
          environment: { hostId: "host-1", path: "/workspace" },
        })),
      },
    } as unknown as Sdk;

    await expect(
      resolveFileRoot(sdk, { kind: "thread", threadId: "thread-1" }),
    ).resolves.toEqual({ hostId: "host-1", rootPath: "/workspace" });
  });

  it("uses this machine's home directory for an unrooted host scope", async () => {
    const sdk = {} as unknown as Sdk;

    await expect(resolveFileRoot(sdk, { kind: "host" })).resolves.toEqual({
      rootPath: homedir(),
    });
  });

  it("passes an explicit host root through", async () => {
    const sdk = {} as unknown as Sdk;

    await expect(
      resolveFileRoot(sdk, {
        kind: "host",
        hostId: "host-2",
        rootPath: "/srv/data",
      }),
    ).resolves.toEqual({ hostId: "host-2", rootPath: "/srv/data" });
    await expect(
      resolveFileRoot(sdk, { kind: "host", rootPath: "/srv/data" }),
    ).resolves.toEqual({ rootPath: "/srv/data" });
  });

  it("refuses a named host without a root path", async () => {
    const sdk = {} as unknown as Sdk;

    await expect(
      resolveFileRoot(sdk, { kind: "host", hostId: "host-2" }),
    ).rejects.toThrow(/root path is required/iu);
  });
});
