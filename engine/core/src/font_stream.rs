//! Bounded on-demand glyph cells for ordinary baked Text. Disk work belongs to
//! io.offload; this module only plans visible demand and applies bounded replies.
use crate::{
    text::{Atlas, CmapEntry},
    Ui,
};
use alloc::{format, string::String, vec, vec::Vec};
use core::cell::{Cell, RefCell};

pub const CONFIG_MAGIC: u32 = 0x31534650; // PFS1
pub const GLYPH_MAGIC: u32 = 0x31474650; // PFG1
pub const MAX_ENTRIES: usize = 1024;
pub const MAX_PIXELS: usize = 4096;
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BATCH: usize = 4;
const MAX_VISIBLE_MISSES: usize = 2048;

pub(crate) struct Entry {
    cp: u32,
    seen: Cell<u64>,
    ink_width: u32,
}
struct Waiting {
    cp: u32,
    since: u64,
    seen: u64,
}
pub(crate) struct Stream {
    pub generation: u32,
    base: u16,
    base_texture_width: u32,
    entries: Vec<Entry>,
    wanted: RefCell<Vec<u32>>,
    absent: Vec<u32>,
    epoch: Cell<u64>,
    frame: Cell<u64>,
    block_ticks: u64,
    waiting: RefCell<Vec<Waiting>>,
    request_cursor: Cell<usize>,
    width: usize,
    height: usize,
    pub advance: u8,
    evictions: u64,
    rejected: u64,
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn scalar(cp: u32) -> bool {
    cp >= 32 && cp <= 0x10ffff && !(0xd800..=0xdfff).contains(&cp)
}

impl Atlas {
    pub(crate) fn stream_begin(&self, frame: u64) {
        if let Some(s) = &self.stream {
            s.waiting.borrow_mut().retain(|w| w.seen >= s.epoch.get());
            s.epoch.set(s.epoch.get().saturating_add(1));
            s.frame.set(frame);
            s.wanted.borrow_mut().clear();
        }
    }
    /// Records visible demand even while a pending glyph's ink is hidden.
    /// Returns whether to paint the glyph; layout and advances are unchanged.
    pub(crate) fn stream_visible(&self, cp: u32, gid: u16) -> bool {
        let Some(s) = &self.stream else { return true };
        if gid >= s.base && (gid - s.base) < s.entries.len() as u16 {
            s.entries[(gid - s.base) as usize].seen.set(s.epoch.get());
        } else if gid == 0 && scalar(cp) && self.lookup(cp).is_none() && !s.absent.contains(&cp) {
            let mut wanted = s.wanted.borrow_mut();
            if wanted.len() < MAX_VISIBLE_MISSES && !wanted.contains(&cp) {
                wanted.push(cp);
            }
            if s.block_ticks > 0 {
                let mut waiting = s.waiting.borrow_mut();
                if let Some(w) = waiting.iter_mut().find(|w| w.cp == cp) {
                    w.seen = s.epoch.get();
                    return s.frame.get().saturating_sub(w.since) >= s.block_ticks;
                }
                if waiting.len() < MAX_VISIBLE_MISSES {
                    waiting.push(Waiting {
                        cp,
                        since: s.frame.get(),
                        seen: s.epoch.get(),
                    });
                    return false;
                }
            }
        }
        true
    }
    fn stream_bytes(&self) -> usize {
        self.stream.as_ref().map_or(0, |s| {
            s.entries.len() * self.coverage_width() as usize * self.coverage_height() as usize
        })
    }

