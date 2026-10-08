import { z } from "zod";

const threadIdSchema = z.string().trim().min(1);

export const fileScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: threadIdSchema }).strict(),
  z
    .object({ kind: z.literal("thread-storage"), threadId: threadIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("host"),
      hostId: z.string().trim().min(1).optional(),
      rootPath: z.string().min(1).optional(),
    })
    .strict(),
]);

export type FileScope = z.infer<typeof fileScopeSchema>;

export function sameSource(a: FileScope, b: FileScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "thread") {
    return b.kind === "thread" && a.threadId === b.threadId;
  }
  if (a.kind === "thread-storage") {
    return b.kind === "thread-storage" && a.threadId === b.threadId;
  }
  if (a.kind === "host") {
    return (
      b.kind === "host" &&
      (a.hostId ?? null) === (b.hostId ?? null) &&
      (a.rootPath ?? null) === (b.rootPath ?? null)
    );
  }
  return false;
}

export interface ResolvedFileTarget {
  scope: FileScope;
  path: string;
}
