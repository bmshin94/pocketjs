import { expect, test } from "bun:test";
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
import { archiveProvider } from "./helpers/font-archive-provider.ts";
import { bootWorld, treeHasText } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";
import { unpack } from "../framework/compiler/pak.ts";

test("ordinary Text streams unbaked CJK, preserves controls during failure, and recovers", async () => {
  const build = Bun.spawnSync(
    [process.execPath, "tools/build.ts", "text-cjk"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
  const bundle = await Bun.file("dist/text-cjk-main.js").text();
  expect(bundle).not.toContain("你好世界");
  const atlases = unpack(
    new Uint8Array(await Bun.file("dist/text-cjk-main.pak").arrayBuffer()),
  ).filter((b) => b.key.startsWith("ui:font."));
  for (const { data } of atlases) {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < v.getUint16(6, true); i++)
      expect(v.getUint32(16 + i * 8, true)).not.toBe(0x4e00);
  }
  const source = await bakeFontArchive({
    font: "assets/fonts/NotoSansCJK-Demo.otf",
    slots: [0, 2, 4],
  });
  const provider = archiveProvider(source);
  provider.fail(true);
  const world = await bootWorld("text-cjk-main", 60, {
    offload: {
      session: () => 0,
      submit: () => false,
      take: () => undefined,
      local: provider.ops,
    },
  });
  const step = (mask = 0) => {
    provider.step();
    world.frame(mask);
    world.tick();
    world.render();
  };
  const advance = (n: number) => {
    for (let i = 0; i < n; i++) step();
  };
  const press = (mask: number) => {
    step(mask);
    step();
  };
  advance(30);
  press(BTN.RTRIGGER);
  expect(treeHasText(world.getTree(), "2/82")).toBe(true);
  press(BTN.LTRIGGER);
  provider.fail(false);
  press(BTN.CROSS);
  advance(260);
  expect(treeHasText(world.getTree(), "192/1152 cached")).toBe(true);
  expect(treeHasText(world.getTree(), "0 pending")).toBe(true);
  const glyphReads = provider.seen.filter(
    (r) => r.method === "font.glyphs",
  ).length;
  advance(80);
  expect(provider.seen.filter((r) => r.method === "font.glyphs")).toHaveLength(
    glyphReads,
  );
  press(BTN.TRIANGLE);
  advance(220);
  expect(treeHasText(world.getTree(), "20 px")).toBe(true);
  press(BTN.TRIANGLE);
  advance(260);
  expect(treeHasText(world.getTree(), "12 px")).toBe(true);
  press(BTN.CIRCLE);
  press(BTN.RTRIGGER);
  advance(60);
  expect(treeHasText(world.getTree(), "I/O PAUSED")).toBe(true);
  expect(treeHasText(world.getTree(), "2/82")).toBe(true);
  press(BTN.CIRCLE);
  press(BTN.LTRIGGER);
  press(BTN.SQUARE);
  advance(240);
  expect(treeHasText(world.getTree(), "你好世界")).toBe(true);
  expect(treeHasText(world.getTree(), "気迫")).toBe(true);
  provider.setText("気迫。変更後の外部文字。你好世界");
  press(BTN.CROSS);
  advance(260);
  expect(treeHasText(world.getTree(), "変更後")).toBe(true);
  provider.reconnect();
  advance(260);
  expect(treeHasText(world.getTree(), "LOCAL FONT")).toBe(true);
  expect(
    provider.seen.filter((r) => r.method === "font.open").length,
  ).toBeGreaterThan(2);
  expect(
    provider.seen
      .filter((r) => r.method === "font.glyphs")
      .every((r) => JSON.parse(r.payload).scalars.length <= 4),
  ).toBe(true);
}, 30000);
