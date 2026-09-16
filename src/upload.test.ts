import { createHash } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { createUploadHandler, MAX_UPLOAD_BYTES, readUploadBody } from "./upload";

describe("workspace uploads", () => {
  it("writes uploaded bytes to the requested workspace folder", async () => {
    const bytes = new TextEncoder().encode("hello");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const write = vi.fn(async () => ({
      outcome: "written" as const,
      sha256,
      sizeBytes: bytes.byteLength,
    }));
    const bb = {
      sdk: {
        threads: {
          get: async () => ({
            environment: { hostId: "host-1", path: "/workspace" },
          }),
        },
        files: { write },
      },
    } as unknown as BbPluginApi;
    const request = new Request("https://bb.test/upload", {
      method: "POST",
      body: bytes,
    });
    const query = new URLSearchParams({
      scope: "thread",
      threadId: "thread-1",
      directory: "assets",
      fileName: "notes.md",
    });
    const response = await createUploadHandler(bb)({
      req: {
        raw: request,
        query: (name: string) => query.get(name) ?? undefined,
      },
      json: (body: unknown, status: number) =>
        new Response(JSON.stringify(body), { status }),
    } as never);

    expect(response.status).toBe(201);
    expect(write).toHaveBeenCalledWith({
      hostId: "host-1",
      rootPath: "/workspace",
      path: "/workspace/assets/notes.md",
      content: "aGVsbG8=",
      contentEncoding: "base64",
      expectedSha256: null,
    });
  });

  it("rejects a declared upload larger than 25 MB before reading it", async () => {
    const request = new Request("https://bb.test/upload", {
      method: "POST",
      headers: { "content-length": String(MAX_UPLOAD_BYTES + 1) },
      body: "x",
    });

    await expect(readUploadBody(request)).rejects.toThrow(
      "File exceeds the 25 MB upload limit",
    );
  });
});
