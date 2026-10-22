//! A parallel pass must give the serial pass's bytes, so results come back in input order. OCCT is
//! safe across threads only while no two touch one TShape, and moved copies share theirs.

use std::collections::HashMap;
use std::sync::OnceLock;

use opencascade::primitives::Shape;
use opencascade_sys::face_query as fq;
use rayon::prelude::*;

/// OCCT readers are const and its handle counters atomic. The one writer, BRepMesh, writes into the
/// faces it is given, and callers pass shapes that share no face, so no two threads reach one TShape.
pub struct Shared<T>(pub T);

unsafe impl<T> Send for Shared<T> {}
unsafe impl<T> Sync for Shared<T> {}

impl<T> Shared<T> {
    pub fn get(&self) -> &T {
        &self.0
    }
}

/// `FUNDACAD_THREADS` when set, else every logical processor.
pub fn threads() -> usize {
    std::env::var("FUNDACAD_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get))
}

pub fn worth_it(n: usize) -> bool {
    n > 1 && pool().current_num_threads() > 1
}

/// The engine's own pool sized by `threads()`, not rayon's global one, so a host that also uses
/// rayon does not resize ours.
fn pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads())
            .thread_name(|i| format!("fundacad-geom-{i}"))
            .build()
            .unwrap_or_else(|_| rayon::ThreadPoolBuilder::new().build().expect("a rayon pool"))
    })
}

/// Points OCCT's pool at the same thread count with BRepMesh and BOPAlgo parallel. Once per process
/// before any job, as the pool must not resize while an algorithm holds its threads.
pub fn configure_occt() -> usize {
    static DONE: OnceLock<usize> = OnceLock::new();
    *DONE.get_or_init(|| opencascade_sys::osd_smp::osd_smp_configure(threads() as i32).max(1) as usize)
}

/// `f` over `0..n` in parallel, the results in index order.
pub fn map_indexed<R: Send>(n: usize, f: impl Fn(usize) -> R + Sync + Send) -> Vec<R> {
    if !worth_it(n) {
        return (0..n).map(f).collect();
    }
    // install() so a nested pass joins this pool instead of rayon's global one.
    pool().install(|| (0..n).into_par_iter().map(f).collect())
}

/// `f` over `0..n` in parallel, the results flattened in index order.
pub fn flat_map_indexed<R: Send>(n: usize, f: impl Fn(usize) -> Vec<R> + Sync + Send) -> Vec<R> {
    map_indexed(n, f).into_iter().flatten().collect()
}

/// Groups run beside each other, a group's members in order on one thread, and results come back
/// sorted by index, the order a serial walk gives.
pub fn map_grouped<R: Send>(groups: &[Vec<usize>], f: impl Fn(usize) -> R + Sync + Send) -> Vec<(usize, R)> {
    let work = Shared((&f, groups));
    let mut out: Vec<(usize, R)> = flat_map_indexed(groups.len(), move |g| {
        let (f, groups) = *work.get();
        groups[g].iter().map(|&i| (i, f(i))).collect()
    });
    out.sort_by_key(|(i, _)| *i);
    out
}

/// Each shape's face `TShape` addresses.
pub fn face_tshapes(shape: &Shape) -> Vec<u64> {
    crate::kernel::subshapes(shape, crate::kernel::Kind::Face).iter().map(|f| fq::FQ_tshape(f.raw())).collect()
}

/// Groups that share no face, each in index order, ordered by first member. A placed copy keeps its
/// product's TShape, so copies mesh in order on one thread while the rest run beside them.
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
