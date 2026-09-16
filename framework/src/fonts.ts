import { getOps, type HostOps } from "./host.ts";
import { offload, type createOffloadClient } from "./offload.ts";
import { registerServicePump } from "./services.ts";
import {
  FONT_ARCHIVE as F,
  decodeArchiveFace,
  type ArchiveFace,
  type ArchiveStrike,
} from "../../contracts/spec/font-archive.ts";

type Client = ReturnType<typeof createOffloadClient>;
export interface FontArchiveOptions {
  /** Provider-relative path; the native worker owns the storage root. */
  path: string;
  /** Font slots already baked into this app. */
  slots: number[];
  /** Extra resident glyphs per slot, 1..1024; all slots share a 2 MiB limit. */
  capacity?: number;
  onChange?: () => void;
}
export interface FontArchiveStatus {
  state: "opening" | "ready" | "error" | "disposed";
  identity: string;
  error: string;
  requests: number;
  loaded: number;
  paused: boolean;
}
const config = (s: ArchiveStrike, generation: number, capacity: number) => {
  const b = new Uint8Array(20),
    v = new DataView(b.buffer);
  v.setUint32(0, F.configMagic, true);
  v.setUint32(4, generation, true);
  b.set(
    [s.slot, s.width, s.height, s.baseline, s.lineHeight, s.advance, s.density],
    8,
  );
  v.setUint16(16, capacity, true);
  return b;
};
function decodeHex(s: string): Uint8Array {
  if (
    s.length < 24 ||
    s.length > 2500 ||
    s.length % 2 ||
    !/^[0-9a-f]+$/.test(s)
  )
    throw new Error("Invalid font reply");
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++)
    b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return b;
}
/** Framework-neutral scheduler. The host paints ordinary Text and records
 * visible misses; only this service submits disk work through io.offload. */
