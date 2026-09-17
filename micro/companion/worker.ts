import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { createFeedService } from "./feed.ts";
import { dispatchOffload } from "../../tools/offload-provider.ts";
import type { OffloadRequest } from "../../contracts/spec/offload.ts";

let service: ReturnType<typeof createFeedService>;
let control: string | undefined;
let log: string;
self.onmessage = async ({ data }: MessageEvent<OffloadRequest & { init?: { manifest: string; database: string; log: string; control?: string } }>) => {
  if (data.init) {
    const manifest = JSON.parse(readFileSync(data.init.manifest, "utf8"));
    service = createFeedService(data.init.database, manifest.capabilities[0]);
    control = data.init.control; log = data.init.log;
    self.postMessage({ ready: true }); return;
  }
  const start = Date.now();
  // Explicit experiment controls, owned by the Companion. Never app globals.
  const mode = control && existsSync(control) ? JSON.parse(readFileSync(control, "utf8")) : {};
  if (mode.delayMs) await Bun.sleep(Math.min(8000, Math.max(0, mode.delayMs)));
  const reply = mode.error ? { id: data.id, error: "Injected provider failure" } : await dispatchOffload(service.methods, data);
  appendFileSync(log, JSON.stringify({ request: data, reply, elapsedMs: Date.now() - start, counts: service.counts() }) + "\n");
  self.postMessage(reply);
};