    fn stream_configure(&mut self, b: &[u8], tick_rate: u32) -> bool {
        let generation = u32_at(b, 4).unwrap();
        let base = self.stream.as_ref().map_or(self.glyph_count, |s| s.base);
        let base_texture_width = self
            .stream
            .as_ref()
            .map_or(self.texture_cell_w, |s| s.base_texture_width);
        let capacity = u16::from_le_bytes([b[16], b[17]]) as usize;
        if generation == 0 && capacity == 0 {
            self.texture_cell_w = base_texture_width;
            self.stream = None;
            self.glyph_count = base;
            self.cmap.retain(|e| e.gid < base);
            self.bitmap.truncate(
                base as usize * self.coverage_width() as usize * self.coverage_height() as usize,
            );
            return true;
        }
        let (w, h) = (b[9] as usize, b[10] as usize);
        if generation == 0
            || capacity == 0
            || capacity > MAX_ENTRIES
            || base as usize + capacity > u16::MAX as usize
            || w == 0
            || h == 0
            || w * h > MAX_PIXELS
            || b[11] as u32 != self.baseline
            || b[12] as u32 != self.line_height
            || b[14] != self.raster_density
            || b[14] != 1
            || b[13] == 0
        {
            return false;
        }
        let old_w = self.cell_w as usize;
        let old_h = self.cell_h as usize;
        let cw = w.max(old_w);
        let ch = h.max(old_h);
        if cw * ch > MAX_PIXELS {
            return false;
        }
        let mut pixels = vec![0; (base as usize + capacity) * cw * ch];
        for g in 0..base as usize {
            for y in 0..old_h {
                pixels[g * cw * ch + y * cw..g * cw * ch + y * cw + old_w].copy_from_slice(
                    &self.bitmap
                        [g * old_w * old_h + y * old_w..g * old_w * old_h + (y + 1) * old_w],
                );
            }
        }
        self.bitmap = pixels;
        self.cell_w = cw as u32;
        self.cell_h = ch as u32;
        self.glyph_count = base + capacity as u16;
        self.cmap.retain(|e| e.gid < base);
        self.cmap.reserve(capacity);
        self.texture_cell_w = base_texture_width;
        self.stream = Some(Stream {
            generation,
            base,
            base_texture_width,
            entries: (0..capacity)
                .map(|_| Entry {
                    cp: u32::MAX,
                    seen: Cell::new(0),
                    ink_width: 0,
                })
                .collect(),
            wanted: RefCell::new(Vec::with_capacity(MAX_VISIBLE_MISSES)),
            absent: Vec::with_capacity(capacity),
            epoch: Cell::new(1),
            frame: Cell::new(0),
            block_ticks: (u16::from_le_bytes([b[18], b[19]]) as u64 * tick_rate as u64)
                .div_ceil(1000),
            waiting: RefCell::new(Vec::new()),
            request_cursor: Cell::new(0),
            width: w,
            height: h,
            advance: b[13],
            evictions: 0,
            rejected: 0,
        });
        true
    }
    fn stream_commit(&mut self, b: &[u8]) -> usize {
        let Some(s) = self.stream.as_mut() else {
            return 0;
        };
        let n = b[9] as usize;
        let cell = s.width * s.height;
        let packed = cell.div_ceil(4);
        if u32_at(b, 4) != Some(s.generation)
            || n == 0
            || n > MAX_BATCH
            || b[10] as usize != s.width
            || b[11] as usize != s.height
            || b.len() != 12 + n * (8 + packed)
        {
            return 0;
        }
        // Validate the entire batch before changing the atlas.
        for i in 0..n {
            let at = 12 + i * (8 + packed);
            if !scalar(u32_at(b, at).unwrap())
                || b[at + 6] > 1
                || b[at + 7] != 0
                || b[at + 5] as usize > s.width
            {
                return 0;
            }
        }
        let mut changed = 0;
        for i in 0..n {
            let at = 12 + i * (8 + packed);
            let cp = u32_at(b, at).unwrap();
            if !s.wanted.borrow().contains(&cp)
                || self.cmap.binary_search_by_key(&cp, |e| e.codepoint).is_ok()
            {
                continue;
            }
            if b[at + 6] == 0 {
                if !s.absent.contains(&cp) {
                    if s.absent.len() == s.entries.len() {
                        s.absent.remove(0);
                    }
                    s.absent.push(cp);
                }
                continue;
            }
            let candidate = s.entries.iter().position(|e| e.cp == u32::MAX).or_else(|| {
                s.entries
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| e.seen.get() < s.epoch.get())
                    .min_by_key(|(_, e)| e.seen.get())
                    .map(|(i, _)| i)
            });
            let Some(index) = candidate else {
                s.rejected += 1;
                continue;
            };
            let entry = &mut s.entries[index];
            if entry.cp != u32::MAX {
                let old = entry.cp;
                self.cmap.retain(|e| e.codepoint != old);
                s.evictions += 1;
            }
            entry.cp = cp;
            entry.seen.set(s.epoch.get());
            let gid = s.base + index as u16;
            let dest_cell = (self.cell_w * self.cell_h) as usize;
            let dest = &mut self.bitmap[gid as usize * dest_cell..(gid as usize + 1) * dest_cell];
            dest.fill(0);
            entry.ink_width = 0;
            for p in 0..cell {
                let alpha = ((b[at + 8 + p / 4] >> (6 - 2 * (p % 4))) & 3) * 85;
                dest[p / s.width * self.cell_w as usize + p % s.width] = alpha;
                if alpha != 0 {
                    entry.ink_width = entry.ink_width.max((p % s.width + 1) as u32);
                }
            }
            let point = self
                .cmap
                .binary_search_by_key(&cp, |e| e.codepoint)
                .unwrap_err();
            self.cmap.insert(
                point,
                CmapEntry {
                    codepoint: cp,
                    gid,
                    advance: b[at + 4],
                    xoff: b[at + 5],
                },
            );
            changed += 1;
        }
        self.texture_cell_w = s
            .entries
            .iter()
            .map(|e| e.ink_width)
            .max()
            .unwrap_or(0)
            .max(s.base_texture_width);
        changed
    }
}

