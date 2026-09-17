import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { resolveFileRoot, type FileScope } from "./environment";
import { fileIndexCache } from "./file-index";
import { joinProjectPaths, parseRelativePath, resolveProjectPath } from "./path-policy";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type PluginHttpContext = Parameters<
  Parameters<BbPluginApi["http"]["route"]>[2]
>[0];

class UploadError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 502,
    message: string,
  ) {
    super(message);
  }
}

function requiredQuery(context: PluginHttpContext, name: string): string {
  const value = context.req.query(name);
  if (!value) throw new UploadError(400, `${name} is required`);
  return value;
}

/**
 * The upload route carries its root the same way the RPC does: `scope=thread`
 * with a `threadId`, or `scope=host` with an optional `rootPath`/`hostId`
 * (`rootPath` omitted means this machine's home directory).
 */
function scopeFromQuery(context: PluginHttpContext): FileScope {
  const mode = requiredQuery(context, "scope");
  if (mode === "thread") {
    return { kind: "thread", threadId: requiredQuery(context, "threadId") };
  }
  if (mode !== "host") {
    throw new UploadError(400, "scope must be thread or host");
  }
  const rootPath = context.req.query("rootPath");
  const hostId = context.req.query("hostId");
  if (hostId && !rootPath) {
    throw new UploadError(400, "rootPath is required with hostId");
  }
  if (rootPath && hostId) return { kind: "host", hostId, rootPath };
  if (rootPath) return { kind: "host", rootPath };
  return { kind: "host" };
}

function uploadPath(directory: string, fileName: string): string {
  try {
    const parsedName = parseRelativePath(fileName, { allowEmpty: false });
    if (parsedName.segments.length !== 1) {
      throw new Error("File name must not contain path separators.");
    }
    return joinProjectPaths(directory, parsedName.normalized);
  } catch (error) {
    throw new UploadError(
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function readUploadBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) {
      throw new UploadError(400, "content-length must be a non-negative number");
    }
    if (size > MAX_UPLOAD_BYTES) {
      throw new UploadError(413, "File exceeds the 25 MB upload limit");
    }
  }
  if (request.signal.aborted) throw new UploadError(400, "Upload aborted");
  if (!request.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      if (request.signal.aborted) throw new UploadError(400, "Upload aborted");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new UploadError(413, "File exceeds the 25 MB upload limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createUploadHandler(bb: BbPluginApi) {
  return async (context: PluginHttpContext): Promise<Response> => {
    try {
      const scope = scopeFromQuery(context);
      const fileName = requiredQuery(context, "fileName");
      const directory = context.req.query("directory") ?? "";
      const environment = await resolveFileRoot(bb.sdk, scope);
      const resolved = resolveProjectPath(
        environment.rootPath,
        uploadPath(directory, fileName),
        { allowEmpty: false },
      );
      const bytes = await readUploadBody(context.req.raw);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const result = await bb.sdk.files.write({
        hostId: environment.hostId,
        rootPath: environment.rootPath,
        path: resolved.absolutePath,
        content: Buffer.from(bytes).toString("base64"),
        contentEncoding: "base64",
        expectedSha256: null,
      });
      if (result.outcome === "conflict") {
        throw new UploadError(409, `${resolved.relativePath} already exists`);
      }
      if (result.sha256 !== sha256 || result.sizeBytes !== bytes.byteLength) { // ubs:ignore — public integrity metadata does not require constant-time comparison
        throw new UploadError(502, "The uploaded file could not be verified");
      }
      // The new path must be searchable at once: the next search rebuilds.
      fileIndexCache.invalidate(scope);
      return context.json(
        { path: resolved.relativePath, sha256, sizeBytes: bytes.byteLength },
        201,
      );
    } catch (error) {
      if (error instanceof UploadError) {
        return context.json({ error: error.message }, error.status);
      }
      throw error;
    }
  };
}
