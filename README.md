# BB Files

[![CI](https://github.com/Diffuzmetall/bb-plugin-files/actions/workflows/ci.yml/badge.svg)](https://github.com/Diffuzmetall/bb-plugin-files/actions/workflows/ci.yml)

A standalone BB plugin that adds a **Files** panel in two places: **Actions → Files** in a thread's right panel, and a **Files** entry in BB's left rail. A thread panel is bound to that thread's live environment and uses `bb.sdk.files`, so the same tree/editor works on the local machine and connected hosts. The left-rail panel needs no thread, project, or repository: it browses the machine BB runs on, starting at its home directory.

## Install

BB Files requires BB `>=0.35.1`. Install the current tagged release:

```bash
bb plugin install 'git:https://github.com/Diffuzmetall/bb-plugin-files.git@v0.2.0' --yes
```

After the plugin is listed in the BB Community marketplace, BB can report and
apply compatible tagged updates without installing them automatically:

```bash
bb plugin outdated
bb plugin update files
```

Releases use immutable `vX.Y.Z` Git tags. Marketplace updates within the
current `^0.2.0` range are selected from those tags.

## Project documentation

- [`ROADMAP.md`](ROADMAP.md) — detailed product and technical ideas. Highlighted directions include BB agent integration, breadcrumbs, secure workspace previews, richer HTML/image tooling, filesystem-watch or adaptive-polling synchronization, performance, and reliability.

## Features

- **Multi-Tab Editor**: open multiple files simultaneously with a modern tab bar. Tabs persist per file source (thread workspace or host root) and are restored when the panel is reopened;
- **Two roots**: **Actions → Files** browses a thread's workspace, and **Files** in BB's left rail browses this machine's home directory with no repository involved. Both roots keep the full set of file operations;
- **Resizable Layout**: Modern IDE-style interface with the editor on the left and a resizable, collapsible file tree on the right;
- bounded recursive tree (up to 10,000 files) with fuzzy file search;
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
- narrow panel navigation with a Back control;
- `node_modules` stays hidden in both roots; a thread workspace excludes symlinks through BB's host lister, while the left-rail root shows symlinks that resolve and skips broken ones.

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

The panel receives `{path, source, experimental_lineRange}` and opens that file
inside the active workspace; when BB has no thread for the tab, the panel reports
that the source is unavailable. Git-ref snapshots (diff views) always use BB's
preview.

A link pointing outside the thread's workspace — an absolute terminal path, for
example — does not open: the panel asks you to pick a file from its tree
instead. The left-rail panel can browse such a path, but the opener does not
route to it automatically yet.

BB renders the first applicable opener for an extension unless a preference
says otherwise, so installing the plugin makes the Files panel the default
viewer for these extensions instead of BB's built-in preview. **Settings →
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
- **Persistence**: Tab paths and active tab selection are persisted in `localStorage` per file source (thread workspace or host root). Tabs are automatically re-hydrated on panel remount.
- **UI Layout**: IDE-like layout with a resizable/collapsible file tree on the right and an editor on the left.
- **Previews**:
    - WYSIWYG Markdown preview with direct rendered-text editing and a Raw source fallback.
    - HTML preview with iframe refresh after save and an "Open preview" action.
    - Image preview for common formats.
- **Editor Features**: 700ms autosave, SHA-based optimistic concurrency control (CAS) with conflict/overwrite UI, explicit download/copy actions.
- **Robustness**: 10,000-entry tree cap, hidden dotfile probing, recursive delete/duplication/rename safety, and tests covering state transitions and persistence.

### What is implemented (Key Architecture)
- **State**: `TabState` tracks per-tab `draftText`, `savedText`, `file` metadata, and `saveState`.
- **Scope**: every RPC carries a `FileScope` (`{kind:"thread"}` or `{kind:"host"}`) that the server resolves to one root; a host scope without `rootPath` is this machine's home directory.
- **Flow**: Autosave and polling observe `tabs` array. File reads are throttled and deduplicated using `fileLoadRequestsRef`.
- **Sync**: Conflict detection checks file SHA against remote every 10s.

### Limitations & Known Issues
- **Scroll Position**: Tab switching does not currently persist/restore scroll position (Codemirror instance reset).
- **Large Files**: Files > 2MiB or non-text binaries are metadata-only (no content access).
- **Tab State**: Only the tab *path* is persisted; draft contents are lost if the browser tab is refreshed (only panel-remount persistence is implemented).
- **Out-of-workspace opener paths**: a file link pointing outside the thread workspace does not open — see [Opening files from other plugins](#opening-files-from-other-plugins).

### Next Steps / Future Work

See [`ROADMAP.md`](ROADMAP.md) for the complete idea backlog and proposed implementation phases. The highlighted directions are BB agent integration, breadcrumbs, secure workspace previews, richer HTML/image tooling, replacing constant polling, tree virtualization, and stronger autosave concurrency.

## Safety model

The frontend sends a **scope** — `{kind:"thread",threadId}` or `{kind:"host",hostId?,rootPath?}` — plus a root-relative path. Every RPC resolves the scope again on the server: a thread scope re-resolves the thread environment, and a host scope is confined to `rootPath` (omitting it means this machine's home directory). `listPaths` receives the resolved absolute root because that SDK method has no `rootPath` field. Existing-file writes use their last-read SHA. New files use create-only writes. Folder duplication preflights at 501 entries and refuses more than 500.

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
