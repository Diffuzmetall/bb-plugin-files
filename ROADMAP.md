# BB Files — Product and Technical Roadmap

> Status: idea backlog. Items in this document are proposals, not implemented features, unless they are also listed as completed in `README.md`.

This document captures ideas for making BB Files faster, safer, more reliable, and more deeply integrated with BB. It is intentionally broader than the immediate implementation plan so useful ideas are not lost.

## Priority legend

- **P0 — highlighted direction:** high-value or strategically important idea.
- **P1 — strong improvement:** meaningful usability, performance, or reliability gain.
- **P2 — polish:** useful after the core workflows are mature.

## Highlighted product directions

### P0 — BB agent integration

Turn Files into the bridge between the workspace, the user, and BB agents instead of treating it as only a text editor.

Proposed actions:

- **Ask BB about this file** from the tab or tree context menu.
- **Ask BB about selected lines** while preserving `path:startLine:endLine` context.
- **Attach file to thread** without manually copying its contents.
- **Explain this code**, **Fix this selection**, and **Write tests for this file** actions.
- Copy or insert stable file references such as `src/app.tsx:42-68` into the thread composer.
- Show files recently read or modified by an agent and allow opening them directly.
- Add an **Agent Changes** view containing files changed by an agent, before/after diffs, and actions to accept, revert, or discuss a specific change.
- Surface external edits immediately with an “Agent modified this file” badge instead of presenting every update as an unexplained filesystem conflict.

The strongest differentiating feature would be **Agent Changes / Review Mode**: review an agent’s edits file by file, inspect a diff, discuss selected lines, and accept or revert changes.

### P0 — replace constant polling with efficient workspace synchronization

The current implementation checks the tree and open files every 10 seconds. This is simple but creates unnecessary RPC traffic and introduces update latency.

Preferred approach:

1. Use host filesystem watch events if the BB SDK exposes a safe workspace-scoped watcher.
2. Subscribe only to the active thread environment and paths needed by the panel.
3. Coalesce bursts of filesystem events before refreshing the tree.
4. Update only affected files/directories instead of reloading the whole tree.
5. Stop watchers when the panel is unmounted and restore them after reconnect.

Fallback when watch events are unavailable:

- poll the active file more frequently than background tabs;
- slow down polling when the panel is hidden or inactive;
- pause polling while offline;
- add backoff after errors;
- batch checks for open tabs;
- avoid refreshing the full tree when no directory changes are detected.

Success criteria:

- lower RPC volume on large remote environments;
- external edits appear faster than the current 10-second interval;
- no duplicate reads during reconnects or rapid tab switching.

### P0 — secure preview architecture

HTML Preview executes workspace-provided code and must be treated as untrusted content.

Security requirements:

- keep iframe sandboxing restrictive by default;
- do not allow top-level navigation;
- only enable scripts, forms, popups, or same-origin access when required and deliberately audited;
- prefer a separate preview origin where the platform permits it;
- apply an explicit Content Security Policy;
- prevent preview pages from accessing BB authentication data or plugin storage;
- provide a “Disable scripts” mode;
- clearly indicate when scripts are enabled;
- revoke temporary preview URLs when they are no longer needed;
- test malicious navigation, popup, download, and cross-origin scenarios.

Before expanding Preview permissions, audit the implications of `allow-scripts` combined with `allow-same-origin`. Security should take priority over compatibility.

### P0 — richer HTML Preview

Build on the existing `.html` / `.htm` iframe preview:

- support source and preview side by side;
- add responsive viewport presets: phone, tablet, desktop, and custom size;
- reload after a successful autosave without unnecessarily recreating the entire editor;
- add manual reload and “Open in browser” actions;
- display iframe runtime errors and console messages;
- show loading and preview-failure states;
- preserve Preview/Raw mode per tab;
- support relative CSS, JavaScript, fonts, links, and images using a workspace-aware preview server;
- resolve nested routes and relative URLs from the HTML file’s directory;
- optionally disable external network requests;
- expose a clear warning when the preview contains executable scripts.

