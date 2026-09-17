#!/usr/bin/env bun
// Build micro-feed with --receipt-every 60 and the tape printed by --tape.
// The PSP must be at a fresh PSPLINK shell; this runner does not reset it.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { connectOffloadUsbProvider } from "../../tools/offload-usb-provider.ts";
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
const tape = ["0:0"];
const pulse = (f: number, mask: number) => tape.push(`${f}:${mask}`,`${f+1}:0`);
// Warm five-digit labels and draw buffers before measuring steady scroll.
pulse(300,8192 | 32768);
tape.push("420:64","1620:0","1800:16","2400:0","2700:64","3300:0");
pulse(3660,4096); pulse(3900,8); pulse(4140,8); tape.push("5100:0");
if (args.includes("--tape")) { console.log(tape.join(",")); process.exit(0); }
const hostArg = flag("--host0");
if (!hostArg) throw Error("feed-device.ts --host0 <USB directory> [--out <run directory>]; stop other micro-feed providers first");
const host0 = resolve(hostArg);
const out = resolve(flag("--out") ?? `.pocket-build/validation/micro-feed/device/${Date.now()}`);
const manifestPath = resolve("dist/micro/micro-feed/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath,"utf8"));
const prx = resolve("hosts/psp-micro/target/mipsel-sony-psp/release/pocket-micro-psp.prx");
mkdirSync(out,{recursive:true});
const control = join(out,"control.json");
const setControl = (v: unknown) => { writeFileSync(control+".tmp",JSON.stringify(v)); renameSync(control+".tmp",control); };
setControl({});
const launchProvider = () => connectOffloadUsbProvider({ directory:host0,app:"micro-feed",worker:new URL("../companion/worker.ts",import.meta.url),data:{manifest:manifestPath,database:join(out,"feed.sqlite"),log:join(out,"requests.jsonl"),control} });
let provider = launchProvider();
const stages: Record<string, any> = {};
const logs: string[] = [];
const say = (s: string) => { logs.push(s); console.log(s); };
async function shell(command: string) {
  // pspsh buffers stdout on pipes; a timeout would lose the PSP exception dump.
  let output = "";
  const p = Bun.spawn(["pspsh","-p",flag("--port") ?? "10000","-e",command],{terminal:{data:(_,bytes)=>{output+=new TextDecoder().decode(bytes);}}});
  const timer=setTimeout(()=>p.kill(),10000);
  const code=await p.exited;clearTimeout(timer);p.terminal?.close();
  const text=output.trim();say(`${command}: ${text}`);
  if(code!==0 || /(?:^|[\r\n])(?:Failed\b|Error\b|Exception\b)/i.test(text))throw Error(`PSPLINK command failed: ${command}`);
  return text;
}
function check(condition: boolean, message: string): asserts condition { if(!condition)throw Error(message); }
async function capture(name: string, frame: number) {
  const deadline=Date.now()+70000;
  let receipt:any;
  while(Date.now()<deadline) {
    try { const value=JSON.parse(readFileSync(join(host0,"pocket-micro-receipt.txt"),"utf8")); if(value.build===manifest.buildHash && value.frame>=frame){receipt=value;break;} }catch{}
    await Bun.sleep(100);
  }
  check(!!receipt,`No matching receipt at frame ${frame}`);
  check(receipt.tape===tape.join(","),"Binary tape does not match the experiment");
  writeFileSync(join(out,`${name}.json`),JSON.stringify(receipt,null,2)); stages[name]=receipt;
  say(`${name}: frame=${receipt.frame}, state=${JSON.stringify(receipt.state)}, live=${receipt.arena_live_class_bytes}, nodes=${receipt.created_nodes}`);
  await shell(`scrshot host0:/micro-feed-${name}.bmp`);
  const bmp=join(out,`${name}.bmp`);copyFileSync(join(host0,`micro-feed-${name}.bmp`),bmp);
  const png=Bun.spawnSync(["sips","-s","format","png",bmp,"--out",join(out,`${name}.png`)],{stdout:"pipe",stderr:"pipe"});
  check(png.exitCode===0,"Screenshot conversion failed");
  return receipt;
}
try {
  const threads=await shell("thlist");check(!/pocketjs_main|pocket-offload/.test(threads),"A Pocket app is already running; reset PSPLINK before this experiment");
  copyFileSync(prx,join(host0,"pocket-micro-psp.prx"));rmSync(join(host0,"pocket-micro-receipt.txt"),{force:true});
  // Separate transfer/relocation from execution so failures identify the stage.
  const load=await shell("modload host0:/pocket-micro-psp.prx");
  check(/Name: pocket-micro/.test(load),"No successful module load acknowledgement");
  const start=await shell("modstart @pocket-micro host0:/pocket-micro-psp.prx");
  const started=/Module Start 0x([0-9A-F]+) Status 0x([0-9A-F]+)/i.exec(start);
  check(!!started && parseInt(started[1],16)<0x80000000 && parseInt(started[2],16)===0,"No successful module start acknowledgement");
  const initial=await capture("initial",240);
  check(initial.state.feed.rows===5 && initial.state.feed.cached===256,"Initial prefetch failed");
  const warm=await capture("warm",360);
  const held=await capture("held",1200);
  const fast=await capture("fast",1560);
  const reverse=await capture("reverse",2340);
  const settled=await capture("settled",2640);
  for (const r of [held,fast,reverse,settled]) {
    check(r.state.feed.rows===5 && !r.state.feed.loading,"Warm scrolling blanked a row");
    check(r.state.feed.misses===warm.state.feed.misses,"Warm scrolling had a cache miss");
  }
  check(fast.state.feed.offset>11000 && reverse.state.feed.offset<fast.state.feed.offset,"Held repeat or reverse did not move");
  check(settled.arena_live_class_bytes-warm.arena_live_class_bytes<4096,"Live memory grew while scrolling");
  setControl({delayMs:800});
  const slow=await capture("slow",3180);
  check(slow.state.feed.offset>settled.state.feed.offset+350 && slow.state.feed.misses>settled.state.feed.misses,"Slow source did not exercise placeholders while moving");
  await capture("slow-stop",3360);setControl({});
  const recovered=await capture("caught-up",3600);check(recovered.state.feed.rows===5,"Visible rows did not catch up");
  const filtered=await capture("filtered",3840);check(filtered.state.category===1 && filtered.state.feed.rows===5,"Filter failed");setControl({error:true});
  const error=await capture("error",4080);check(error.state.feed.error && error.state.feed.rows===5,"Provider error discarded cached rows");setControl({});
  const retry=await capture("retry",4320);check(!retry.state.feed.error && retry.state.feed.rows===5,"Retry failed");provider.close();
  const offline=await capture("offline",4620);check(!offline.state.feed.online && offline.state.feed.rows===5,"Offline discarded cached rows");provider=launchProvider();
  const reconnected=await capture("reconnected",4860);check(reconnected.state.feed.online && reconnected.state.feed.rows===5 && reconnected.state.feed.query===1,"Reconnect failed");
  for(const r of Object.values(stages))check(r.glyph_misses===0 && r.created_nodes===40 && r.state.feed.cached<=256 && r.state.feed.inflight<=4,"Storage, glyph or node bound failed");
  const result={build:manifest.buildHash,prxSha256:createHash("sha256").update(readFileSync(prx)).digest("hex"),passed:true,stages};
  writeFileSync(join(out,"result.json"),JSON.stringify(result,null,2));say(`PASS: ${out}`);
} catch(error) {say(`FAIL: ${error instanceof Error?error.message:String(error)}`);throw error;}
finally {provider.close();writeFileSync(join(out,"device.log"),logs.join("\n")+"\n");}
