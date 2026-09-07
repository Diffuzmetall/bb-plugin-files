import type { BbPluginApi } from "@bb/plugin-sdk";
import { filesRpcContract } from "./src/contracts";
import { createFileService } from "./src/file-service";
import { createUploadHandler } from "./src/upload";

export { filesRpcContract } from "./src/contracts";

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(filesRpcContract, createFileService(bb));
  bb.http.route("POST", "/upload", createUploadHandler(bb), { auth: "token" });
  bb.log.info("Files plugin loaded");
}
