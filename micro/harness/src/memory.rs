//! Process-wide live allocations, including the bounded desktop IO worker.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
pub struct Measured;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
fn add(n: usize) {
    let live = LIVE.fetch_add(n, Relaxed) + n;
    PEAK.fetch_max(live, Relaxed);
}
unsafe impl GlobalAlloc for Measured {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            add(layout.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        System.dealloc(p, layout);
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let next = System.realloc(p, old, size);
        if !next.is_null() {
            if size >= old.size() {
                add(size - old.size());
            } else {
                LIVE.fetch_sub(old.size() - size, Relaxed);
            }
        }
        next
    }
}
pub fn live() -> usize {
    LIVE.load(Relaxed)
}
pub fn peak() -> usize {
    PEAK.load(Relaxed)
}
