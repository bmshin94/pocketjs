#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { connectOffloadUsbProvider } from "../../tools/offload-usb-provider.ts";
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const usb = flag("--usb");
if (!usb) throw Error("usage: bun micro/companion/serve.ts --usb <host0> [--manifest dist/micro/micro-feed/manifest.json] [--data <directory>] [--control <json>]");
const root = resolve(flag("--data") ?? ".pocket-build/micro-feed-companion");
mkdirSync(root, { recursive: true });
const manifest = resolve(flag("--manifest") ?? "dist/micro/micro-feed/manifest.json");
const compiled = await Bun.file(manifest).json();
const provider = connectOffloadUsbProvider({ directory: usb, app: compiled.app, worker: new URL("./worker.ts", import.meta.url),
  data: { manifest, database: resolve(root, "feed.sqlite"), log: resolve(root, "requests.jsonl"), control: flag("--control") && resolve(flag("--control")!) }, log: console.log });
console.log(`Companion stores records and history in ${root}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { provider.close(); process.exit(0); });
