import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listLocalDirectory } from "./host-directory";

/** A tiny home-shaped tree, including the entries the daemon hides. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-files-host-dir-"));
  await mkdir(join(root, "beta"));
  await mkdir(join(root, "node_modules"));
  await mkdir(join(root, "Alpha"));
  await writeFile(join(root, "notes.md"), "notes");
  await writeFile(join(root, ".hidden"), "secret");
  await writeFile(join(root, "beta", "child.txt"), "child");
  await symlink(join(root, "beta"), join(root, "linked"));
  await symlink(join(root, "missing"), join(root, "broken"));
  return root;
}

it("reads one level of the local root, dotfiles included", async () => {
  const entries = await listLocalDirectory(await fixture());

  expect(entries).toEqual([
    { kind: "directory", name: "Alpha" },
    { kind: "directory", name: "beta" },
    { kind: "directory", name: "linked" },
    { kind: "file", name: ".hidden" },
    { kind: "file", name: "notes.md" },
  ]);
});

it("classifies symlinks by target and drops broken ones", async () => {
  const entries = await listLocalDirectory(await fixture());

  expect(entries.find((entry) => entry.name === "linked")?.kind).toBe(
    "directory",
  );
  expect(entries.some((entry) => entry.name === "broken")).toBe(false);
});

it("skips node_modules like the host daemon does", async () => {
  const entries = await listLocalDirectory(await fixture());

  expect(entries.some((entry) => entry.name === "node_modules")).toBe(false);
});
