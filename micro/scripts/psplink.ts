#!/usr/bin/env bun
// micro/scripts/psplink.ts — run a Pocket Micro PRX on a real PSP over PSPLINK
// and collect the device receipt plus a screenshot.
//
//   bun micro/scripts/psplink.ts <prx> [--port 10000] [--host0 <dir>] [--out <dir>]
//       [--settle <ms>] [--shot <name>] [--expected-build <hash>] [--no-reset]
//
// With --host0 the script reuses a usbhostfs_pc that is already serving that
// directory on --port (another session's, or one started by hand); otherwise
// it starts usbhostfs_pc itself on --out and waits for the PSP to connect.
// Flow: copy the PRX into host0:, `reset` PSPLINK, `ldstart host0:/<prx>`,
// wait --settle ms, `scrshot host0:/<shot>.bmp`, then copy the receipt the
// EBOOT wrote (host0:/pocket-micro-receipt.txt) and the shot into --out.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const prx = args.find((a) => !a.startsWith("--") && a.endsWith(".prx"));
if (!prx || !existsSync(prx)) {
  console.error("usage: bun micro/scripts/psplink.ts <prx> [--port 10000] [--host0 <dir>] [--out <dir>] [--settle <ms>] [--shot <name>] [--expected-build <hash>]");
  process.exit(2);
}
const port = Number(flag("--port") ?? "10000");
const out = resolve(flag("--out") ?? join(".pocket-build/validation/pocket-micro/device", String(Date.now())));
const settleMs = Number(flag("--settle") ?? "8000");
const shotName = flag("--shot") ?? basename(prx, ".prx");
mkdirSync(out, { recursive: true });

const pspsh = Bun.which("pspsh");
const usbhostfs = Bun.which("usbhostfs_pc");
if (!pspsh || !usbhostfs) {
  console.error("PSPLINK host tools not found on PATH (need usbhostfs_pc and pspsh).");
  process.exit(1);
}

async function sh(command: string, timeoutMs = 8000): Promise<{ text: string; timedOut: boolean }> {
  // Preserve line-buffered PSP exceptions even when a command times out.
  let output = "";
  const child = Bun.spawn([pspsh!, "-p", String(port), "-e", command], {
    terminal: { data: (_, bytes) => { output += new TextDecoder().decode(bytes); } },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  await child.exited;
  clearTimeout(timer);
  child.terminal?.close();
  return { text: output.trim(), timedOut };
}

async function waitForShell(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await sh("thlist", 3000);
    if (!r.timedOut && /UID|Thread|psplink|Name/i.test(r.text)) return true;
    await Bun.sleep(500);
  }
  return false;
}

let host0 = flag("--host0");
let server: ReturnType<typeof Bun.spawn> | undefined;
if (!host0) {
  host0 = join(out, "host0");
  mkdirSync(host0, { recursive: true });
  const fd = openSync(join(out, "usbhostfs.log"), "a");
  try {
    // Keep stdin open: usbhostfs_pc spins in select/fgets after stdin EOF.
    server = Bun.spawn([usbhostfs, "-b", String(port), host0], { stdin: "pipe", stdout: fd, stderr: fd });
  } finally { closeSync(fd); }
  console.log(`usbhostfs_pc started on port ${port}, serving ${host0}; launch PSPLINK on the PSP`);
}
host0 = resolve(host0);
const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};

try {
  rmSync(join(host0, "pocket-micro-receipt.txt"), { force: true });
  rmSync(join(host0, `${shotName}.bmp`), { force: true });
  copyFileSync(prx, join(host0, basename(prx)));
  say(`copied ${basename(prx)} -> host0:/`);
  if (!(await waitForShell(60_000))) throw new Error("PSPLINK shell did not answer on port " + port);
  const ver = await sh("ver");
  say(`shell: ${ver.text}`);
  if (!args.includes("--no-reset")) {
    const reset = await sh("reset", 5000);
    say(`reset: ${reset.timedOut ? "(no reply, as expected)" : reset.text}`);
    await Bun.sleep(2500);
    if (!(await waitForShell(30_000))) throw new Error("PSPLINK did not come back after reset");
  }
  const start = await sh(`ldstart host0:/${basename(prx)}`, 10_000);
  say(`ldstart: ${start.text || "(ok)"}`);
  if (start.timedOut) throw new Error("ldstart timed out; no device acceptance");
  if (/(?:^|[\r\n])(?:Failed\b|Error\b|Exception\b)/i.test(start.text)) throw new Error(start.text);
  await Bun.sleep(settleMs);
  const threads = await sh("thlist");
  say(`threads: ${threads.text.split("\n").filter((l) => /pocketjs_main|main_thread|pocket/.test(l)).join(" | ")}`);
  const shot = await sh(`scrshot host0:/${shotName}.bmp`, 15_000);
  say(`scrshot: ${shot.text || "(ok)"}`);
  await Bun.sleep(1000);
  const receiptPath = join(host0, "pocket-micro-receipt.txt");
  if (existsSync(receiptPath)) {
    const receipt = readFileSync(receiptPath, "utf8").trim();
    const parsed = JSON.parse(receipt);
    const expected = flag("--expected-build");
    if (expected && parsed.build !== expected) throw new Error(`Wrong device build: ${parsed.build}, expected ${expected}`);
    copyFileSync(receiptPath, join(out, "receipt.json"));
    say(`receipt: ${receipt}`);
  } else {
    throw new Error("Fresh device receipt missing; no device acceptance");
  }
  const bmp = join(host0, `${shotName}.bmp`);
  if (!existsSync(bmp)) throw new Error("Device screenshot missing");
  if (existsSync(bmp)) {
    copyFileSync(bmp, join(out, `${shotName}.bmp`));
    const conv = Bun.spawnSync(["sips", "-s", "format", "png", join(out, `${shotName}.bmp`), "--out", join(out, `${shotName}.png`)], { stdout: "pipe", stderr: "pipe" });
    say(`screenshot: ${join(out, conv.exitCode === 0 ? `${shotName}.png` : `${shotName}.bmp`)}`);
  }
} catch (error) {
  say(`failed: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
} finally {
  await Bun.write(join(out, "psplink.log"), log.join("\n") + "\n");
  server?.kill();
}
