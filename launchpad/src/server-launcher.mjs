import { fileURLToPath } from "node:url";
import { launchLazurioLaunchpadServer } from "./server-launcher-lib.mjs";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
process.exitCode = await launchLazurioLaunchpadServer({
  args: Bun.argv.slice(2),
  serverPath,
});
