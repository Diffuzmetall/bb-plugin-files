# BB Files

[![CI](https://github.com/Diffuzmetall/bb-plugin-files/actions/workflows/ci.yml/badge.svg)](https://github.com/Diffuzmetall/bb-plugin-files/actions/workflows/ci.yml)

A standalone BB plugin that adds a **Files** panel in two places: **Actions → Files** in a thread's right panel, and a **Files** entry in BB's left rail. A thread panel is bound to that thread's live environment and uses `bb.sdk.files`, so the same tree/editor works on the local machine and connected hosts. The left-rail panel needs no thread, project, or repository: it browses the machine BB runs on, starting at its home directory.

## Install

BB Files requires BB `>=0.35.1`. Install the current tagged release:

```bash
bb plugin install 'git:https://github.com/Diffuzmetall/bb-plugin-files.git@v0.3.1' --yes
```

After the plugin is listed in the BB Community marketplace, BB can report and
apply compatible tagged updates without installing them automatically:

```bash
bb plugin outdated
bb plugin update files
```

Releases use immutable `vX.Y.Z` Git tags. Marketplace updates within the
current `^0.3.0` range are selected from those tags.

## Release 0.3.1

We did the source-link checks with BB `0.45.0`. We did not check this new flow on older BB versions.

- File lists and documents fill narrow panels, with Files/search access that does not close the document.
- Delayed file reads no longer override a later choice to return to Files.
- Parent resizing clamps the tree while preserving its preferred width; keyboard and −/+ controls complement dragging.
- Narrow lists use denser rows: 36px for a mouse and 44px for touch, instead of 48px throughout.
- A compact mobile header shows the filename and folder separately. The folder icon returns to the list; tapping the filename opens a searchable sheet of open files with independent close buttons.
- Secondary document actions live under **File actions (⋯)** on narrow panels. Desktop tabs and actions remain available as before.
- External file links keep their original workspace, host, or thread-storage source. Host links show the nearest Git repository when BB can confirm it.

## Project documentation

- [`ROADMAP.md`](ROADMAP.md) — detailed product and technical ideas. Highlighted directions include BB agent integration, breadcrumbs, secure workspace previews, richer HTML/image tooling, filesystem-watch or adaptive-polling synchronization, performance, and reliability.

## Features

- **Multi-Tab Editor**: open multiple files simultaneously with a modern tab bar. Tabs persist per file source (thread workspace, thread storage, or host root) and are restored when the panel is reopened;
- **Two roots**: **Actions → Files** browses a thread's workspace, and **Files** in BB's left rail browses this machine's home directory with no repository involved. Both roots keep the full set of file operations;
- **Resizable Layout**: an editor on the left and a resizable, collapsible file tree on the right. The tree stays within its panel when the parent shrinks; drag the divider, use its arrow/Home/End keys, or use the tree’s −/+ buttons;
- bounded recursive tree (up to 10,000 files), with search answered from a per-root path index: the tree is walked once, then every keystroke is ranked in memory (fzf) with the matched characters highlighted. Paths a workspace keeps are indexed with their dot-entries; the left-rail home root indexes visible entries only, and searches there report how many paths the index holds;
- **Depth-first tree rendering**: accurately reconstructs project hierarchy with auto-expansion of active file paths;
- **Hidden files support**: the left-rail root lists dot-entries directly, and a thread workspace probes and reveals common configuration dotfiles (e.g. `.env`, `.gitignore`, `.github`, `.vscode`, etc.) which are normally excluded by the host lister;
- UTF-8 editing up to 2 MiB with CodeMirror 6;
- directly editable WYSIWYG Markdown **Preview**, exact-source **Raw** mode, **Image Previews**, and HTML previews in an inline iframe or separate browser tab;
- embedded Excalidraw editing for `.excalidraw` scenes, including theme synchronization and safe external links;
- 700 ms autosave and Cmd/Ctrl+S;
- SHA-based compare-and-swap with explicit Reload/Overwrite conflict handling;
- 10-second tree/file external-change polling;
- create, rename (safely preserves unsaved drafts), duplicate, recursive delete, copy file content, copy relative path, and **download** actions;
- upload multiple local files to the workspace root or any folder through the picker, context menu, or drag and drop (25 MiB per file, create-only);
- optional **MD Annotate integration** for opening Markdown files in a review/commenting tab;
- optional **SQL integration** for opening `.sql` files with the preferred host opener
  ([yazydzhi/bb-plugin-sql](https://github.com/yazydzhi/bb-plugin-sql));
- **Open with preferred…** on any file — reopens via BB’s host file flow so
  **Settings → File openers** apply (the in-panel editor itself does not);
- **file opener** registration for links from other surfaces — see
  [Opening files from other plugins](#opening-files-from-other-plugins);
- **Host file links**: absolute paths open from their original host. Files shows the nearest confirmed Git repository, or the folder that contains the file;
- **Narrow panels**: below 680px of panel width, the file list and document each fill the panel. The **Show files** folder icon returns to search without closing the document; **Return to document** restores it. Tap the filename to search and switch **Open files**, or close an individual file with its separate × button. **File actions (⋯)** contains download, copy content, supported integrations and **Close file**;
- **Compact file lists**: narrow mouse-driven panels use 36px rows; touch layouts keep 44px rows and action targets. Search and Markdown body text remain 16px;
- `node_modules` stays hidden in both roots; a thread workspace excludes symlinks through BB's host lister, while the left-rail root shows symlinks that resolve and skips broken ones.

## Browsing in a narrow panel

1. Open **Actions → Files** in a thread, or **Files** in the left rail.
2. Search for a file and open it. The document fills a narrow panel.
3. Choose the **Show files** folder icon to return to the list. Your search, open documents and unsaved draft stay available.
4. Choose **Return to document** to return to the same document without changing its Preview/Raw mode. Tap the filename to open the **Open files** sheet, filter by name or path, and select another document. Escape or the close button dismisses the sheet; closing a file still goes through autosave and conflict protection.
5. On a wider panel, resize the tree using the divider or the −/+ buttons. If the panel shrinks, the tree is clamped to leave at least 200px for the editor.

Changing documents keeps the existing Preview/Raw behavior; preserving the mode applies to returning to the same document. Browser refresh still does not persist unsaved drafts.

## Troubleshooting

- **Cannot reach the file list:** use the **Show files** folder icon in a narrow document toolbar, or **Show sidebar** when the wide tree is hidden.
- **Cannot find document actions:** on a narrow panel, open **File actions (⋯)**. Download, copy content and supported opener integrations are in that menu, not removed.
- **Search is indexing:** let the first scan finish; partial matches and progress appear while the index builds.
- **Save conflict:** reload the disk version or explicitly overwrite after reviewing the conflict. Do not refresh the browser to recover an unsaved draft.
- **A link opens another viewer:** choose Files for that extension under **Settings → Files → File openers**.
- **A local change is not visible:** rebuild with `bb plugin build .`, then run `bb plugin reload files`.

## Opening files from other plugins

BB Files registers itself as a file opener for text-like files, so a file link
outside the panel — a terminal path in the Wterm terminal plugin, a Markdown
link, a host-provided file tab — can land in this editor instead of BB's
built-in preview:

```ts
app.slots.fileOpener({
  id: "files",
  title: "Files",
  // Lowercase extensions without the dot.
  extensions: ["md", "mdx", "txt", "ts", "tsx", …],
  component: FilesPanel,
});
```

The registered list covers source, configuration, markup, and picture formats —
80 extensions, kept in [`src/file-opener-extensions.ts`](src/file-opener-extensions.ts).
Formats the panel has no renderer for (PDF, archives, audio, video) stay with
BB's built-in preview.

The panel receives `{path, source, experimental_lineRange}` and opens the file
from its original source. The current thread and workspace do not change.
Git-ref snapshots always use BB's preview.

Workspace links use the original thread ID, not the active thread ID.
Only links from the active workspace can reuse its Files panel.
Thread-storage links use the storage root and host that BB supplies for the
original thread. HTML previews resolve relative resources from that root.

Host links can open without an active thread. An explicit host ID takes
precedence over the host of the original thread. With a confirmed host ID,
Files checks ancestor `.git` entries and selects the nearest repository.
If Git discovery fails, Files uses the folder that contains the file.
Without a confirmed host ID, Files uses BB's local-host behavior and that folder.
It does not select an arbitrary host from the host list.

Files keeps separate tabs and saved tab state for each source. A repeated open
of the same source and path reuses the file tab. A different path in the same
root keeps existing tabs and drafts. Missing source information produces an
error instead of a same-named file from the current workspace.

Another plugin can claim the same extension. While a preference is `Automatic`,
the first matching opener wins, and an opener that delegates to `Original`
renders BB's built-in preview under its own tab. Excalidraw claims `md` for
`.excalidraw.md` scenes, which is why markdown needs an explicit choice:
**Settings → Files → File openers** → `.md files` → `Files (files)`.

BB renders the first opener that claims an extension while the preference is
`Automatic (…)`, so the Files panel becomes the viewer for these extensions only
where no earlier registered opener claims them. **Settings →
Files → File openers** pins a viewer per extension — `Automatic (…)`,
`Built-in preview`, or any registered opener — and right-clicking a file link
overrides the choice for that one open. Another plugin registering the same
extension competes for that default until a preference settles it.

## Development

```bash
npm install --legacy-peer-deps
npm run typecheck
npm test
bb plugin build .
bb plugin install "$PWD" --yes
```

Then open a thread and choose **New tab → Actions → Files** in its right panel, or click **Files** in BB's left rail for the machine root. During development, run `bb plugin dev "$PWD"`.

## MD Annotate integration

BB Files integrates optionally with
[`DarrenTsung/bb-plugin-md-annotate`](https://github.com/DarrenTsung/bb-plugin-md-annotate),
a Google Docs-style review surface for Markdown files.

When a compatible, running `md-annotate` plugin is detected, Markdown files
receive two additional actions:

- a comment icon in the active file toolbar;
- **Open in Annotate** in the file context menu.

The actions are hidden when MD Annotate is not installed, disabled, failed, or
frontend-incompatible. BB Files does not import, modify, or control MD Annotate;
it asks BB to reopen the selected workspace file using the client's configured
file opener.

### Compatibility and setup

- BB `>=0.35.1` with Plugin SDK `^0.4.1`;
- MD Annotate `0.1.x` with plugin id `md-annotate` and opener id `annotate`;
- `.md`, `.mdx`, and `.markdown` workspace files;
- in **Settings → File openers**, set the Markdown extension you use to
  **Annotate (md-annotate)**.

Install MD Annotate separately:

```bash
bb plugin install git:https://github.com/DarrenTsung/bb-plugin-md-annotate@main
```

The integration intentionally uses BB's standard file-open flow. Consequently,
if Annotate is installed but is not the configured default for that extension,
the action opens whichever viewer the client selected instead.

## SQL integration

When a compatible, running `sql` plugin is detected, `.sql` files receive:

- a terminal icon in the active file toolbar (**Open in SQL**);
- **Open in SQL** in the file context menu.

Every file also gets **Open with preferred…** (toolbar + context menu), which
asks BB to reopen the workspace path through the host. That honors
**Settings → File openers** (e.g. `.sql` → **SQL**). Clicking a file in the
Files tree still uses Files’ built-in preview — use these actions to leave it.

### Compatibility and setup (SQL)

- BB `>=0.35.1` with Plugin SDK `^0.4.1`;
- SQL plugin id `sql` with a compatible app bundle;
- in **Settings → File openers**, set `.sql` to **SQL (sql)**.

```bash
bb plugin install git:https://github.com/yazydzhi/bb-plugin-sql.git@^0.1.0 --yes
# or from a local checkout:
# bb plugin install /path/to/bb-plugin-sql --yes
```

## Hand-off / Current Status

This is a comprehensive summary of the current implementation for future maintenance and feature development.

### What works

- **Multi-Tab Engine**: Core `useFilesWorkspace` hook refactored to support array-based `tabs` state. Supports concurrent open files with independent draft buffers.
- **Persistence**: Tab paths and active tab selection are persisted in `localStorage` per file source (thread workspace, thread storage, or host root). Tabs are automatically re-hydrated on panel remount.
- **UI Layout**: IDE-like layout with a resizable/collapsible file tree on the right and an editor on the left.
- **Previews**:
  - WYSIWYG Markdown preview with direct rendered-text editing and a Raw source fallback.
  - HTML preview with iframe refresh after save and an "Open preview" action.
  - Image preview for common formats.
- **Editor Features**: 700ms autosave, SHA-based optimistic concurrency control (CAS) with conflict/overwrite UI, explicit download/copy actions.
- **Robustness**: 10,000-entry tree cap, hidden dotfile probing, recursive delete/duplication/rename safety, and tests covering state transitions and persistence.

### What is implemented (Key Architecture)

- **State**: `TabState` tracks per-tab `draftText`, `savedText`, `file` metadata, and `saveState`.
- **Scope**: every RPC carries a `FileScope` with kind `thread`, `thread-storage`, or `host`. The server resolves each scope to one root. A host scope without `rootPath` uses BB's local home directory.
- **Opener targets**: `resolveOpenerFile` returns the original source scope and a root-relative path. Workspace and storage scopes keep their original thread ID. Host scopes keep their host ID and confirmed repository or folder root.
- **Flow**: Autosave and polling observe `tabs` array. File reads are throttled and deduplicated using `fileLoadRequestsRef`.
- **Sync**: Conflict detection checks file SHA against remote every 10s.

### Limitations & Known Issues

- **Scroll Position**: Tab switching does not currently persist/restore scroll position (Codemirror instance reset).
- **Large Files**: Files > 2MiB or non-text binaries are metadata-only (no content access).
- **Tab State**: Only the tab *path* is persisted; draft contents are lost if the browser tab is refreshed (only panel-remount persistence is implemented).
- **Legacy host tabs**: Files does not restore old tab records without a reliable host identity. Open those files again after the upgrade.

### Next Steps / Future Work

See [`ROADMAP.md`](ROADMAP.md) for the complete idea backlog and proposed implementation phases. The highlighted directions are BB agent integration, breadcrumbs, secure workspace previews, richer HTML/image tooling, replacing constant polling, tree virtualization, and stronger autosave concurrency.

## Safety model

The frontend sends a scope and a root-relative path. A scope identifies a thread workspace, thread storage, or a host root.

Every RPC resolves the scope again on the server. A thread scope uses that thread's live environment.
A storage scope uses that thread's BB storage location. A host scope stays inside its `rootPath`.

Without `rootPath`, a host scope uses BB's local home directory. External host links use a confirmed repository or the folder that contains the file.

`listPaths` receives the absolute root because that SDK method has no `rootPath` field.
Existing-file writes use their last-read SHA. New files use create-only writes. Folder duplication preflights at 501 entries and refuses more than 500.

Binary and oversized files are metadata-only. There is no fallback to the primary machine when a thread environment is unavailable; a machine-wide root has to be opened as its own scope.

BB plugins are full-trust code. Files can read, create, edit, move, duplicate,
download, and delete files inside the selected root — a thread environment or,
for the left-rail panel, the machine's home directory — including dotfiles such
as `.env` and `.npmrc`. Destructive actions are initiated by the user through
confirmation UI. The plugin has no telemetry, external
service, or outbound network integration, and it does not send workspace
contents elsewhere.

## License

[MIT](LICENSE)
