// @title Pocket Text Lab
import { createMemo, createSignal, For, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { openFontArchive } from "@pocketjs/framework/fonts";
import { offload } from "@pocketjs/framework/offload";

function TextLab() {
  const [page, setPage] = createSignal(0),
    [size, setSize] = createSignal(1),
    [document, setDocument] = createSignal(false);
  const [paragraph, setParagraph] = createSignal("Loading external text..."),
    [status, setStatus] = createSignal("Opening local font archive...");
  const [cache, setCache] = createSignal(""),
    [io, setIo] = createSignal(""),
    [paused, setPaused] = createSignal(false);
  let archive: ReturnType<typeof openFontArchive> | undefined,
    frames = 0,
    started = false,
    statsPending = false;
  const readDocument = () =>
    offload("local").request("fs.read-text", "text-lab.txt", (r) =>
      setParagraph(r.ok ? r.value : r.error),
    );
  const next = (d: number) => setPage((page() + d + 82) % 82);
  onButtonPress(BTN.RTRIGGER, () => next(1));
  onButtonPress(BTN.LTRIGGER, () => next(-1));
  onButtonPress(BTN.DOWN, () => next(1));
  onButtonPress(BTN.UP, () => next(-1));
  onButtonPress(BTN.SQUARE, () => {
    setDocument(!document());
    if (document()) readDocument();
  });
  onButtonPress(BTN.TRIANGLE, () => setSize((size() + 1) % 3));
  onButtonPress(BTN.CIRCLE, () => {
    setPaused(!paused());
    archive?.pause(paused());
  });
  onButtonPress(BTN.CROSS, () => {
    archive?.reload();
    readDocument();
  });
  onCleanup(() => archive?.dispose());
  onFrame(() => {
    if (!started) {
      started = true;
      archive = openFontArchive({
        path: "fonts/cjk.pjfa",
        slots: [0, 2, 4],
        capacity: 384,
      });
      readDocument();
    }
    frames++;
    if (frames % 15 === 0 && archive) {
      const s = archive.status(),
        c = archive.stats();
      setStatus(
        s.state === "ready"
          ? s.paused
            ? "I/O PAUSED - controls remain live"
            : "LOCAL FONT - no companion"
          : s.error || "Opening local font archive...",
      );
      setCache(
        `${c.resident}/1152 cached | ${Math.round(c.bytes / 1024)} KiB | ${c.pending} pending | ${c.evictions} evicted`,
      );
      if (!statsPending && s.state === "ready") {
        statsPending = true;
        offload("local").request("font.stats", "", (r) => {
          statsPending = false;
          if (r.ok) {
            const v = JSON.parse(r.value);
            setIo(
              `${v.glyphs} reads | ${Math.round(v.bytes / 1024)} KiB I/O | ${v.frameUs ? Math.round(v.frameUs / 1000) : 0} ms/frame`,
            );
          }
        });
      }
    }
  });
  const dimensions = () =>
    size() === 0 ? [32, 10] : size() === 1 ? [24, 8] : [20, 6];
  const lines = createMemo(() => {
    const [cols, rows] = dimensions();
    if (document()) {
      const chars = Array.from(paragraph().replace(/\r/g, "")),
        out: string[] = [];
      let line = "";
      for (const c of chars) {
        if (c === "\n" || Array.from(line).length === cols) {
          out.push(line);
          line = "";
        }
        if (c !== "\n") line += c;
      }
      if (line) out.push(line);
      const start = (page() * rows) % Math.max(1, out.length);
      return out.slice(start, start + rows);
    }
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) =>
        String.fromCodePoint(0x4e00 + ((page() * 256 + r * cols + c) % 20992)),
      ).join(""),
    );
  });
  return (
    <View
      class="w-full h-full bg-slate-950 flex-col p-2 gap-[2]"
      debugName="TextLab"
    >
      <View class="flex-row justify-between items-center">
        <Text class="text-base text-white font-bold">Pocket Text Lab</Text>
        <Text class="text-xs text-cyan-300">{`${document() ? "DOCUMENT" : "UNICODE GRID"} ${page() + 1}/82 | ${[12, 16, 20][size()]} px`}</Text>
      </View>
      <Text class="text-xs text-slate-400">{status()}</Text>
      <View class="h-[172] overflow-hidden flex-col" debugName="DynamicText">
        <For each={lines()}>
          {(line) => (
            <Text
              class="text-white"
              style={{
                fontSlot: [0, 2, 4][size()],
                lineHeight: [16, 21, 27][size()],
              }}
            >
              {line}
            </Text>
          )}
        </For>
        {/* Declare each strike at build time without declaring CJK coverage. */}
        <Text class="text-xs hidden">12</Text>
        <Text class="text-base hidden">16</Text>
        <Text class="text-xl hidden">20</Text>
      </View>
      <Text class="text-xs text-cyan-300">{cache()}</Text>
      <Text class="text-xs text-slate-400">{io()}</Text>
      <Text class="text-xs text-slate-300">
        L/R page TRI size SQ doc O pause X reload
      </Text>
    </View>
  );
}
mount(() => <TextLab />);
