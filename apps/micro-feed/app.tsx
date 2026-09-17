import { createEffect, createSignal } from "solid-js";
import { View, Text } from "@pocketjs/framework/components";
import { createWindow, Window, onButtonRepeat } from "@pocketjs/framework/micro";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

export default function Feed() {
  const [category, setCategory] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  const [detail, setDetail] = createSignal(false);
  const feed = createWindow({
    method: "feed.window",
    capacity: 5,
    cacheCapacity: 256,
    pageSize: 8,
    fields: { id: "int", title: "text", topic: "text", score: "int" },
  });
  createEffect(() => { feed.filter(category()); setSelected(0); });
  onButtonRepeat(BTN.DOWN, () => {
    if (selected() < 2) setSelected(selected() + 1);
    else if (feed.more()) feed.seek(feed.offset() + 1);
    else if (selected() < feed.len() - 1) setSelected(selected() + 1);
  });
  onButtonRepeat(BTN.UP, () => {
    if (feed.offset() > 0) feed.seek(feed.offset() - 1);
    else if (selected() > 0) setSelected(selected() - 1);
  });
  onButtonRepeat(BTN.RIGHT, () => { if (feed.more()) feed.seek(feed.offset() + 5); });
  onButtonRepeat(BTN.LEFT, () => { feed.seek(feed.offset() - 5); });
  onButtonPress(BTN.TRIANGLE, () => { setCategory((category() + 1) % 3); });
  onButtonPress(BTN.CIRCLE, () => { setDetail(!detail()); });
  onButtonPress(BTN.SQUARE, () => { feed.seek(Math.min(feed.offset(), 2147473647) + 10000); });
  onButtonPress(BTN.START, () => { feed.retry(); });

  return <View class="flex-col w-full h-full bg-slate-950 p-3 gap-2">
    <View class="flex-row justify-between items-center">
      <View class="flex-col gap-1">
        <Text class="text-xs text-cyan-400 font-bold">POCKET MICRO / COMPANION</Text>
        <Text class="text-xl text-white font-bold">Field Notes</Text>
      </View>
      <View class={feed.online() ? "bg-emerald-950 px-2 py-1 rounded" : "bg-rose-950 px-2 py-1 rounded"}>
        <Text class="text-xs text-white">{feed.online() ? "CONNECTED" : "OFFLINE"}</Text>
      </View>
    </View>
    <View class="flex-row justify-between">
      <Text class="text-xs text-slate-400">{category() === 0 ? "ALL NOTES" : category() === 1 ? "ENGINEERING" : "DESIGN"} / {feed.offset() + 1}+</Text>
      <Text class="text-xs text-cyan-300">{feed.error() ? "Request failed / START retry" : `${feed.cached()} / ${feed.cacheCapacity()} cached`}</Text>
    </View>
    <View class="flex-col gap-1">
      <Window each={feed}>{(row, slot) =>
        <View class={selected() === slot ? "flex-row items-center justify-between h-6 px-2 bg-cyan-950 rounded" : "flex-row items-center justify-between h-6 px-2 bg-slate-900 rounded"}>
          <View class="flex-row items-center gap-2">
            <Text class="text-xs text-cyan-400">{feed.offset() + slot + 1}</Text>
            <Text class="text-xs text-white">{row.valid() ? row.title() : "Loading..."}</Text>
          </View>
          <Text class="text-xs text-slate-400">{row.valid() ? row.topic() : ""}</Text>
        </View>
      }</Window>
    </View>
    <View class="flex-row justify-between">
      <Text class="text-xs text-slate-400">{detail() && feed.valid(selected()) ? `Note ${feed.read(selected(), "id")} / score ${feed.read(selected(), "score")}` : "Hold UP/DOWN to scroll"}</Text>
      <Text class="text-xs text-cyan-400">{feed.prefetching() ? "Prefetching" : "Ready"}</Text>
    </View>
    <Text class="text-xs text-slate-500">TRI filter / SQ +10k / O detail / START retry</Text>
  </View>;
}
