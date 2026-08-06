# BB Files

A standalone BB plugin that adds **Actions → Files** to every thread. The panel is bound to that thread's live environment and uses `bb.sdk.files`, so the same tree/editor works on the local machine and connected hosts. 

## Features

- **Multi-Tab Editor**: Open multiple files simultaneously with a modern tab bar. Seamlessly switch between files while each tab preserves its own draft state, autosave timers, and scroll position;
- **Resizable Layout**: Modern IDE-style interface with the editor on the left and a resizable, collapsible file tree on the right;
- bounded recursive tree (up to 10,000 files) with fuzzy file search;
- **Depth-first tree rendering**: accurately reconstructs project hierarchy with auto-expansion of active file paths;
- **Hidden files support**: dynamically probes and reveals common configuration dotfiles (e.g. `.env`, `.gitignore`, `.github`, `.vscode`, etc.) which are normally excluded by the host lister;
- UTF-8 editing up to 2 MiB with CodeMirror 6;
- BB-native Markdown **Preview**, editable **Raw** mode, and **Image Previews** (inline rendering for image files);
- 700 ms autosave, Save, and Cmd/Ctrl+S;
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

## Safety model

The frontend sends only `threadId` and project-relative paths. Every RPC resolves the thread environment again. Reads and mutations are confined with `hostId` and `rootPath`; `listPaths` receives the resolved absolute root because that SDK method has no `rootPath` field. Existing-file writes use their last-read SHA. New files use create-only writes. Folder duplication preflights at 501 entries and refuses more than 500.

Binary and oversized files are metadata-only. There is no fallback to the primary machine when the thread environment is unavailable.