impl crate::text::Fonts {
    pub(crate) fn stream_begin(&self, frame: u64) {
        for slot in 0..crate::spec::MAX_FONT_SLOTS {
            if let Some(a) = self.atlas(slot as u8) {
                a.stream_begin(frame);
            }
        }
    }
}
impl Ui {
    /// PFS1 descriptor, fixed 20 bytes. Generation zero/capacity zero detaches.
    pub fn font_stream_configure(&mut self, b: &[u8]) -> bool {
        if b.len() != 20
            || u32_at(b, 0) != Some(CONFIG_MAGIC)
            || b[8] as usize >= crate::spec::MAX_FONT_SLOTS
            || b[15] != 0
            || u16::from_le_bytes([b[18], b[19]]) > 3000
        {
            return false;
        }
        let slot = b[8];
        let Some(a) = self.fonts.atlas(slot) else {
            return false;
        };
        let capacity = u16::from_le_bytes([b[16], b[17]]) as usize;
        let other: usize = (0..crate::spec::MAX_FONT_SLOTS)
            .filter(|i| *i != slot as usize)
            .filter_map(|i| self.fonts.atlas(i as u8))
            .map(Atlas::stream_bytes)
            .sum();
        if other + capacity * (a.cell_w.max(b[9] as u32) * a.cell_h.max(b[10] as u32)) as usize
            > MAX_BYTES
        {
            return false;
        }
        let tick_rate = self.tick_rate();
        let ok = self
            .fonts
            .atlas_mut(slot)
            .unwrap()
            .stream_configure(b, tick_rate);
        if ok {
            self.font_revisions[slot as usize] = self.font_revisions[slot as usize].wrapping_add(1);
            self.mark_layout_dirty();
            self.bump_raster_revision();
        }
        ok
    }
    /// Visible misses only. The scheduler owns duplicate/in-flight filtering.
    pub fn font_stream_requests(&self) -> String {
        use core::fmt::Write;
        let mut out = String::from("[");
        let mut count = 0;
        let mut starts = [0; crate::spec::MAX_FONT_SLOTS];
        let mut visited = [0; crate::spec::MAX_FONT_SLOTS];
        for slot in 0..crate::spec::MAX_FONT_SLOTS {
            if let Some(s) = self.fonts.atlas(slot as u8).and_then(|a| a.stream.as_ref()) {
                starts[slot] = s.request_cursor.get();
            }
        }
        loop {
            let mut progress = false;
            for slot in 0..crate::spec::MAX_FONT_SLOTS {
                if count == 32 {
                    break;
                }
                let Some(a) = self.fonts.atlas(slot as u8) else {
                    continue;
                };
                let Some(s) = &a.stream else { continue };
                let wanted = s.wanted.borrow();
                while visited[slot] < wanted.len() {
                    let cp = wanted[(starts[slot] + visited[slot]) % wanted.len()];
                    visited[slot] += 1;
                    s.request_cursor
                        .set((starts[slot] + visited[slot]) % wanted.len());
                    if a.lookup(cp).is_some() || s.absent.contains(&cp) {
                        continue;
                    }
                    if count > 0 {
                        out.push(',');
                    }
                    let _ = write!(out, "[{},{},{}]", s.generation, slot, cp);
                    count += 1;
                    progress = true;
                    break;
                }
            }
            if count == 32 || !progress {
                break;
            }
        }
        out.push(']');
        out
    }
    /// PFG1 batch: at most four glyphs; no filesystem or GPU calls.
    pub fn font_stream_commit(&mut self, b: &[u8]) -> usize {
        if b.len() < 12 || b.len() > 1250 || u32_at(b, 0) != Some(GLYPH_MAGIC) {
            return 0;
        }
        let slot = b[8];
        let Some(a) = self.fonts.atlas_mut(slot) else {
            return 0;
        };
        let n = a.stream_commit(b);
        if n > 0 {
            self.font_revisions[slot as usize] = self.font_revisions[slot as usize].wrapping_add(1);
            self.mark_layout_dirty();
            self.bump_raster_revision();
        }
        n
    }
    pub fn font_stream_stats(&self) -> String {
        let (mut resident, mut bytes, mut pending, mut evictions, mut rejected, mut absent) =
            (0, 0, 0, 0, 0, 0);
        for slot in 0..crate::spec::MAX_FONT_SLOTS {
            if let Some(a) = self.fonts.atlas(slot as u8) {
                if let Some(s) = &a.stream {
                    resident += s.entries.iter().filter(|e| e.cp != u32::MAX).count();
                    bytes += a.stream_bytes();
                    pending += s
                        .wanted
                        .borrow()
                        .iter()
                        .filter(|cp| a.lookup(**cp).is_none() && !s.absent.contains(cp))
                        .count();
                    evictions += s.evictions;
                    rejected += s.rejected;
                    absent += s.absent.len();
                }
            }
        }
        format!("{{\"resident\":{},\"bytes\":{},\"pending\":{},\"evictions\":{},\"rejected\":{},\"unsupported\":{}}}",resident,bytes,pending,evictions,rejected,absent)
    }
}
