import { definePluginApp } from "@bb/plugin-sdk/app";
import { FilesPanel } from "./src/components/FilesPanel";
import "./app.css";

export { FilesPanel } from "./src/components/FilesPanel";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "files",
    title: "Files",
    icon: "FolderOpen",
    layout: "flush",
    component: FilesPanel,
  });
});
