import type { BbPluginApi } from "@bb/plugin-sdk";
import { filesRpcContract } from "./src/contracts";
import { createFileService } from "./src/file-service";

export { filesRpcContract } from "./src/contracts";

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(filesRpcContract, createFileService(bb));
  bb.log.info("Files plugin loaded");
}