A workspace-aware preview server is important: a temporary URL for one HTML file may not resolve relative assets correctly.

### P0 — richer image workflows

Improve image viewing beyond basic inline rendering:

- zoom in/out, reset zoom, and fit-to-screen;
- pan large images;
- checkerboard background for transparency;
- show native dimensions, rendered dimensions, MIME type, and file size;
- copy image or download original;
- SVG **Preview / Source** mode;
- compare two images with overlay, slider, or side-by-side view;
- display animation controls for GIF/WebP where feasible;
- preserve zoom and pan state per tab;
- provide clear loading/error states for remote images.

### P0 — breadcrumbs and location-aware navigation

Add an editor breadcrumb bar such as:

`src › components › EditorPane.tsx`

Useful behaviors:

- click a directory segment to reveal or navigate to it in the tree;
- copy full or relative path;
- copy path with cursor location, for example `src/components/EditorPane.tsx:120`;
- show symbols below the file breadcrumb when language parsing is available;
- add **Go to line** with `Cmd/Ctrl+G`;
- keep the active file visible in the tree when switching tabs;
- support compact breadcrumbs in narrow layouts.

## Discovery and navigation

### P1 — Quick Open (`Cmd/Ctrl+P`)

- fuzzy search by filename and full path;
- prioritize recent and currently open files;
- keyboard-only navigation;
- display enough parent path to disambiguate duplicate filenames;
- open in the current group or a split;
- avoid rebuilding the search index for every keystroke.

### P1 — project-wide content search

- literal and regular-expression search;
- case-sensitive and whole-word modes;
- include/exclude globs;
- group matches by file with line previews;
- open the exact line and highlight the match;
- replace one, replace in file, or replace all with a diff preview;
- perform search on the host for remote environments instead of downloading every file;
- stream results and support cancellation for large repositories.

### P1 — favorites, recents, and worksets

- pin important files and folders;
- show recently opened and recently modified files;
- save named tab sets such as “Frontend”, “Server”, or “Bug investigation”;
- restore a workset with one action.

## Editor and tab workflows

### P1 — more complete tab behavior

- reorder tabs with drag and drop;
- pin tabs;
- optional preview tab on single click and permanent tab on double click;
- close other tabs, close tabs to the right, and close saved tabs;
- reopen the last closed tab;
- display parent directories when two files share the same name;
- show distinct dirty, saving, conflict, offline, and externally modified states;
- add keyboard navigation between tabs.

### P1 — richer session restoration

Persist non-sensitive UI state per thread:

- tab order and active tab;
- cursor selection;
- CodeMirror scroll position;
- expanded directories;
- file-tree width and collapsed state;
- Preview/Raw mode per tab;
- recently closed tabs.

Do not persist file contents or `.env` drafts in plain `localStorage`. If crash recovery for drafts is added, make it opt-in, use a safer storage design, and exclude sensitive paths by default.

### P1 — split editor

- horizontal and vertical splits;
- drag tabs between editor groups;
- source and preview in separate groups;
- compare two files side by side;
- preserve independent cursor and scroll state per group.

### P1 — command palette

Add `Cmd/Ctrl+Shift+P` commands for:

- create, rename, duplicate, delete, and download;
- toggle file tree and preview;
- copy path or path with line range;
- quick open and project search;
- format document;
- invoke BB agent actions.

### P2 — editor productivity

- in-file search and replace;
- syntax-aware symbol outline where supported;
- language-aware indentation and formatting;
- configurable word wrap;
- keyboard shortcut reference;
- optional minimap only if it does not harm performance or visual simplicity.

## Diff, change review, and Git

### P1 — file diff and history

- compare draft with last saved content;
- compare local content with the latest remote SHA;
- side-by-side and inline diff modes;
- revert selected hunks;
- inspect before/after agent changes;
- retain a bounded in-memory history for the current editing session.

### P1 — Git-aware tree

