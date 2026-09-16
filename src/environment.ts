import { homedir } from "node:os";
import type { BbPluginApi } from "@bb/plugin-sdk";

export interface FileRoot {
  /** Omitted targets the local host (see `bb.sdk.files`). */
  hostId?: string;
  rootPath: string;
}

/**
 * Where a Files request reads and writes:
 *
 * - `thread` — the thread's live workspace (the panel opened from a thread);
 * - `host` — an absolute root on a machine, used by the Files entry in BB's
 *   left sidebar, which has no thread. Without `rootPath` the root is this
 *   machine's home directory, which is the global root the sidebar offers.
 */
export type FileScope =
  | { kind: "thread"; threadId: string }
  | { kind: "host"; hostId?: string; rootPath?: string };

type BbSdk = BbPluginApi["sdk"];

/** Resolve the thread environment afresh for every filesystem request. */
export async function resolveThreadEnvironment(
  sdk: BbSdk,
  threadId: string,
): Promise<FileRoot> {
  const thread = await sdk.threads.get({ threadId, include: "environment" });
  if (!("environment" in thread) || thread.environment === undefined) {
    throw new Error(
      "Thread environment was not returned. Files requires a live environment.",
    );
  }
  const environment = thread.environment;
  if (environment === null) {
    throw new Error("This thread has no live environment.");
  }
  if (typeof environment.path !== "string" || environment.path.length === 0) {
    throw new Error("This thread environment has no workspace path.");
  }
  if (
    typeof environment.hostId !== "string" ||
    environment.hostId.length === 0
  ) {
    throw new Error("This thread environment has no machine.");
  }
  return { hostId: environment.hostId, rootPath: environment.path };
}

/**
 * Resolve the root a request runs against. A thread scope always goes through
 * the live environment lookup, so persistence and props never decide the
 * authorization boundary; a host scope is already an absolute root chosen by
 * the server (the sidebar panel) or by the caller.
 */
export async function resolveFileRoot(
  sdk: BbSdk,
  scope: FileScope,
): Promise<FileRoot> {
  if (scope.kind === "thread") {
    return resolveThreadEnvironment(sdk, scope.threadId);
  }
  if (scope.rootPath !== undefined) {
    return scope.hostId === undefined
      ? { rootPath: scope.rootPath }
      : { hostId: scope.hostId, rootPath: scope.rootPath };
  }
  if (scope.hostId !== undefined) {
    throw new Error(
      "A root path is required to browse a host other than this one.",
    );
  }
  // The plugin server runs on the machine running BB, so its home directory is
  // the local host's global root. The host daemon hides dot-entries in every
  // browsable directory, so the root listing probes those by name instead.
  return { rootPath: homedir() };
}
