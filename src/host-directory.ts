import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Names the tree never descends into, matching the host daemon's lister. */
const SKIP_NAMES = new Set(["node_modules"]);

export interface HostDirectoryEntry {
  kind: "file" | "directory";
  name: string;
}

/**
 * One level of a directory on this machine.
 *
 * The plugin server runs on the machine BB runs on, so a local host root can be
 * read directly — which is also why dot-entries stay visible here: the daemon's
 * `host.browse_directory` hides them, and in a home directory the dotfiles are
 * often the point. Symlinks classify by their target and broken ones are
 * skipped, matching the daemon.
 */
export async function listLocalDirectory(
  absolutePath: string,
): Promise<HostDirectoryEntry[]> {
  const dirents = await readdir(absolutePath, { withFileTypes: true });
  const entries: HostDirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (SKIP_NAMES.has(dirent.name)) continue;
    if (dirent.isSymbolicLink()) {
      try {
        const target = await stat(join(absolutePath, dirent.name));
        entries.push({
          kind: target.isDirectory() ? "directory" : "file",
          name: dirent.name,
        });
      } catch {
        // A broken link is not browsable.
      }
      continue;
    }
    if (dirent.isDirectory()) {
      entries.push({ kind: "directory", name: dirent.name });
      continue;
    }
    if (dirent.isFile()) {
      entries.push({ kind: "file", name: dirent.name });
    }
    // Sockets, fifos, and devices are not browsable.
  }
  entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.kind === "directory"
        ? -1
        : 1,
  );
  return entries;
}