When the environment is a Git repository:

- show modified, added, deleted, renamed, and untracked statuses;
- provide a Changed Files filter;
- open Git diffs;
- stage/unstage only if the BB plugin boundary and product policy permit it;
- require confirmation before discarding changes.

## Performance

### P0 — virtualized and incremental file tree

The tree can contain up to 10,000 entries. Rendering and updating every visible row at once will eventually become expensive.

Proposed improvements:

- virtualize rendered rows;
- lazily load directory children when the host API permits it;
- cache expanded directory results;
- update only changed tree branches;
- cancel stale searches and list requests;
- preserve selection and expansion state across refreshes;
- measure rendering time and memory usage on large repositories.

### P1 — file cache and prefetch

- maintain a bounded LRU cache for recently opened files;
- render cached content immediately and validate SHA in the background;
- prefetch likely next files conservatively;
- deduplicate concurrent reads;
- invalidate cache entries on filesystem events, saves, moves, and deletes;
- cap memory usage by file count and total bytes.

### P1 — scalable search indexing

- build indexes on the host where possible;
- update indexes incrementally after changes;
- stream partial results;
- support cancellation;
- avoid indexing excluded paths such as `node_modules`.

## Reliability and safety

### P0 — stronger per-file autosave queue

- serialize writes per path;
- ensure the latest draft wins when edits occur during an active save;
- never mark a newer draft as saved using an older response;
- use generation IDs or expected draft snapshots for save completion;
- retry temporary failures with bounded backoff;
- pause and clearly report offline state;
- flush dirty tabs before deliberate close when possible;
- preserve drafts when conflicts occur;
- test rapid typing, slow remote hosts, tab close during save, and reconnect races.

### P1 — clearer remote-environment states

- loading, reconnecting, offline, permission-denied, and unavailable states;
- retry actions that preserve current drafts;
- request timeouts and cancellation;
- actionable error messages rather than generic failures;
- no fallback to an unrelated local environment.

### P1 — mutation safety

- preview recursive delete and large rename operations;
- show affected open tabs before moving directories;
- preserve tab paths when a parent directory is renamed;
- provide undo for safe, reversible operations where possible;
- maintain strict project-relative path validation.

## Testing and observability

### P1 — high-value regression coverage

Add tests for likely failure points:

- HTML preview URL generation and sandbox permissions;
- relative asset handling in workspace previews;
- tab restoration and active tab selection;
- concurrent autosaves and stale responses;
- external edits during a dirty draft;
- moves/deletes affecting multiple open tabs;
- hidden-file probing;
- remote download and image preview failures;
- large virtualized trees and search cancellation.

### P2 — lightweight diagnostics

- development-only RPC timing and failure counters;
- report tree size, truncation, and render timing;
- identify slow remote reads without logging file contents or secrets;
- provide a copyable diagnostics summary for bug reports.

## Suggested implementation order

### Phase 1 — immediate user value

1. Quick Open (`Cmd/Ctrl+P`).
2. Breadcrumbs and copy path with line range.
3. Project-wide content search.
4. Better tab actions and reopen closed tab.
5. “Ask BB about selected lines”.

### Phase 2 — performance and reliability

1. Stronger per-file autosave queue.
2. Filesystem watch or adaptive polling.
3. Virtualized tree.
4. Bounded file cache.
5. Better reconnect/offline states.

### Phase 3 — differentiated BB experience

1. Agent Changes / Review Mode.
2. Side-by-side diff.
3. Workspace-aware, secure HTML Preview.
4. Split editor.
5. Git-aware changed-files view.

### Phase 4 — visual and media tooling

1. Image zoom, pan, metadata, and SVG source mode.
2. Responsive HTML preview presets.
3. Preview console and errors.
4. Image comparison.

## Definition of success

The plugin should feel fast on large local and remote repositories, preserve user context across panel remounts, make concurrent user/agent edits understandable, and safely preview workspace content without exposing BB or browser credentials.