export function createFontArchive(
  options: FontArchiveOptions,
  host: HostOps,
  client: Client,
) {
  if (
    !host.fontStreamConfigure ||
    !host.fontStreamCommit ||
    !host.fontStreamRequests ||
    !host.fontStreamStats
  )
    throw new Error("Host does not implement text.glyphs.streamed");
  const capacity = options.capacity ?? 384,
    slots = [...new Set(options.slots)];
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > F.maxResidentEntries ||
    !slots.length ||
    slots.some((s) => !Number.isInteger(s) || s < 0 || s >= 24)
  )
    throw new Error("Invalid font residency configuration");
  if (
    !/^[a-zA-Z0-9_./-]{1,127}$/.test(options.path) ||
    options.path.includes("..") ||
    options.path.startsWith("/")
  )
    throw new Error("Invalid font path");
  const status: FontArchiveStatus = {
    state: "opening",
    identity: "",
    error: "",
    requests: 0,
    loaded: 0,
    paused: false,
  };
  const pending = new Set<number>(),
    inflight = new Set<string>(),
    retry = new Map<string, number>();
  let face: ArchiveFace | undefined,
    configured: ArchiveStrike[] = [],
    frame = 0,
    nextOpen = 0,
    serial = 0,
    opening = false,
    session = client.session(),
    lastSlot = -1;
  const changed = () => options.onChange?.();
  const detach = () => {
    for (const s of configured) host.fontStreamConfigure!(config(s, 0, 0));
    configured = [];
  };
  const reset = () => {
    serial++;
    for (const id of pending) client.cancel(id);
    pending.clear();
    inflight.clear();
    retry.clear();
    opening = false;
    face = undefined;
    detach();
    status.state = "opening";
    status.error = "";
    nextOpen = frame;
    changed();
  };
  const fail = (message: string) => {
    status.state = "error";
    status.error = message;
    nextOpen = frame + 120;
    changed();
  };
  const open = () => {
    opening = true;
    const token = serial;
    const id = client.request("font.open", options.path, (result) => {
      pending.delete(id);
      if (token !== serial) return;
      opening = false;
      if (!result.ok) {
        fail(result.error);
        return;
      }
      try {
        const value = decodeArchiveFace(result.value);
        for (const slot of slots) {
          const s = value.strikes.find((s) => s.slot === slot);
          if (
            !s ||
            ![
              s.width,
              s.height,
              s.baseline,
              s.lineHeight,
              s.advance,
              s.density,
            ].every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ||
            !host.fontStreamConfigure!(config(s, value.generation, capacity))
          )
            throw new Error(
              `Font slot ${slot} incompatible or exceeds residency budget`,
            );
          configured.push(s);
        }
        face = value;
        status.state = "ready";
        status.identity = value.identity;
        status.error = "";
        changed();
      } catch (e) {
        detach();
        fail(String(e));
      }
    });
    if (id) {
      pending.add(id);
      status.requests++;
    } else {
      opening = false;
      nextOpen = frame + 1;
    }
  };
  const step = () => {
    if (status.state === "disposed") return;
    frame++;
    const current = client.session();
    if (current !== session) {
      session = current;
      reset();
    }
    if (!face) {
      if (current > 0 && !opening && frame >= nextOpen) open();
      return;
    }
    if (status.paused || pending.size >= 2) return;
    const requests = JSON.parse(host.fontStreamRequests!()) as number[][];
    const ready = requests.filter(
      ([g, s, cp]) =>
        g === face!.generation &&
        slots.includes(s) &&
        !inflight.has(`${s}:${cp}`) &&
        (retry.get(`${s}:${cp}`) ?? 0) <= frame,
    );
    if (!ready.length) return;
    const slot =
        [...new Set(ready.map((r) => r[1]))]
          .sort((a, b) => a - b)
          .find((s) => s > lastSlot) ?? ready[0][1],
      strike = face.strikes.find((s) => s.slot === slot)!;
    lastSlot = slot;
    const batchSize = Math.min(
      4,
      Math.floor(
        (1250 - 12) / (8 + Math.ceil((strike.width * strike.height) / 4)),
      ),
    );
    const scalars = ready
      .filter((r) => r[1] === slot)
      .slice(0, batchSize)
      .map((r) => r[2]);
    const keys = scalars.map((cp) => `${slot}:${cp}`),
      token = serial;
    const id = client.request(
      "font.glyphs",
      JSON.stringify({ generation: face.generation, slot, scalars }),
      (result) => {
        pending.delete(id);
        if (token !== serial) return;
        keys.forEach((k) => inflight.delete(k));
        let delay = 30;
        if (result.ok) {
          try {
            status.loaded += host.fontStreamCommit!(decodeHex(result.value));
            status.error = "";
          } catch (e) {
            status.error = String(e);
            delay = 60;
          }
        } else {
          status.error = result.error;
          delay = 60;
        }
        // A full pinned cache must not keep fetching the same rejected misses.
        keys.forEach((k) => retry.set(k, frame + delay));
        if (retry.size > 2048) retry.clear();
        changed();
      },
    );
    if (id) {
      pending.add(id);
      keys.forEach((k) => inflight.add(k));
      status.requests++;
    }
  };
  const unregister = registerServicePump(step);
  return {
    status: () => ({ ...status }),
    stats: () =>
      JSON.parse(host.fontStreamStats!()) as {
        resident: number;
        bytes: number;
        pending: number;
        evictions: number;
        rejected: number;
        unsupported: number;
      },
    pause(value: boolean) {
      status.paused = value;
      changed();
    },
    reload() {
      if (status.state !== "disposed") reset();
    },
    dispose() {
      if (status.state === "disposed") return;
      reset();
      unregister();
      client.request("font.close", "", () => {});
      status.state = "disposed";
      changed();
    },
  };
}
let active: ReturnType<typeof createFontArchive> | undefined;
/** One archive controller owns the realm's streamed font slots. Its provider
 * and resident cache are independent from a paired companion connection. */
export function openFontArchive(options: FontArchiveOptions) {
  if (active && active.status().state !== "disposed")
    throw new Error("A font archive is already open");
  return (active = createFontArchive(options, getOps(), offload("local")));
}
