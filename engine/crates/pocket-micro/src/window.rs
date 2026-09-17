//! Typed Companion windows. The device owns N rows, one pending request and
//! scalar control state. No collection grows with the remote dataset.
use alloc::string::String;
use core::{fmt, marker::PhantomData};
use serde::{
    de::{self, DeserializeOwned, SeqAccess, Visitor},
    Deserialize, Deserializer,
};

pub const RECORD_BYTES: usize = 4096;
pub const PAYLOAD_BYTES: usize = 2500;
pub const TIMEOUT_FRAMES: u64 = 600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Text<const N: usize> {
    bytes: [u8; N],
    len: usize,
}
impl<const N: usize> Default for Text<N> {
    fn default() -> Self {
        Self {
            bytes: [0; N],
            len: 0,
        }
    }
}
impl<const N: usize> Text<N> {
    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len]).unwrap()
    }
}
impl<'de, const N: usize> Deserialize<'de> for Text<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<const N: usize>;
        impl<'de, const N: usize> Visitor<'de> for V<N> {
            type Value = Text<N>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "text of at most {N} UTF-8 bytes")
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Self::Value, E> {
                if s.len() > N {
                    return Err(E::custom("text budget exceeded"));
                }
                let mut out = Text::default();
                out.bytes[..s.len()].copy_from_slice(s.as_bytes());
                out.len = s.len();
                Ok(out)
            }
        }
        d.deserialize_str(V::<N>)
    }
}

/// Deserialization stops at N rows, before constructing an extra row.
#[derive(Debug)]
pub struct Rows<R, const N: usize> {
    pub values: [R; N],
    pub len: usize,
}
impl<R: Default, const N: usize> Default for Rows<R, N> {
    fn default() -> Self {
        Self {
            values: core::array::from_fn(|_| R::default()),
            len: 0,
        }
    }
}
impl<'de, R: Deserialize<'de> + Default, const N: usize> Deserialize<'de> for Rows<R, N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<R, const N: usize>(PhantomData<R>);
        impl<'de, R: Deserialize<'de> + Default, const N: usize> Visitor<'de> for V<R, N> {
            type Value = Rows<R, N>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "at most {N} rows")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut out = Rows::default();
                for i in 0..N {
                    match seq.next_element()? {
                        Some(row) => {
                            out.values[i] = row;
                            out.len += 1;
                        }
                        None => return Ok(out),
                    }
                }
                // A visitor which rejects the existence of an additional element.
                #[derive(Deserialize)]
                enum NoExtra {}
                let _: Option<NoExtra> = seq.next_element()?;
                Ok(out)
            }
        }
        d.deserialize_seq(V::<R, N>(PhantomData))
    }
}
#[derive(Deserialize)]
#[serde(
    deny_unknown_fields,
    bound(deserialize = "R: Deserialize<'de> + Default")
)]
struct Page<R, const N: usize> {
    offset: i32,
    query: i32,
    more: bool,
    total: Option<i32>,
    rows: Rows<R, N>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    id: u32,
    payload: Option<Text<PAYLOAD_BYTES>>,
    error: Option<Text<160>>,
}

