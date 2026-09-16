# Dynamic text and local font archives

**Ordinary `<Text>` accepts Unicode strings produced at runtime.** A filename,
metadata field or paragraph uses the selected font slot. Packaged glyphs render
without a provider. An app that declares `text.glyphs.streamed` can extend those
slots from an external font archive through **`io.offload`**.

## Load an external font

```ts
import { openFontArchive } from '@pocketjs/framework/fonts';

// Call after the host and packaged font slots are installed.
const font = openFontArchive({
  path: 'fonts/cjk.pjfa',
  slots: [0, 2, 4], // regular 12, 16, 20 px
  capacity: 384,   // additional resident glyphs per slot
});
// Existing <Text>{filename}</Text> components need no replacement.
// Release on application disposal:
// font.dispose();
```

The app manifest requires `text.glyphs.baked`, `text.glyphs.streamed` and
`io.offload`. **The PSP grants the streamed capability.** Other hosts retain
baked text and their existing native or companion text paths. WASM exposes the
core operations for injected-provider tests; this does not grant the capability
to a stock browser, Vita or 3DS host.

`offload('local')` selects a device worker with its own session and credits.
`offload()` retains the paired companion provider. Each provider copies bounded
requests and replies at frame boundaries. Local font access needs no network
connection or pairing key. On PSP, paths are relative to
`ms0:/PSP/COMMON/pocketjs/`; absolute paths and parent traversal are rejected.

The worker owns file open, seek, read, glyph checksums and **eight 4 KiB index
cache pages**. Binary search locates a Unicode scalar without retaining the
complete cmap. A response carries at most four packed glyph cells and fits the
4096-byte offload record / 2500-character payload limits. The worker uses fixed
buffers and a 256 KiB stack; it does not call QuickJS, the UI core, GE or the
single-thread allocator.

**Only glyphs that survive viewport and clip rejection create demand.** The
framework schedules at most two pending glyph batches and consumes at most one
reply per frame. Additional resident glyph cells are capped at 2 MiB across streamed slots, with
at most 1024 extra glyphs per slot. The byte counter reports these reserved cells;
packaged glyphs and their padding use separate storage. Resident glyphs painted in the last frame
remain pinned. New pages replace unused glyphs by last use; a full pinned cache
rejects an insertion and preserves the characters already on screen. An
unsupported scalar uses the missing-glyph cell and a bounded negative cache.

`status()` reports readiness, errors and accepted loads; `stats()` reports
resident source bytes, pending demand and evictions. `pause(true)` stops new
glyph requests while input and painting continue. `reload()` discards the
streamed cells and reopens the archive. Failed reads retry after a bounded
frame delay. Reconnection reopens the source; generation checks reject old
replies. `dispose()` detaches the slots and closes the worker's archive.

**One archive controller owns the streamed slots in a realm.** Each strike must
match the slot's baseline, line height and density. PJFA/1 currently supports
density 1 and fixed scalar metrics. Baked glyphs keep their local path and
metrics. A loaded glyph's advance participates in the same core measurement
and layout as its pixels. Before loading, an absent glyph uses the strike's
nominal advance, so proportional text can reflow when metrics arrive.

## Build and install the archive

```sh
bun tools/font-archive.ts --font=MyFont.otf --out=cjk.pjfa --slots=0,2,4
```

The builder uses the source font's complete mapped character set, with Inter
for the packaged slot metrics and Latin coverage. **PJFA/1 is external storage,
not an embedded PAK asset.** It contains a SHA-256 content identity, strike
metadata, a sorted scalar index, per-cell FNV checksums and 2-bit coverage.
Checksums detect damaged glyph cells; they are not a signature or a trust
boundary. The reader validates lengths, bounds and strike geometry before use.

The archive stores pre-rasterized strikes. It does not parse OpenType outlines
on PSP. It does not add shaping, bidi, grapheme navigation, Unicode line breaking
or language-specific Han variant selection. Those remain separate text-layout
capabilities, including the [companion text service](TEXT_RESOURCES.md).

## Text Lab acceptance

