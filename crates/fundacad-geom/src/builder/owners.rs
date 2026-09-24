//! Face provenance, the Python engine's `builder.py` `_update_owners` over the fingerprints
//! of the Python engine's `defeature.py` `_face_fp`: each face of a changed body is owned by
//! the feature that last made it, keyed by its rounded area and centre.

use std::collections::HashMap;

use fundacad_core::schema::Feature;
use opencascade::primitives::Shape;

use super::Ctx;
use crate::kernel::{self, Kind};

/// Fingerprint key to owning feature id.
pub type Owners = HashMap<String, String>;

/// Each body's faces with their unrounded fingerprints, by body uid, so a
/// face a feature left alone is not integrated again. Holding the face keeps
/// its TShape alive, so its address cannot be reused by another face.
#[derive(Default)]
pub struct FaceFps(HashMap<u64, Vec<(Shape, Option<[f64; 4]>)>>);

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
    let changed: Vec<usize> = ctx
        .bodies
        .iter()
        .enumerate()
        .filter(|(_, b)| !pre.iter().any(|(uid, gen)| *uid == b.uid && *gen == b.generation))
        .map(|(i, _)| i)
        .collect();
    let faces: Vec<Vec<Shape>> = changed
        .iter()
        .map(|&i| kernel::subshapes(ctx.bodies[i].shape(), Kind::Face))
        .collect();
    let mut known: HashMap<u64, Vec<&(Shape, Option<[f64; 4]>)>> = HashMap::new();
    for entry in ctx.face_fps.0.values().flatten() {
        known.entry(kernel::tshape_id(&entry.0)).or_default().push(entry);
    }
    let mut raws: Vec<Vec<Option<Option<[f64; 4]>>>> = faces
        .iter()
        .map(|fs| {
            fs.iter()
                .map(|face| {
                    known
                        .get(&kernel::tshape_id(face))
                        .and_then(|c| c.iter().find(|(f, _)| kernel::is_equal(f, face)))
                        .map(|(_, raw)| *raw)
                })
                .collect()
        })
        .collect();
    drop(known);
    let misses: Vec<(usize, usize)> = raws
        .iter()
        .enumerate()
        .flat_map(|(b, rs)| rs.iter().enumerate().filter(|(_, r)| r.is_none()).map(move |(f, _)| (b, f)))
        .collect();
    let work = crate::par::Shared((&faces, &misses));
    let fresh = crate::par::map_indexed(misses.len(), move |m| {
        let (faces, misses) = *work.get();
        let (b, f) = misses[m];
        face_raw(&faces[b][f])
    });
    for (&(b, f), raw) in misses.iter().zip(fresh) {
        raws[b][f] = Some(raw);
    }

    let mut updates: Vec<(usize, Owners)> = Vec::new();
    let mut measured: Vec<(u64, Vec<(Shape, Option<[f64; 4]>)>)> = Vec::new();
    for ((&index, fs), rs) in changed.iter().zip(faces).zip(raws) {
        let b = &ctx.bodies[index];
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
        let mut fps = Vec::with_capacity(fs.len());
        for (face, raw) in fs.into_iter().zip(rs) {
            let raw = raw.flatten();
            fps.push((face, raw));
            let Some(raw) = raw else { continue };
            let fp = key(raw[0], [raw[1], raw[2], raw[3]]);
            let owner = prior
                .get(&fp)
                .or_else(|| all.iter().rev().find_map(|o| o.get(&fp)))
                .cloned()
                .unwrap_or_else(|| fid.to_owned());
            owners.insert(fp, owner);
        }
        updates.push((index, owners));
        measured.push((b.uid, fps));
    }
    let live: std::collections::HashSet<u64> = ctx.bodies.iter().map(|b| b.uid).collect();
    ctx.face_fps.0.retain(|uid, _| live.contains(uid));
    ctx.face_fps.0.extend(measured);
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
