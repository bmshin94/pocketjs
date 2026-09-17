# Cached Companion long list

`apps/micro-feed/app.tsx` compiles TSX, Tailwind classes and Micro reactivity
to Rust. Three local signals hold category, visible selection and detail
visibility. A typed capability owns a **256-record native ring cache**;
**five reusable row views** borrow its visible interval. The Companion owns
the SQLite corpus and browsing history.

The corpus materializes synthetic records on access. It has no device-side
whole-dataset array. Signed 32-bit indices bound the address space; browsing
distance and history do not increase device storage. A provider can implement
the same typed page contract with a database or a network source.

## Storage and compilation

```tsx
const feed = createWindow({
  method: "feed.window",
  capacity: 5,
  cacheCapacity: 256,
  pageSize: 8,
  fields: { id: "int", title: "text", topic: "text", score: "int" },
});
```

| State | Owner | Bound in this demo |
|---|---|---|
| category, selected slot, detail toggle | generated signal fields | three scalars |
| decoded records | native `Window<Row, 5, 256, 8>` | 256 records plus one default record for invalid reads |
| row text | native `Text<96>` | 96 UTF-8 bytes per field |
| page decoding | native typed response | eight rows per reply |
| requests | native capability | four in flight, no growing scroll queue |
| row views | generated TSX template | five slots, 40 app nodes |
| transport envelope | native bridge | 4096 wire bytes, 2500 payload bytes |
| corpus and history | Companion SQLite | grows on the Companion |
| file and USB I/O | host and Companion workers | outside the UI thread |

`capacity` is a literal from 1 to 8. `cacheCapacity` is a literal from capacity
to 1024. `pageSize` is from 1 to 8 and divides cacheCapacity. Omitted cache and
page sizes default to capacity. A conservative row-layout estimate limits
the aggregate typed cache storage to 256 KiB per app. The compiler emits the row struct, storage
bounds and schema fingerprint into Rust and the manifest. A schema has 1 to
8 fields of type `int`, `bool` or `text`; the page payload budget also applies.

`<Window each={feed}>{(row, slot) => JSX}</Window>` creates capacity slots at
mount. A row accessor borrows `offset + slot` from the ring by absolute index.
`feed.read(selected(), "title")` accepts a runtime slot and a literal field.
Missing slots return zero, false or empty text; `valid()` distinguishes them.
The demo renders **a placeholder for each missing row**, with its list position.
It does not replace the list with a loading screen.

Each capability has a dependency bit. Row changes and status changes invalidate
bindings that read that capability. Effects can connect scalar filters to
`feed.filter()`. Signals and capabilities share 64 dependency bits; there are
at most eight capabilities. Row accessors do not escape as heap closures.
The Micro app holds a handle and scalar state, not an arbitrary object graph.

## Motion and requests

**`seek` retains overlapping cached rows.** A cache hit changes the borrowed
visible interval without a request or loading state. Moving beyond resident
records reveals placeholders while input continues. The retention interval
puts about three quarters of spare capacity in the direction of motion and
one quarter behind it. Reversing motion changes that bias. Only records outside
the interval are evicted; a background reply cannot evict a visible record.

Visible misses take priority over refresh and directional prefetch. Four
requests can overlap, with at most one submission and one received envelope
per frame across the bridge. The scheduler derives work from the current
interval, so repeated input does not allocate a request queue. Replies from
the same query can fill the cache after a small seek. Replies from an old
filter or outside the retained interval are discarded. Request ID, generation,
offset, query, row types and field bounds must match before any row commits.

A page contains `offset`, `query`, `more`, `rows`, and an optional `total`.
The demo supplies total so an out-of-range seek can clamp to the last window.
With an unknown total, `more: false` supplies an upper bound from that page.
Timeout is 600 host frames. A provider error pauses fetching and preserves
cached rows; Start retries the visible page and resumes prefetch.

Disconnect retains the cached snapshot. Reconnect uses a new request generation
and refreshes the visible page while retaining resident rows. Cached offscreen
records are a snapshot until eviction, explicit refresh or filter change;
this experiment does not provide live dataset revision synchronization.
Changing the filter clears the old query's cache.

`onButtonRepeat` is a compiler-owned input binding using framework button masks.
It fires on the down edge, waits 200 ms, then repeats at 15 rows/s, 30 after
one second, and 60 after three seconds, using the 60 Hz host frame clock.
Release stops repeats. The demo anchors selection near the middle row while
scrolling. Left and Right use the same repeat mechanism with a five-row step.
Input never waits for a Companion response. Position advances in whole rows;
sub-row interpolation and variable-height rows are outside this implementation.

Remote text uses baked ASCII glyphs. Unicode needs font coverage or a text
capability. Existing scalar string signals remain Rust `String`; the demo's
local signals are numeric and boolean. Cache bounds are not a proof that every
possible Micro program has bounded string allocation.

