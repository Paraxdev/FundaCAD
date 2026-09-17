//! Deterministic data parallelism over OpenCASCADE shapes.
//!
//! The Python engine was one job per process with OCCT's own thread pool
//! inside BRepMesh and BOPAlgo (sidecar/occt_smp.py). Rust fans the passes
//! above the kernel out too, under one rule: a parallel pass must produce the
//! bytes the serial pass produces. So every helper here collects by index and
//! returns results in the input order, and nothing here sums, hashes or
//! inserts in completion order.
//!
//! OCCT is only safe to drive from several threads when no two threads touch
//! the same `TShape`. Moving or duplicating a body shares its TShape (only the
//! Location changes), so bodies are meshed in parallel only after
//! `no_shared_faces` says they own their faces outright.

use std::collections::HashMap;

use opencascade::primitives::Shape;
use opencascade_sys::face_query as fq;
use rayon::prelude::*;

/// A value handed to worker threads.
///
/// OCCT's readers are const and its handle counters are atomic, and the one
/// writer in these passes (BRepMesh, storing a triangulation) writes into the
/// faces of the shape it is given. The callers below pass shapes that share no
/// face, so no two threads reach the same TShape.
pub struct Shared<T>(pub T);

unsafe impl<T> Send for Shared<T> {}
unsafe impl<T> Sync for Shared<T> {}

impl<T> Shared<T> {
    pub fn get(&self) -> &T {
        &self.0
    }
}

/// How many threads the engine may use, `FUNDACAD_THREADS` when set (the
/// sidecar's `VERXA_THREADS`), else every logical processor.
pub fn threads() -> usize {
    std::env::var("FUNDACAD_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
        })
}

/// True when a pass over `n` items is worth handing to other threads.
pub fn worth_it(n: usize) -> bool {
    n > 1 && threads() > 1
}

/// `f` over `0..n` in parallel, the results in index order.
pub fn map_indexed<R: Send>(n: usize, f: impl Fn(usize) -> R + Sync + Send) -> Vec<R> {
    if !worth_it(n) {
        return (0..n).map(f).collect();
    }
    (0..n).into_par_iter().map(f).collect()
}

/// `f` over `0..n` in parallel, the results flattened in index order.
pub fn flat_map_indexed<R: Send>(
    n: usize,
    f: impl Fn(usize) -> Vec<R> + Sync + Send,
) -> Vec<R> {
    map_indexed(n, f).into_iter().flatten().collect()
}

/// Each shape's face `TShape` addresses.
pub fn face_tshapes(shape: &Shape) -> Vec<u64> {
    crate::kernel::subshapes(shape, crate::kernel::Kind::Face)
        .iter()
        .map(|f| fq::FQ_tshape(f.raw()))
        .collect()
}

/// The shapes split into groups that share no face with each other, each group
/// in index order and the groups ordered by their first member.
///
/// An assembly places one product many times, and a placed copy keeps the
/// product's TShape, so meshing two of them at once would have two threads
/// writing one triangulation. Grouping puts those together, to be meshed in
/// order on one thread, and lets the rest of the document run beside them.
pub fn share_groups(shapes: &[&Shape]) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..shapes.len()).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut owner: HashMap<u64, usize> = HashMap::new();
    for (i, s) in shapes.iter().enumerate() {
        for t in face_tshapes(s) {
            match owner.entry(t) {
                std::collections::hash_map::Entry::Occupied(e) => {
                    let (a, b) = (find(&mut parent, *e.get()), find(&mut parent, i));
                    if a != b {
                        parent[a.max(b)] = a.min(b);
                    }
                }
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(i);
                }
            }
        }
    }
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut at: HashMap<usize, usize> = HashMap::new();
    for i in 0..shapes.len() {
        let root = find(&mut parent, i);
        match at.get(&root) {
            Some(&g) => groups[g].push(i),
            None => {
                at.insert(root, groups.len());
                groups.push(vec![i]);
            }
        }
    }
    groups
}
