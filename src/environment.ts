import type { BbPluginApi } from "@bb/plugin-sdk";

export interface ThreadEnvironmentTarget {
  hostId: string;
  rootPath: string;
}

type BbSdk = BbPluginApi["sdk"];

/** Resolve the thread environment afresh for every filesystem request. */
export async function resolveThreadEnvironment(
  sdk: BbSdk,
  threadId: string,
): Promise<ThreadEnvironmentTarget> {
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
