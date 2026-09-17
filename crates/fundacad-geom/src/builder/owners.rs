//! Face provenance, sidecar/builder.py `_update_owners` over the fingerprints
//! of sidecar/defeature.py `_face_fp`: each face of a changed body is owned by
//! the feature that last made it, keyed by its rounded area and centre.

use std::collections::HashMap;

use fundacad_core::schema::Feature;
use opencascade::primitives::Shape;

use super::Ctx;
use crate::kernel::{self, Kind};

/// Fingerprint key to owning feature id.
pub type Owners = HashMap<String, String>;

/// Python `round(x, n)` for the fingerprint: correctly rounded, ties to even,
/// negative zero folded into zero as a tuple key compares it.
fn round_key(v: f64, digits: usize) -> String {
    let s = format!("{v:.digits$}");
    match s.parse::<f64>() {
        Ok(z) if z == 0.0 => format!("{:.digits$}", 0.0),
        _ => s,
    }
}

fn key(area: f64, c: [f64; 3]) -> String {
    format!(
        "{}|{}|{}|{}",
        round_key(area, 2),
        round_key(c[0], 1),
        round_key(c[1], 1),
        round_key(c[2], 1)
    )
}

/// `_face_fp` of one face, for looking up `faceOwners`.
pub fn face_key(face: &Shape) -> Option<String> {
    kernel::face_area_centre(face).map(|a| key(a[0], [a[1], a[2], a[3]]))
}

/// The fingerprint before rounding, so a move can transform its centre.
fn face_raw(face: &Shape) -> Option<[f64; 4]> {
    kernel::face_area_centre(face)
}

pub fn update(
    ctx: &mut Ctx,
    f: &Feature,
    fid: &str,
    pre: &[(u64, u64)],
    pre_owners: &[(u64, Owners)],
) {
    let moved: Option<(Vec<String>, [f64; 3], [f64; 3])> = match f {
        Feature::Move(m) if !ctx.bodies.is_empty() => {
            let ids = match &m.bodies {
                Some(ids) if !ids.is_empty() => ids.clone(),
                _ => ctx
                    .bodies
                    .last()
                    .map(|b| vec![b.id.clone()])
                    .unwrap_or_default(),
            };
            let v =
                |n: &Option<fundacad_core::schema::Num>| ctx.val_or(n.as_ref(), 0.0).unwrap_or(0.0);
            Some((
                ids,
                [v(&m.rx), v(&m.ry), v(&m.rz)],
                [v(&m.dx), v(&m.dy), v(&m.dz)],
            ))
        }
        _ => None,
    };
    let all: Vec<&Owners> = pre_owners.iter().map(|(_, o)| o).collect();
    let mut updates: Vec<(usize, Owners)> = Vec::new();
    for (index, b) in ctx.bodies.iter().enumerate() {
        let unchanged = pre
            .iter()
            .any(|(uid, gen)| *uid == b.uid && *gen == b.generation);
        if unchanged {
            continue;
        }
        let empty = Owners::new();
        let prior_src = pre_owners
            .iter()
            .find(|(uid, _)| *uid == b.uid)
            .map_or(&empty, |(_, o)| o);
        let mut prior: Owners = prior_src.clone();
        if let Some((ids, r, d)) = &moved {
            if ids.contains(&b.id) && !prior_src.is_empty() {
                prior = prior_src
                    .iter()
                    .filter_map(|(k, v)| moved_key(k, *r, *d).map(|nk| (nk, v.clone())))
                    .collect();
            }
        }
        let mut owners = Owners::new();
        for face in kernel::subshapes(b.shape(), Kind::Face) {
            let Some(raw) = face_raw(&face) else { continue };
            let fp = key(raw[0], [raw[1], raw[2], raw[3]]);
            let owner = prior
                .get(&fp)
                .or_else(|| all.iter().rev().find_map(|o| o.get(&fp)))
                .cloned()
                .unwrap_or_else(|| fid.to_owned());
            owners.insert(fp, owner);
        }
        updates.push((index, owners));
    }
    for (index, owners) in updates {
        if let Some(b) = ctx.bodies.get_mut(index) {
            b.owners = owners;
        }
    }
}

/// `_move_fp`: the rounded centre moved, the area kept as it was.
fn moved_key(k: &str, r: [f64; 3], d: [f64; 3]) -> Option<String> {
    let mut parts = k.split('|');
    let area = parts.next()?.to_owned();
    let c: Vec<f64> = parts.filter_map(|p| p.parse().ok()).collect();
    if c.len() != 3 {
        return None;
    }
    let p = kernel::euler_point(r, d, [c[0], c[1], c[2]]);
    Some(format!(
        "{area}|{}|{}|{}",
        round_key(p[0], 1),
        round_key(p[1], 1),
        round_key(p[2], 1)
    ))
}
