// The desktop experiment uses the same capability service as the PSP worker.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createFeedService } from "./feed.ts";
import { dispatchOffload } from "../../tools/offload-provider.ts";
const [manifestPath, dataPath] = process.argv.slice(2);
if (!manifestPath || !dataPath) throw Error("stdio.ts <manifest.json> <data-directory>");
mkdirSync(dataPath, { recursive: true });
const manifest = await Bun.file(manifestPath).json();
const service = createFeedService(resolve(dataPath, "feed.sqlite"), manifest.capabilities[0]);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const reply = await dispatchOffload(service.methods, request);
  process.stdout.write(JSON.stringify(reply) + "\n");
}
service.close();
