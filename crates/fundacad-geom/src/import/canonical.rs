//! Canonical recognition at import, replaces `_canonicalize`,
//! `_canonicalize_roots`, `_canonical_ok` and `_realign_face_colors` of
//! the Python engine's `mesh_import.py`.

use std::collections::HashMap;

use opencascade::canonical;
use opencascade::primitives::Shape;

use crate::builder::owners::face_key;
use crate::kernel::{self, Kind};

const TOL: f64 = 1e-3;

/// Same solid and face counts, and with `deep` a valid shape within 0.5% of
/// the volume.
fn canonical_ok(result: &Shape, shape: &Shape, deep: bool) -> bool {
    if kernel::count(result, Kind::Solid) != kernel::count(shape, Kind::Solid).max(1)
        || kernel::count(result, Kind::Face) != kernel::count(shape, Kind::Face)
    {
        return false;
    }
    if !deep {
        return true;
    }
    let (after, before) = (kernel::volume(result), kernel::volume(shape));
    result.is_valid().unwrap_or(false) && (after - before).abs() <= f64::max(1e-6, 0.005 * before.abs())
}

/// The canonical form of `shape`, None when it stays as it is.
pub fn canonicalize(shape: &Shape) -> Option<Shape> {
    if !canonical::convertible(shape).ok()? {
        return None;
    }
    let work = canonical::swept_to_elementary(shape).ok()?;
    let (converted, count) = canonical::convert(work.as_ref().unwrap_or(shape), TOL).ok()?;
    if count == 0 {
        return work.filter(|w| canonical_ok(w, shape, false));
    }
    converted.filter(|r| canonical_ok(r, shape, true))
}

/// `_canonicalize_roots`: each root on its own, then one compound.
pub fn canonicalize_roots(roots: &[Shape]) -> Shape {
    let done: Vec<Option<Shape>> = roots.iter().map(canonicalize).collect();
    kernel::compound(done.iter().zip(roots).map(|(d, r)| d.as_ref().unwrap_or(r)))
}

/// A per face colour list of `before` carried onto `after` by face
/// fingerprint, None when the list does not fit `before`.
pub fn realign_face_colors<T: Clone>(before: &Shape, after: &Shape, colors: &[Option<T>]) -> Option<Vec<Option<T>>> {
    let src = kernel::subshapes(before, Kind::Face);
    if src.len() != colors.len() {
        return None;
    }
    let mut lookup: HashMap<Option<String>, T> = HashMap::new();
    for (face, c) in src.iter().zip(colors) {
        if let Some(c) = c {
            lookup.entry(face_key(face)).or_insert_with(|| c.clone());
        }
    }
    Some(kernel::subshapes(after, Kind::Face).iter().map(|f| lookup.get(&face_key(f)).cloned()).collect())
}
