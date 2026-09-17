# Pocket Micro

Pocket Micro compiles **Micro TS**, a statically analyzable TSX UI
orchestration layer, into Rust over `pocketjs-core`. Local signals control
interaction. **Rust-owned typed capabilities hold bounded windows** into
Companion-owned collections. The PSP binary contains no JavaScript engine.
This does not attempt to implement a GC-free TypeScript runtime or reproduce
all QuickJS/Solid semantics.

The current experiment is [Field Notes](../apps/micro-feed/app.tsx): Tailwind
classes, local selection/detail signals, reactive filtering, typed window
reads, a 256-record directional prefetch cache, per-row placeholders and
accelerated held-button scrolling over a Companion SQLite corpus.
[Experiment and commands](FEED.md). The original Hero parity fixture remains
an optional regression check for its supported subset.

```
bun micro/compiler/cli.ts check hero          # subset diagnostics + plan
bun micro/compiler/cli.ts ir hero             # the Micro IR as JSON
bun micro/compiler/cli.ts build hero          # dist/micro/hero/{app.rs,app.ir.json,hero.pak,styles.bin,manifest.json}
bun micro/compiler/cli.ts build hero --psp --release [--tape "0:0,5:64,6:0"]
                                              # + hosts/psp-micro/target/mipsel-sony-psp/release/{pocket-micro-psp.prx,EBOOT.PBP}
bun micro/tests/parity.ts hero                # byte parity against a fresh Solid oracle (wasm core)
bun micro/scripts/psplink.ts <prx> [--port 10000 --host0 <dir>]
                                              # run on a PSP over PSPLINK; collects receipt + screenshot
bun run micro:test                            # compiler, typed window, real Companion integration and Rust tests
```

Layout:

| path | role |
|---|---|
| `micro/compiler/frontend.ts` | Micro TS → Micro IR (TypeScript compiler API, file:line:column diagnostics) |
| `micro/compiler/ir.ts` | the IR: typed expressions, statements, template nodes, bindings with signal dependency sets |
| `micro/compiler/emit-rust.ts` | Micro IR → `pub mod app` against the `pocket-micro` runtime |
| `micro/compiler/assets.ts` | styles.bin, font atlases, images and sprite atlases for the IR's literals, packed as the app `.pak` |
| `micro/compiler/cli.ts` | `ir` / `check` / `build [--psp]` |
| `engine/crates/pocket-micro` | the `no_std` runtime: root layers, focus, press dispatch, flush contract, number formatting, pak feeder |
| `hosts/psp-micro` | the PSP EBOOT (lone cargo-psp crate) |
| `micro/harness` | desktop harness: generated module + core + software rasterizer, frame dumps for parity |
| `micro/tests` | compiler tests, the Solid oracle, the parity test |

Nothing generated is committed. Every artifact is a pure function of the app
sources and this compiler, so it is built on demand into ignored `dist/micro/
<app>/`. `micro/tests/feed.test.ts` compiles its output with cargo, drives the native
app against the real Companion service, and checks UI state, node reuse and
live allocations. `micro/tests/window.test.ts` and Rust window tests cover
schemas, backpressure, stale replies, reconnects and bounded storage.
`micro:parity` retains the optional Hero pixel comparison.
