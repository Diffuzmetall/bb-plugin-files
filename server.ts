import type { BbPluginApi } from "@bb/plugin-sdk";
import { filesRpcContract } from "./src/contracts";
import { createFileService } from "./src/file-service";
import { createUploadHandler } from "./src/upload";

export { filesRpcContract } from "./src/contracts";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultNotesDestination: {
      type: "string",
      label: "Save new notes to",
      description:
        "Enter a project name, such as my-notes, or a project and folder, such as my-notes/inbox. New notes are saved there even when another project is open. Leave empty to use the current workspace.",
      default: "",
    },
    defaultNotesHostId: {
      type: "string",
      label: "Computer ID (optional)",
      description:
        "Leave empty to choose the computer automatically. Only fill this in to save notes on a specific computer.",
      default: "",
    },
  });

  bb.rpc.register(filesRpcContract, createFileService(bb, settings));
  bb.http.route("POST", "/upload", createUploadHandler(bb), { auth: "token" });
  bb.log.info("Files plugin loaded");
}
