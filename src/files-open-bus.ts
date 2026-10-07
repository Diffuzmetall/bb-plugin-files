/** Chat/file-opener clicks land here so the one Files panel can open inner tabs. */

export type FilesOpenRequest = {
  path: string;
  threadId: string | null;
};

const listeners = new Set<(request: FilesOpenRequest) => void>();
let queued: FilesOpenRequest[] = [];

export function publishFilesOpen(request: FilesOpenRequest): void {
  if (listeners.size === 0) {
    queued.push(request);
    return;
  }
  for (const listener of listeners) listener(request);
}

export function subscribeFilesOpen(
  listener: (request: FilesOpenRequest) => void,
): () => void {
  listeners.add(listener);
  if (queued.length > 0) {
    const pending = queued;
    queued = [];
    for (const request of pending) listener(request);
  }
  return () => {
    listeners.delete(listener);
  };
}