## Run

```sh
bun run micro:test
bun micro/compiler/cli.ts build micro-feed --psp --release
mkdir -p .pocket-build/validation/micro-feed/device/host0
usbhostfs_pc -b 10000 .pocket-build/validation/micro-feed/device/host0
```

Start the Companion in another terminal:

```sh
bun micro/companion/serve.ts \
  --usb .pocket-build/validation/micro-feed/device/host0 \
  --data .pocket-build/validation/micro-feed/device/companion \
  --control .pocket-build/validation/micro-feed/device/control.json
```

Load with `micro/scripts/psplink.ts`, passing the built PRX, `--host0` and
`--expected-build` from the manifest. `--no-reset` uses a fresh PSPLINK shell.
For scripted acceptance, stop other providers for this app and enter a fresh
PSPLINK shell; the runner starts and closes its own SQLite Companion:

```sh
bun micro/compiler/cli.ts build micro-feed --psp --release \
  --receipt-every 60 --tape "$(bun micro/scripts/feed-device.ts --tape)"
bun micro/scripts/feed-device.ts \
  --host0 .pocket-build/validation/micro-feed/device/host0
```

| Input | Action |
|---|---|
| Hold Up / Down | scroll with accelerated repeat |
| Hold Left / Right | move in five-row steps |
| Square | seek forward 10000 records |
| Triangle | cycle All / Engineering / Design |
| Circle | toggle selected record details |
| Start | retry or refresh the visible page |

The optional provider control file accepts `{"delayMs":800}` or `{"error":true}`;
`{}` restores normal service. The compiler accepts `--receipt` for the first
receipt frame and `--receipt-every` for its interval (defaults 240 and 600).
Scripted validation uses 60-frame receipts to inspect slow-source behavior.
Those diagnostic receipt writes and screenshots are not part of the recorded
app-step timing.

## Validation

Rust tests cover partial visible gaps, 10000 consecutive seeks, direction
reversal, cache bounds, four-request backpressure, stale filters, out-of-order
routing, provider errors, timeout/retry, offline snapshots, reconnect, typed
decoding, finite ends and repeat acceleration/release. The desktop integration
compiles the TSX and talks to the SQLite Companion through the native I/O
worker. It holds Down, reverses Up, checks visible rows during motion and
compares node and allocation counts. No QuickJS oracle is involved.

The PSP target emits one LOAD segment. `validatePspLayout` checks every allocated
section against that mapping: the pinned `prxgen` cannot repack alignment gaps
between separate segments. This prevents the 32-byte import-table offset that
caused the earlier binary's module-load exception. PSPLINK scripts preserve
exception output through a PTY and keep USB host stdin open.

Per-run screenshots, logs, databases and receipts stay in ignored
`.pocket-build/validation/micro-feed/`. Physical acceptance requires matching
build and tape identities, captures during held input, a slow source which
exposes placeholders, and error/disconnect recovery. A desktop run or a binary
build does not establish physical PSP acceptance.

The cached-list PSP run on 2026-09-17 passed with build
`1e8a261f857ea3f9`, PRX SHA-256
`dfba7e42f9c83bfd7287acf3edab943ba86a93da41230e4511c45574564010d3`.
Its receipts and screenshots are in
`.pocket-build/validation/micro-feed/device/cached-list-warm/`.

- **256 cached records occupy 54712 bytes** of inline native state. Every
  stage retained 40 UI nodes and had zero glyph misses.
- After the initial 10000-record seek, 1584 held-input forward/reverse moves
  added no visible cache misses. At the fast sample the offset was 11032 and
  all five rows were valid.
- Allocator live class bytes were 660224 after warmup and 660384 after forward
  and reverse movement, with 167 live blocks at both points. This allocator
  count excludes the inline cache; the receipt reports cache storage separately.
  Warmup includes five-digit labels to account for draw-buffer capacity changes.
- With an 800 ms provider delay, input continued through cache gaps; the
  recorded offset advanced from 10598 to 10972 while placeholders were visible.
  After release and normal service, five rows and the 256-record cache returned.
- Error, retry, disconnect and reconnect all retained the five cached rows.
  The local category and detail signals survived the connection cycle.
- Fast-sample means were 706 microseconds for app work, 8284 for core tick,
  1903 for drawing and 396 for rendering; maximum app work was 2613 microseconds.
  Receipt wall-clock samples during held input measured about 57 frames/s,
  including diagnostic receipt and screenshot overhead. The repeat rates above
  describe the 60 Hz frame contract, not a guarantee of 60 presented frames/s.

The scripted run finished and the same build remained on the PSP with its
Companion online for physical button input. Desktop integration also passed
2750 frames, held input and reversal with no additional warm-cache misses;
its live allocation samples were 866124 and 866151 bytes. These are experiment
results for this bounded cache and UI, not a whole-program memory guarantee.