/// Host hooks exchange bounded records only. PSP hooks call the existing
/// nonwaiting USB mailbox; its worker owns file IO.
#[derive(Clone, Copy)]
pub struct Transport {
    pub session: fn() -> i32,
    pub submit: fn(&str) -> bool,
    pub take: fn() -> Option<String>,
}
pub struct Bridge {
    transport: Transport,
    reply: Option<Reply>,
    session: i32,
    frame: u64,
    next_id: u32,
    submitted: bool,
}
impl Default for Bridge {
    fn default() -> Self {
        Self::new(Transport {
            session: || 0,
            submit: |_| false,
            take: || None,
        })
    }
}
impl Bridge {
    pub fn new(transport: Transport) -> Self {
        Self {
            transport,
            reply: None,
            session: 0,
            frame: 0,
            next_id: 1,
            submitted: false,
        }
    }
    pub fn begin_frame(&mut self) {
        self.frame += 1;
        self.submitted = false;
        self.session = (self.transport.session)().max(0);
        self.reply = (self.transport.take)()
            .filter(|s| s.len() <= RECORD_BYTES)
            .and_then(|s| serde_json::from_str(&s).ok());
    }
    fn send(
        &mut self,
        method: &str,
        schema: &str,
        offset: i32,
        query: i32,
        limit: usize,
    ) -> Option<u32> {
        if self.session == 0 || self.submitted || self.next_id > i32::MAX as u32 {
            return None;
        }
        let id = self.next_id;
        // method/schema are compiler-validated ASCII identifiers/hashes.
        let request = alloc::format!("{{\"v\":1,\"id\":{id},\"method\":\"{method}\",\"payload\":\"{{\\\"schema\\\":\\\"{schema}\\\",\\\"offset\\\":{offset},\\\"query\\\":{query},\\\"limit\\\":{limit}}}\"}}");
        if !(self.transport.submit)(&request) {
            return None;
        }
        self.next_id += 1;
        self.submitted = true;
        Some(id)
    }
}
#[derive(Clone, Copy)]
struct Pending {
    id: u32,
    version: u64,
    frame: u64,
    offset: i32,
    query: i32,
}
/// Fixed ring cache keyed by absolute record index. N visible slots never own
/// rows: each read borrows the cache entry for offset + slot. P bounds decoding
/// and C bounds storage independently of distance travelled.
pub struct Window<R, const N: usize, const C: usize = N, const P: usize = N> {
    rows: [R; C],
    indices: [i32; C],
    empty: R,
    method: &'static str,
    schema: &'static str,
    offset: i32,
    query: i32,
    end: i32,
    direction: i32,
    session: i32,
    version: u64,
    pending: [Option<Pending>; 4],
    refresh: Option<i32>,
    failed: bool,
    dirty: bool,
    received: i32,
    discarded: i32,
    seeks: i32,
    misses: i32,
}
impl<R: DeserializeOwned + Default, const N: usize, const C: usize, const P: usize>
    Window<R, N, C, P>
{
    pub fn new(method: &'static str, schema: &'static str) -> Self {
        assert!(N > 0 && N <= 8 && C >= N && C <= 1024 && P > 0 && P <= 8 && C % P == 0);
        Self {
            rows: core::array::from_fn(|_| R::default()),
            indices: [-1; C],
            empty: R::default(),
            method,
            schema,
            offset: 0,
            query: 0,
            end: i32::MAX,
            direction: 1,
            session: 0,
            version: 0,
            pending: [None; 4],
            refresh: None,
            failed: false,
            dirty: true,
            received: 0,
            discarded: 0,
            seeks: 0,
            misses: 0,
        }
    }
    fn has(&self, index: i32) -> bool {
        index >= 0 && index < self.end && self.indices[index as usize % C] == index
    }
    pub fn row(&self, slot: i32) -> &R {
        if self.valid(slot) {
            &self.rows[(self.offset + slot) as usize % C]
        } else {
            &self.empty
        }
    }
    pub fn valid(&self, slot: i32) -> bool {
        slot >= 0 && slot < N as i32 && self.has(self.offset + slot)
    }
    pub fn offset(&self) -> i32 {
        self.offset
    }
    pub fn query(&self) -> i32 {
        self.query
    }
    pub fn len(&self) -> i32 {
        (0..N as i32).filter(|&i| self.valid(i)).count() as i32
    }
    pub fn loading(&self) -> bool {
        self.online() && !self.failed && self.len() < (self.end - self.offset).clamp(0, N as i32)
    }
    pub fn online(&self) -> bool {
        self.session > 0
    }
    pub fn error(&self) -> bool {
        self.failed
    }
    pub fn more(&self) -> bool {
        self.offset + (N as i32) < self.end
    }
    pub fn received(&self) -> i32 {
        self.received
    }
    pub fn discarded(&self) -> i32 {
        self.discarded
    }
    pub fn capacity(&self) -> i32 {
        N as i32
    }
    pub fn cached(&self) -> i32 {
        self.indices
            .iter()
            .filter(|&&i| i >= 0 && i < self.end)
            .count() as i32
    }
    pub fn cache_capacity(&self) -> i32 {
        C as i32
    }
    pub fn inflight(&self) -> i32 {
        self.pending.iter().filter(|p| p.is_some()).count() as i32
    }
    pub fn prefetching(&self) -> bool {
        self.online() && !self.failed && (self.inflight() > 0 || self.next_page().is_some())
    }
    pub fn bytes(&self) -> i32 {
        core::mem::size_of::<Self>() as i32
    }
    // The active interval never spans more than C indices, so ring collisions
    // cannot evict a visible row. Bias 3/4 of spare capacity along motion.
    fn bounds(&self) -> (i32, i32) {
        let spare = C.saturating_sub(N) as i32;
        let behind = if self.direction >= 0 {
            spare / 4
        } else {
            spare - spare / 4
        };
        let raw = self.offset.saturating_sub(behind).max(0);
        let start = (if C - N < P {
            raw
        } else {
            raw / P as i32 * P as i32
        })
        .min(i32::MAX - C as i32);
        (start, (start + C as i32).min(self.end))
    }
    fn trim(&mut self) {
        let (start, end) = self.bounds();
        for i in &mut self.indices {
            if *i < start || *i >= end {
                *i = -1;
            }
        }
    }
    pub fn seek(&mut self, offset: i32) {
        let offset = offset.clamp(0, self.end.saturating_sub(N as i32).max(0));
        if self.offset != offset {
            self.direction = if offset > self.offset { 1 } else { -1 };
            self.offset = offset;
            self.trim();
            self.seeks = self.seeks.saturating_add(1);
            if self.len() < (self.end - self.offset).min(N as i32) {
                self.misses = self.misses.saturating_add(1);
            }
            self.dirty = true;
        }
    }
    pub fn filter(&mut self, query: i32) {
        if self.query != query {
            self.query = query;
            self.offset = 0;
            self.end = i32::MAX;
            self.direction = 1;
            self.version = self.version.wrapping_add(1);
            self.indices.fill(-1);
            self.failed = false;
            self.refresh = None;
            self.dirty = true;
        }
    }
    pub fn retry(&mut self) {
        self.failed = false;
        self.refresh = Some(self.page_start(self.offset));
        self.dirty = true;
    }
    fn page_start(&self, index: i32) -> i32 {
        (index / P as i32 * P as i32).min(i32::MAX - P as i32)
    }
    fn requested(&self, page: i32) -> bool {
        self.pending
            .iter()
            .flatten()
            .any(|p| p.version == self.version && p.offset == page)
    }
    fn missing_page(&self, index: i32) -> Option<i32> {
        if index < 0 || index >= self.end || self.has(index) {
            return None;
        }
        let page = self.page_start(index);
        if self.requested(page) {
            None
        } else {
            Some(page)
        }
    }
    fn next_page(&self) -> Option<i32> {
        // Visible misses always outrank refresh and background prefetch.
        for slot in 0..N as i32 {
            if let Some(page) = self.missing_page(self.offset + slot) {
                return Some(page);
            }
        }
        if let Some(page) = self.refresh {
            if !self.requested(page) {
                return Some(page);
            }
        }
        let (start, end) = self.bounds();
        if self.direction >= 0 {
            for i in self.offset + N as i32..end {
                if let Some(p) = self.missing_page(i) {
                    return Some(p);
                }
            }
            for i in (start..self.offset).rev() {
                if let Some(p) = self.missing_page(i) {
                    return Some(p);
                }
            }
        } else {
            for i in (start..self.offset).rev() {
                if let Some(p) = self.missing_page(i) {
                    return Some(p);
                }
            }
            for i in self.offset + N as i32..end {
                if let Some(p) = self.missing_page(i) {
                    return Some(p);
                }
            }
        }
        None
    }
    pub fn take_dirty(&mut self) -> bool {
        core::mem::take(&mut self.dirty)
    }
    pub fn poll(&mut self, io: &mut Bridge) {
        if self.session != io.session {
            self.session = io.session;
            self.version = self.version.wrapping_add(1);
            self.pending.fill(None);
            self.failed = false;
            // Keep a cached snapshot through disconnect. Revalidate the visible
            // page on reconnect; an epoch can never deliver an old reply.
            self.refresh = Some(self.page_start(self.offset));
            self.dirty = true;
        }
        if self.session == 0 {
            return;
        }
        for slot in 0..4 {
            let Some(p) = self.pending[slot] else {
                continue;
            };
            if io.reply.as_ref().is_some_and(|r| r.id == p.id) {
                let reply = io.reply.take().unwrap();
                self.pending[slot] = None;
                let (start, end) = self.bounds();
                if p.version != self.version || p.offset >= end || p.offset + P as i32 <= start {
                    self.discarded = self.discarded.saturating_add(1);
                } else {
                    let page = reply
                        .payload
                        .as_ref()
                        .filter(|_| reply.error.is_none())
                        .and_then(|v| serde_json::from_str::<Page<R, P>>(v.as_str()).ok())
                        .filter(|v| {
                            v.offset == p.offset
                                && v.query == p.query
                                && (!v.more || v.rows.len == P)
                                && v.total.is_none_or(|n| {
                                    n >= 0
                                        && (v.rows.len == 0 || p.offset + v.rows.len as i32 <= n)
                                        && v.more == (p.offset + (v.rows.len as i32) < n)
                                })
                        });
                    if let Some(page) = page {
                        if let Some(total) = page.total {
                            self.end = total;
                        } else if !page.more {
                            self.end = self.end.min(p.offset + page.rows.len as i32);
                        }
                        for (i, row) in page.rows.values.into_iter().enumerate().take(page.rows.len)
                        {
                            let index = p.offset + i as i32;
                            if index >= start && index < end {
                                self.rows[index as usize % C] = row;
                                self.indices[index as usize % C] = index;
                            }
                        }
                        if self.refresh == Some(p.offset) {
                            self.refresh = None;
                        }
                        self.received = self.received.saturating_add(1);
                        self.seek(self.offset);
                        self.trim();
                    } else {
                        self.failed = true;
                    }
                }
                self.dirty = true;
            } else if io.frame.saturating_sub(p.frame) >= TIMEOUT_FRAMES {
                self.pending[slot] = None;
                let (start, end) = self.bounds();
                if p.version == self.version && p.offset < end && p.offset + P as i32 > start {
                    self.failed = true;
                }
                self.dirty = true;
            }
        }
        if !self.failed {
            if let (Some(slot), Some(offset)) = (
                self.pending.iter().position(Option::is_none),
                self.next_page(),
            ) {
                if let Some(id) = io.send(self.method, self.schema, offset, self.query, P) {
                    self.pending[slot] = Some(Pending {
                        id,
                        version: self.version,
                        frame: io.frame,
                        offset,
                        query: self.query,
                    });
                    self.dirty = true;
                }
            }
        }
    }
    pub fn state(&self, out: &mut String) {
        use core::fmt::Write;
        let _ = write!(out, "{{\"offset\":{},\"query\":{},\"rows\":{},\"capacity\":{},\"cacheCapacity\":{},\"cached\":{},\"inflight\":{},\"seeks\":{},\"misses\":{},\"bytes\":{},\"received\":{},\"discarded\":{},\"online\":{},\"loading\":{},\"prefetching\":{},\"error\":{}}}",
            self.offset, self.query, self.len(), N, C, self.cached(), self.inflight(), self.seeks, self.misses, self.bytes(), self.received, self.discarded, self.online(), self.loading(), self.prefetching(), self.error());
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use alloc::string::ToString;
    use serde_json::{json, Value};
    use std::{cell::RefCell, collections::VecDeque, vec::Vec};
    #[derive(Default, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Row {
        id: i32,
        title: Text<96>,
    }
    type List = Window<Row, 5, 256, 8>;
    #[derive(Default)]
    struct Fake {
        session: i32,
        blocked: bool,
        queue: VecDeque<Value>,
        sent: Vec<Value>,
        reply: Option<String>,
    }
    std::thread_local! { static HOST: RefCell<Fake> = RefCell::new(Fake::default()); }
    fn setup() -> (List, Bridge) {
        HOST.with(|h| {
            *h.borrow_mut() = Fake {
                session: 1,
                ..Fake::default()
            }
        });
        let io = Bridge::new(Transport {
            session: || HOST.with(|h| h.borrow().session),
            submit: |s| {
                HOST.with(|h| {
                    let mut h = h.borrow_mut();
                    if h.blocked {
                        return false;
                    }
                    let v: Value = serde_json::from_str(s).unwrap();
                    h.sent.push(v.clone());
                    h.queue.push_back(v);
                    true
                })
            },
            take: || HOST.with(|h| h.borrow_mut().reply.take()),
        });
        (List::new("feed.window", "schema"), io)
    }
    fn step(w: &mut List, io: &mut Bridge) {
        io.begin_frame();
        w.poll(io);
    }
    fn request() -> Option<Value> {
        HOST.with(|h| h.borrow_mut().queue.pop_front())
    }
    fn answer(req: Value, total: i32) {
        let p: Value = serde_json::from_str(req["payload"].as_str().unwrap()).unwrap();
        let offset = p["offset"].as_i64().unwrap() as i32;
        let query = p["query"].as_i64().unwrap() as i32;
        let count = (total - offset).clamp(0, 8);
        let rows: Vec<_> = (0..count)
            .map(|i| json!({"id":offset+i+1+query*100000,"title":"cached row"}))
            .collect();
        let payload=json!({"offset":offset,"query":query,"more":offset+count<total,"total":total,"rows":rows}).to_string();
        HOST.with(|h| {
            h.borrow_mut().reply = Some(json!({"id":req["id"],"payload":payload}).to_string())
        });
    }
    fn pump(w: &mut List, io: &mut Bridge, frames: usize, total: i32) {
        for _ in 0..frames {
            if let Some(req) = request() {
                answer(req, total);
            }
            step(w, io);
        }
    }
    fn warm(w: &mut List, io: &mut Bridge) {
        pump(w, io, 80, i32::MAX);
        assert_eq!(w.cached(), 256);
        assert_eq!(w.inflight(), 0);
    }
    #[test]
    fn scrolling_keeps_overlap_and_only_missing_rows_are_placeholders() {
        let (mut w, mut io) = setup();
        step(&mut w, &mut io);
        answer(request().unwrap(), i32::MAX);
        step(&mut w, &mut io);
        w.seek(5);
        assert_eq!(w.len(), 3);
        assert_eq!(w.row(0).id, 6);
        assert_eq!(w.row(2).id, 8);
        assert!(!w.valid(3));
        assert!(w.loading());
        assert_eq!(w.row(99).id, 0);
        pump(&mut w, &mut io, 80, i32::MAX);
        assert_eq!(w.len(), 5);
        assert!(!w.loading());
        w.seek(6);
        assert_eq!(w.len(), 5);
        assert!(!w.loading());
    }
    #[test]
    fn sustained_fast_scroll_and_reverse_have_no_warm_cache_misses() {
        let (mut w, mut io) = setup();
        warm(&mut w, &mut io);
        let bytes = w.bytes();
        for i in 1..10001 {
            w.seek(i);
            assert_eq!(w.len(), 5, "missing rows at {i}");
            assert_eq!(w.row(0).id, i + 1);
            pump(&mut w, &mut io, 1, i32::MAX);
            assert!(w.cached() <= 256);
            assert!(w.inflight() <= 4);
            assert_eq!(w.bytes(), bytes);
        }
        for i in (9900..10000).rev() {
            w.seek(i);
            assert_eq!(w.len(), 5);
            pump(&mut w, &mut io, 1, i32::MAX);
        }
        assert_eq!(w.misses, 0);
    }
    #[test]
    fn delayed_bursts_prioritize_visible_and_discard_far_or_filtered_replies() {
        let (mut w, mut io) = setup();
        warm(&mut w, &mut io);
        w.seek(10000);
        for _ in 0..8 {
            step(&mut w, &mut io);
        }
        assert_eq!(w.inflight(), 4);
        w.seek(50000);
        w.filter(2);
        assert_eq!(w.len(), 0);
        pump(&mut w, &mut io, 100, i32::MAX);
        assert!(w.discarded() >= 4);
        assert_eq!(w.row(0).id, 200001);
        assert_eq!(w.cached(), 256);
        let requests = HOST.with(|h| h.borrow().sent.clone());
        let new: Value = serde_json::from_str(requests[36]["payload"].as_str().unwrap()).unwrap();
        assert_eq!(new["offset"], 0);
        assert_eq!(new["query"], 2);
    }
    #[test]
    fn offline_preserves_cache_and_reconnect_refreshes_without_blanking() {
        let (mut w, mut io) = setup();
        warm(&mut w, &mut io);
        HOST.with(|h| h.borrow_mut().session = 0);
        step(&mut w, &mut io);
        w.seek(20);
        assert!(!w.online());
        assert_eq!(w.len(), 5);
        assert!(!w.loading());
        HOST.with(|h| h.borrow_mut().session = 2);
        step(&mut w, &mut io);
        assert_eq!(w.len(), 5);
        assert_eq!(w.inflight(), 1);
        pump(&mut w, &mut io, 80, i32::MAX);
        assert!(w.online());
        assert_eq!(w.row(0).id, 21);
    }
    #[test]
    fn errors_and_retry_do_not_discard_cached_rows() {
        let (mut w, mut io) = setup();
        warm(&mut w, &mut io);
        w.retry();
        step(&mut w, &mut io);
        let req = request().unwrap();
        HOST.with(|h| {
            h.borrow_mut().reply =
                Some(json!({"id":req["id"],"error":"offline source"}).to_string())
        });
        step(&mut w, &mut io);
        assert!(w.error());
        assert_eq!(w.len(), 5);
        w.retry();
        pump(&mut w, &mut io, 80, i32::MAX);
        assert!(!w.error());
        assert_eq!(w.len(), 5);
    }
    #[test]
    fn timeout_and_backpressure_keep_bounded_requests_and_latest_target() {
        let (mut w, mut io) = setup();
        HOST.with(|h| h.borrow_mut().blocked = true);
        for i in 0..1000 {
            w.seek(i);
            step(&mut w, &mut io);
        }
        assert_eq!(w.inflight(), 0);
        HOST.with(|h| h.borrow_mut().blocked = false);
        step(&mut w, &mut io);
        let req = request().unwrap();
        let p: Value = serde_json::from_str(req["payload"].as_str().unwrap()).unwrap();
        assert_eq!(p["offset"], 992);
        for _ in 0..TIMEOUT_FRAMES + 4 {
            step(&mut w, &mut io);
        }
        assert!(w.error());
        assert_eq!(w.inflight(), 0);
        HOST.with(|h| h.borrow_mut().queue.clear());
        w.retry();
        pump(&mut w, &mut io, 100, i32::MAX);
        assert!(!w.error());
        assert_eq!(w.row(0).id, 1000);
    }
    #[test]
    fn finite_end_and_huge_seek_clamp_and_stop_prefetch() {
        let (mut w, mut io) = setup();
        w.seek(1000000);
        pump(&mut w, &mut io, 80, 11);
        assert_eq!(w.offset(), 6);
        assert_eq!(w.len(), 5);
        assert_eq!(w.row(4).id, 11);
        assert!(!w.more());
        assert!(!w.prefetching());
        w.seek(i32::MAX);
        assert_eq!(w.offset(), 6);
        w.seek(-1);
        pump(&mut w, &mut io, 20, 11);
        assert_eq!(w.offset(), 0);
        assert_eq!(w.cached(), 11);
    }
    #[test]
    fn decoding_rejects_extra_rows_types_and_utf8_budgets_without_partial_commit() {
        for rows in [
            json!([]),
            json!([{"id":"wrong","title":"ok"}]),
            json!([{"id":1,"title":"é".repeat(49)}]),
            json!([{"id":1,"title":"x","extra":1}]),
        ] {
            // The first case is replaced below with nine full rows.
            let rows = if rows.as_array().unwrap().is_empty() {
                json!((0..9)
                    .map(|i| json!({"id":i,"title":"x"}))
                    .collect::<Vec<_>>())
            } else {
                rows
            };
            let (mut w, mut io) = setup();
            warm(&mut w, &mut io);
            w.retry();
            step(&mut w, &mut io);
            let req = request().unwrap();
            let payload = json!({"offset":0,"query":0,"more":false,"rows":rows}).to_string();
            HOST.with(|h| {
                h.borrow_mut().reply = Some(json!({"id":req["id"],"payload":payload}).to_string())
            });
            step(&mut w, &mut io);
            assert!(w.error());
            assert_eq!(w.row(0).id, 1);
            assert_eq!(w.cached(), 256);
        }
        assert!(serde_json::from_str::<Text<4>>("\"éé\"").is_ok());
        assert!(serde_json::from_str::<Text<4>>("\"ééx\"").is_err());
    }
    #[test]
    fn out_of_order_pages_route_between_windows() {
        let (mut a, mut io) = setup();
        let mut b = List::new("other.window", "other");
        step(&mut a, &mut io);
        let first = request().unwrap();
        io.begin_frame();
        b.poll(&mut io);
        let second = request().unwrap();
        answer(second, i32::MAX);
        io.begin_frame();
        a.poll(&mut io);
        b.poll(&mut io);
        assert_eq!(b.len(), 5);
        assert_eq!(a.len(), 0);
        answer(first, i32::MAX);
        io.begin_frame();
        a.poll(&mut io);
        b.poll(&mut io);
        assert_eq!(a.len(), 5);
    }
    #[test]
    fn held_button_accelerates_and_release_stops_immediately() {
        let mut repeat = crate::ButtonRepeat::default();
        let mut counts = [0; 4];
        for frame in 0..240 {
            if repeat.tick(true) {
                counts[frame / 60] += 1;
            }
        }
        assert_eq!(counts, [13, 30, 30, 60]);
        assert!(!repeat.tick(false));
        assert!(repeat.tick(true));
        for _ in 0..11 {
            assert!(!repeat.tick(true));
        }
        assert!(repeat.tick(true));
    }
}
