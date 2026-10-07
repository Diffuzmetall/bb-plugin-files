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

export interface ResolvedFileTarget {
  scope: FileScope;
  path: string;
}