```sh
bun tools/text-lab-assets.ts .pocket-build/text-lab
bun tools/pocket.ts build --target psp --manifest apps/text-cjk/pocket.json --project-root . -- --release
```

Copy `fonts/` and `text-lab.txt` from the asset output directory to
`ms0:/PSP/COMMON/pocketjs/`. The pinned Noto source and license are described in
`assets/fonts/NotoSansCJK-Demo.md`. The full archive has 44,811 mapped entries per
strike, for 12, 16 and 20 px, and occupies 28,410,334 bytes. The app's PAK contains
its interface glyphs; the generated CJK grid and external document are absent.

`apps/text-cjk/main.tsx` uses ordinary `<Text>` throughout. L/R or Up/Down moves
through 82 pages of Unicode scalars. Triangle cycles sizes: 320, 192 or 120
characters per grid. Square opens the external UTF-8 document, Circle pauses
font requests, and Cross reloads the font and document. The local text-read
capability limits the external document to 1536 bytes.

Acceptance exercises:

1. Start without a paired companion. Wait for zero pending glyphs.
2. Browse enough pages to exceed 384 resident glyphs in one slot. Return to the
   first page and compare glyph identity and baseline placement.
3. Cycle all three sizes, including 320 distinct characters on one screen.
4. Pause loading, change pages and verify that controls still respond. Resume
   and wait for the remaining glyphs.
5. Edit the external document after building the EBOOT; reload and verify the
   new Chinese/Japanese text without rebuilding.
6. Move the archive aside, reload, then restore it. The interface remains usable
   during failure and loads glyphs after recovery.

`tests/text-cjk.test.ts` drives the built app and WASM core through an injected
provider. Core tests cover clipping, visible residency, stale replies, negative
caching, corrupt cells and bounded archive reads. Run:

```sh
bun tools/wasm.ts
bun test tests/font-config.test.ts tests/text-cjk.test.ts
cargo test --locked --manifest-path engine/core/Cargo.toml
```

The PSP `devtools-offload` Cargo feature enables the mailbox for scripted device
validation. **Mailbox polling performs main-thread host0 I/O.** It is disabled
in production offload builds; measure performance on a normal build. Keep
captures and per-run logs under `.pocket-build/validation/`.

## Packaged coverage and GPU residency

Small fixed character sets can still use `fonts.json` beside the app entry:

```json
{
  "fallback": ["fonts/MyCjkFont.otf"],
  "characters": "你好気迫",
  "characterFiles": ["labels.txt"],
  "ranges": ["U+3040-30FF"]
}
```

Paths are relative to this file. The build tracks character files and font
files as dependencies. Character files have a 4 MiB limit; the declared set has
a 65,534-scalar limit before the atlas adds ASCII and its missing-glyph cell.
The final atlas enforces its own glyph-count limit. Declaring a character does
not add an outline absent from the source font.

The PSP GE renderer materializes **at most sixteen 64×128 ABGR4444 pages**, with
at most 256 KiB of pixels. Page keys contain slot, atlas revision and glyph
range. The GPU cell width excludes transparent right-hand archive padding, while the source row stride and text advances stay fixed.
An accepted streamed batch changes the revision. A page referenced by
queued GE commands stays immutable until `sceGuSync`; retired pages use LRU
replacement. If every page is pinned, the renderer paints from CPU source
coverage. That preserves glyph identity but can increase frame cost.

## PSPMAN integration boundary

[PSPMAN's public issues](https://github.com/obsoletesony/PSPMAN-Issues) report
damaged Han glyphs and partial rendering of `気迫`. This framework now supplies
an external archive, bounded source residency and ordinary `<Text>` integration
that PSPMAN can adopt instead of maintaining its own glyph-loading path.
PJFA/1 is distinct from PSPMAN's PJPF/1; an existing archive needs rebuilding or
an adapter. Updating the PocketJS dependency alone does not switch that path.

Tests here establish glyph identity under cache pressure and dynamic CJK
coverage. They do not establish the cause of a defect in PSPMAN's private source,
repair directory scanning, or validate duplicate-row behavior. Closing the
reported issues requires an integration and reproduction in PSPMAN itself.
