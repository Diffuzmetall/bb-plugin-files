import { definePluginApp } from "@bb/plugin-sdk/app";
import { FilesPanel } from "./src/components/FilesPanel";
import { FILE_OPENER_EXTENSIONS } from "./src/file-opener-extensions";
import "./app.css";

export { FilesPanel } from "./src/components/FilesPanel";
export { FILE_OPENER_EXTENSIONS } from "./src/file-opener-extensions";

export default definePluginApp((app) => {
  // The left-sidebar entry. Its route carries no thread, so it browses the
  // global root — this machine's home directory — and works outside a repo.
  app.slots.navPanel({
    id: "files",
    title: "Files",
    icon: "FolderOpen",
    path: "files",
    component: FilesPanel,
  });
  // The same panel inside one thread, bound to that thread's workspace.
  app.slots.threadPanelAction({
    id: "files",
    title: "Files",
    icon: "FolderOpen",
    layout: "flush",
    component: FilesPanel,
  });
  // Matching files — including file links clicked in rendered Markdown and in
  // other plugins' panels — open this panel instead of BB's built-in preview.
  app.slots.fileOpener({
    id: "files",
    title: "Files",
    extensions: FILE_OPENER_EXTENSIONS,
    component: FilesPanel,
  });
});
