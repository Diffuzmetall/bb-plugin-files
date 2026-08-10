# BB Files

A standalone BB plugin that adds **Actions → Files** to every thread. The panel is bound to that thread's live environment and uses `bb.sdk.files`, so the same tree/editor works on the local machine and connected hosts.

## Project documentation

- [`ROADMAP.md`](ROADMAP.md) — detailed product and technical ideas. Highlighted directions include BB agent integration, breadcrumbs, secure workspace previews, richer HTML/image tooling, filesystem-watch or adaptive-polling synchronization, performance, and reliability.

## Features

- **Multi-Tab Editor**: open multiple files simultaneously with a modern tab bar. Tabs persist per thread and are restored when the Files panel is reopened;
- **Resizable Layout**: Modern IDE-style interface with the editor on the left and a resizable, collapsible file tree on the right;
- bounded recursive tree (up to 10,000 files) with fuzzy file search;
- **Depth-first tree rendering**: accurately reconstructs project hierarchy with auto-expansion of active file paths;
- **Hidden files support**: dynamically probes and reveals common configuration dotfiles (e.g. `.env`, `.gitignore`, `.github`, `.vscode`, etc.) which are normally excluded by the host lister;
- UTF-8 editing up to 2 MiB with CodeMirror 6;
- BB-native Markdown **Preview**, editable **Raw** mode, **Image Previews**, and HTML previews in an inline iframe or separate browser tab;
- 700 ms autosave and Cmd/Ctrl+S;
- SHA-based compare-and-swap with explicit Reload/Overwrite conflict handling;
- 10-second tree/file external-change polling;
- create, rename (safely preserves unsaved drafts), duplicate, recursive delete, copy file content, copy relative path, and **download** actions;
- narrow panel navigation with a Back control;
- symlinks and `node_modules` remain excluded by BB's host lister.

## Development

```bash
npm install --legacy-peer-deps
npm run typecheck
npm test
bb plugin build .
bb plugin install "$PWD" --yes
```

Then open a thread and choose **New tab → Actions → Files** in its right panel. During development, run `bb plugin dev "$PWD"`.

## Hand-off / Current Status

This is a comprehensive summary of the current implementation for future maintenance and feature development.

### What works
- **Multi-Tab Engine**: Core `useFilesWorkspace` hook refactored to support array-based `tabs` state. Supports concurrent open files with independent draft buffers.
- **Persistence**: Tab paths and active tab selection are persisted in `localStorage` per `threadId`. Tabs are automatically re-hydrated on panel remount.
- **UI Layout**: IDE-like layout with a resizable/collapsible file tree on the right and an editor on the left.
- **Previews**:
    - Markdown preview with the BB-native renderer.
    - HTML preview with iframe refresh after save and an "Open preview" action.
    - Image preview for common formats.
- **Editor Features**: 700ms autosave, SHA-based optimistic concurrency control (CAS) with conflict/overwrite UI, explicit download/copy actions.
- **Robustness**: 10,000-entry tree cap, hidden dotfile probing, recursive delete/duplication/rename safety, and tests covering state transitions and persistence.

### What is implemented (Key Architecture)
- **State**: `TabState` tracks per-tab `draftText`, `savedText`, `file` metadata, and `saveState`.
- **Flow**: Autosave and polling observe `tabs` array. File reads are throttled and deduplicated using `fileLoadRequestsRef`.
- **Sync**: Conflict detection checks file SHA against remote every 10s.

### Limitations & Known Issues
- **Scroll Position**: Tab switching does not currently persist/restore scroll position (Codemirror instance reset).
- **Large Files**: Files > 2MiB or non-text binaries are metadata-only (no content access).
- **Tab State**: Only the tab *path* is persisted; draft contents are lost if the browser tab is refreshed (only panel-remount persistence is implemented).

### Next Steps / Future Work

See [`ROADMAP.md`](ROADMAP.md) for the complete idea backlog and proposed implementation phases. The highlighted directions are BB agent integration, breadcrumbs, secure workspace previews, richer HTML/image tooling, replacing constant polling, tree virtualization, and stronger autosave concurrency.

## Safety model

The frontend sends only `threadId` and project-relative paths. Every RPC resolves the thread environment again. Reads and mutations are confined with `hostId` and `rootPath`; `listPaths` receives the resolved absolute root because that SDK method has no `rootPath` field. Existing-file writes use their last-read SHA. New files use create-only writes. Folder duplication preflights at 501 entries and refuses more than 500.

Binary and oversized files are metadata-only. There is no fallback to the primary machine when the thread environment is unavailable.
