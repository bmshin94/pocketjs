import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { encodePNG } from "../../tests/png.ts";

test("held directions scroll a cached TSX list without blanking or growing UI nodes", async () => {
  const out = resolve('.pocket-build/validation/micro-feed/integration', String(Date.now()));
  mkdirSync(out, {recursive:true});
  const dist = join(out,'build');
  async function run(command: string[], log: string, env = process.env) {
    const p = Bun.spawn(command,{stdout:'pipe',stderr:'pipe',env});
    const [stdout,stderr,exit] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    await Bun.write(join(out,log),stdout+stderr);
    expect(exit, stderr).toBe(0); return stdout;
  }
  await run(['bun','micro/compiler/cli.ts','build','micro-feed','--out',dist], 'compile.log');
  await run(['cargo','build','--manifest-path','micro/harness/Cargo.toml','--offline'], 'cargo.log', {...process.env, POCKET_MICRO_APP_RS:join(dist,'app.rs')});
  const parts = ['0:0'];
  const pulse = (frame: number, mask: number) => parts.push(`${frame}:${mask}`,`${frame+1}:0`);
  pulse(140,64); pulse(160,8192); pulse(180,32); pulse(220,32768); pulse(260,4096); pulse(320,32768);
  // Each 10-frame interval gives the actual worker time to serve a page.
  for(let i=0;i<100;i++) pulse(450+i*10,32);
  parts.push("1700:64", "2300:0", "2340:16", "2640:0");
  const tape = parts.join(','); await Bun.write(join(out,'tape.txt'),tape);
  const frames = join(out,'frames');
  const captures = [100,200,240,300,400,1500,1600,1800,2000,2200,2290,2400,2600,2700];
  const stdout = await run(['micro/harness/target/debug/pocket-micro-harness',join(dist,'micro-feed.pak'),tape,'2750',frames,captures.join(','),join(dist,'manifest.json')], 'runtime.log');
  const final = JSON.parse(stdout.trim());
  expect(final.state).toMatchObject({category:1,selected:2,detail:true,feed:{offset:10798,query:1,rows:5,capacity:5,cacheCapacity:256,online:true,loading:false,error:false}});
  expect(final.state.feed.received).toBeGreaterThan(90);
  const state = (f: number) => Bun.file(join(frames,`f${f}.json`)).json();
  expect((await state(100)).feed.offset).toBe(0);
  expect((await state(200)).feed.offset).toBe(5);
  expect((await state(240)).feed.offset).toBe(10005);
  expect((await state(300)).feed.query).toBe(1);
  const before = await Bun.file(join(frames,'f400.metrics.json')).json();
  const after = await Bun.file(join(frames,'f2700.metrics.json')).json();
  expect(after.created_nodes).toBe(40); expect(before.created_nodes).toBe(after.created_nodes);
  expect(after.glyph_misses).toBe(0);
  expect(after.live_bytes - before.live_bytes).toBeLessThan(4096);
  const warmMisses=(await state(1600)).feed.misses;
  for(const frame of [1800,2000,2200,2290,2400,2600,2700]) {
    const value=(await state(frame)).feed;
    expect(value.rows).toBe(5); expect(value.loading).toBe(false);
    expect(value.misses).toBe(warmMisses); expect(value.cached).toBeLessThanOrEqual(256);
  }
  expect((await state(2290)).feed.offset).toBeGreaterThan(10970);
  const db = new Database(join(frames,'companion/feed.sqlite'),{readonly:true});
  const count = db.query('SELECT COUNT(*) AS n FROM notes').get() as {n:number};
  expect(count.n).toBeGreaterThan(450); db.close();
  for (const f of captures) await Bun.write(join(out,`f${f}.png`), encodePNG(new Uint8Array(await Bun.file(join(frames,`f${f}.rgba`)).arrayBuffer()),480,272));
  await Bun.write(join(out,'result.json'),JSON.stringify({final,before,after,companionRows:count.n},null,2));
  console.log(`Micro feed experiment: ${out}`);
}, 180_000);
