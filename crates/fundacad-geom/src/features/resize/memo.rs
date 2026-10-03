//! What a resize works out about a body and its face that does not depend on
//! the size asked for, kept for the next call: a drag asks for the same face
//! of the same body again at every new size. The shapes are held, so a freed
//! one's address is never read as another's.

use std::cell::RefCell;

use opencascade::primitives::Shape;

use super::neighbours::{neighbours, same_surface, Nb};
use crate::kernel;
use crate::topo::FaceAdjacency;

const KEEP: usize = 4;

type Memo<K, T> = RefCell<Vec<(K, T)>>;

thread_local! {
    static VOLUMES: Memo<Shape, f64> = const { RefCell::new(Vec::new()) };
    static AROUND: Memo<(Shape, Shape), Around> = const { RefCell::new(Vec::new()) };
    static SECTIONS: Memo<(Shape, Shape), Option<Shape>> = const { RefCell::new(Vec::new()) };
    static SURFACES: Memo<(Shape, u64), Shape> = const { RefCell::new(Vec::new()) };
}

fn remembered<K, T: Clone>(
    memo: &'static std::thread::LocalKey<Memo<K, T>>,
    same: impl Fn(&K) -> bool,
    key: impl FnOnce() -> K,
    make: impl FnOnce() -> T,
) -> T {
    if let Some(v) = memo.with(|m| m.borrow().iter().find(|(k, _)| same(k)).map(|e| e.1.clone())) {
        return v;
    }
    let v = make();
    memo.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= KEEP {
            m.remove(0);
        }
        m.push((key(), v.clone()));
    });
    v
}

pub(super) fn volume(body: &Shape) -> f64 {
    remembered(&VOLUMES, |k| k.is_same(body), || body.clone(), || kernel::volume(body))
}

/// A face, its siblings on the same surface, and the faces across their edges.
#[derive(Clone)]
pub(super) struct Around {
    pub group: Vec<Shape>,
    pub nbs: Vec<Nb>,
}

pub(super) fn around(body: &Shape, face: &Shape) -> Around {
    remembered(
        &AROUND,
        |(b, f)| b.is_same(body) && f.is_same(face),
        || (body.clone(), face.clone()),
        || {
            let adj = FaceAdjacency::new(body);
            let group = same_surface(&adj, face);
            let nbs = neighbours(&adj, &group);
            Around { group, nbs }
        },
    )
}

/// The cross section of a closed run through `face`, None when it is not one.
pub(super) fn section(body: &Shape, face: &Shape, make: impl FnOnce() -> Option<Shape>) -> Option<Shape> {
    remembered(&SECTIONS, |(b, f)| b.is_same(body) && f.is_same(face), || (body.clone(), face.clone()), make)
}

/// A neighbour's whole surface, reaching at least `size` around it.
pub(super) fn whole_surface(face: &Shape, size: f64, make: impl FnOnce(f64) -> Option<Shape>) -> Option<Shape> {
    // Sizes are kept in steps of a power of two, so a drag reuses the one it made first.
    let step = 2f64.powi(size.max(1.0).log2().ceil() as i32);
    let key = step.to_bits();
    let hit = SURFACES.with(|m| m.borrow().iter().find(|((f, k), _)| *k == key && f.is_same(face)).map(|e| e.1.clone()));
    if hit.is_some() {
        return hit;
    }
    let made = make(step)?;
    SURFACES.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= 4 * KEEP {
            m.remove(0);
        }
        m.push(((face.clone(), key), made.clone()));
    });
    Some(made)
}
