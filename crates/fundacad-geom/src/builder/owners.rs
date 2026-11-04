//! Face provenance, `_update_owners` in builder.py over the `_face_fp` fingerprints of defeature.py: each face
//! of a changed body is owned by the feature that last made it, keyed by its rounded area and centre.

use std::collections::HashMap;

use fundacad_core::schema::{Feature, Move, Num};
use opencascade::primitives::Shape;

use super::{Ctx, RigidMove};
use crate::kernel::{self, Kind};

/// Fingerprint key to owning feature id.
pub type Owners = HashMap<String, String>;

/// Each body's faces with their unrounded fingerprints, so an untouched face is not integrated again.
/// Holding the face keeps its TShape alive, so its address cannot be reused by another face.
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
    format!("{}|{}|{}|{}", round_key(area, 2), round_key(c[0], 1), round_key(c[1], 1), round_key(c[2], 1))
}

/// `_face_fp` of one face, for looking up `faceOwners`.
pub fn face_key(face: &Shape) -> Option<String> {
    kernel::face_area_centre(face).map(|a| key(a[0], [a[1], a[2], a[3]]))
}

/// The owner of each face of `shape` in face order, keyed by what this very shape's faces measure.
/// None when the shape does not hold that many faces.
pub fn keyed(shape: &Shape, listed: &[Option<String>]) -> Option<Owners> {
    let faces = kernel::subshapes(shape, Kind::Face);
    if faces.len() != listed.len() {
        return None;
    }
    let work = crate::par::Shared(&faces);
    let keys = crate::par::map_indexed(faces.len(), move |i| face_key(&work.get()[i]));
    Some(keys.into_iter().zip(listed).filter_map(|(k, o)| Some((k?, o.clone()?))).collect())
}

/// The fingerprint before rounding, so a move can transform its centre.
fn face_raw(face: &Shape) -> Option<[f64; 4]> {
    kernel::face_area_centre(face)
}

pub fn update(ctx: &mut Ctx, f: &Feature, fid: &str, pre: &[(u64, u64)], pre_owners: &[(u64, Owners)]) {
    // A mechanism says how it moved each body and a Move places its bodies rigidly; joint keeps
    // re-owning the faces it moves, as the Python engine did.
    let taken = std::mem::take(&mut ctx.rigid_moves);
    let rigid: Vec<RigidMove> = match f {
        Feature::Mechanism(_) => taken,
        Feature::Move(m) => moved_rigidly(ctx, m),
        _ => Vec::new(),
    };
    let all: Vec<&Owners> = pre_owners.iter().map(|(_, o)| o).collect();
    let changed: Vec<usize> = ctx
        .bodies
        .iter()
        .enumerate()
        .filter(|(_, b)| !pre.iter().any(|(uid, gen)| *uid == b.uid && *gen == b.generation))
        .map(|(i, _)| i)
        .collect();
    let faces: Vec<Vec<Shape>> =
        changed.iter().map(|&i| kernel::subshapes(ctx.bodies[i].shape(), Kind::Face)).collect();
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

    let mut latest: Option<HashMap<&str, &String>> = None;
    let mut updates: Vec<(usize, Owners, Vec<Option<String>>)> = Vec::new();
    let mut measured: Vec<(u64, Vec<(Shape, Option<[f64; 4]>)>)> = Vec::new();
    for ((&index, fs), rs) in changed.iter().zip(faces).zip(raws) {
        let b = &ctx.bodies[index];
        let empty = Owners::new();
        let prior_src = pre_owners.iter().find(|(uid, _)| *uid == b.uid).map_or(&empty, |(_, o)| o);
        let mut prior: Owners = prior_src.clone();
        // A rigidly moved body keeps its faces' TShapes, so each face finds its old fingerprint. The rest
        // go by their unrounded centres sent through the move, rounded once where they land.
        let mut carried: HashMap<u64, Option<&String>> = HashMap::new();
        let rigid_move = rigid.iter().find(|m| m.body == b.id);
        let undo = rigid_move.map(|m| (m.rot.inverse(), m.shift));
        if let Some(m) = rigid_move {
            let before = ctx.face_fps.0.get(&b.uid).map_or(&[][..], Vec::as_slice);
            prior = Owners::new();
            for (face, raw) in before {
                let Some(raw) = raw else { continue };
                let Some(owner) = prior_src.get(&key(raw[0], [raw[1], raw[2], raw[3]])) else {
                    continue;
                };
                let c = m.rot * glam::DVec3::new(raw[1], raw[2], raw[3]) + m.shift;
                prior.insert(key(raw[0], c.to_array()), owner.clone());
                // A TShape seen twice in the body names no one face.
                carried.entry(kernel::tshape_id(face)).and_modify(|o| *o = None).or_insert(Some(owner));
            }
        }
        let mut owners = Owners::new();
        let mut fps = Vec::with_capacity(fs.len());
        let mut keys = Vec::with_capacity(fs.len());
        for (face, raw) in fs.into_iter().zip(rs) {
            let raw = raw.flatten();
            let same = carried.get(&kernel::tshape_id(&face)).copied().flatten();
            fps.push((face, raw));
            let Some(raw) = raw else {
                keys.push(None);
                continue;
            };
            let fp = key(raw[0], [raw[1], raw[2], raw[3]]);
            // A body resumed from a checkpoint has no faces measured before the move, so its centre is sent back.
            let back = || {
                let (inv, shift) = undo?;
                let c = inv * (glam::DVec3::new(raw[1], raw[2], raw[3]) - shift);
                prior_src.get(&key(raw[0], c.to_array()))
            };
            let owner = match same.or_else(|| prior.get(&fp)).or_else(back) {
                Some(o) => o.clone(),
                None => latest
                    .get_or_insert_with(|| latest_owners(&all))
                    .get(fp.as_str())
                    .map_or_else(|| fid.to_owned(), |o| (*o).clone()),
            };
            owners.insert(fp.clone(), owner);
            keys.push(Some(fp));
        }
        // Read off the finished map: two faces that share a fingerprint share
        // whichever owner the map ended up holding for it.
        let listed = keys.iter().map(|k| k.as_ref().and_then(|k| owners.get(k).cloned())).collect();
        updates.push((index, owners, listed));
        measured.push((b.uid, fps));
    }
    let live: std::collections::HashSet<u64> = ctx.bodies.iter().map(|b| b.uid).collect();
    ctx.face_fps.0.retain(|uid, _| live.contains(uid));
    ctx.face_fps.0.extend(measured);
    for (index, owners, listed) in updates {
        if let Some(b) = ctx.bodies.get_mut(index) {
            b.owners = owners;
            b.face_owners = Some((b.generation, std::sync::Arc::new(listed)));
        }
    }
}

/// The owner the latest body in `all` holds for each fingerprint, built once so the new faces of a big fillet over
/// thousands of bodies are not each looked up in every body's map.
pub(crate) fn latest_owners<'a>(all: &[&'a Owners]) -> HashMap<&'a str, &'a String> {
    let mut out = HashMap::with_capacity(all.iter().map(|o| o.len()).sum());
    for o in all {
        for (k, v) in o.iter() {
            out.insert(k.as_str(), v);
        }
    }
    out
}

/// A Move as the rigid move of each body it places. Moving a rounded fingerprint and rounding it again,
/// as `_move_fp` did, lands a face whose centre sits off the 0.1 grid on a key it does not measure.
fn moved_rigidly(ctx: &Ctx, m: &Move) -> Vec<RigidMove> {
    let Some(last) = ctx.bodies.last() else { return Vec::new() };
    let ids = match &m.bodies {
        Some(ids) if !ids.is_empty() => ids.clone(),
        _ => vec![last.id.clone()],
    };
    let v = |n: &Option<Num>| ctx.val_or(n.as_ref(), 0.0).unwrap_or(0.0);
    let (r, d) = ([v(&m.rx), v(&m.ry), v(&m.rz)], [v(&m.dx), v(&m.dy), v(&m.dz)]);
    let col = |axis: [f64; 3]| glam::DVec3::from(kernel::euler_point(r, [0.0; 3], axis));
    let rot = glam::DMat3::from_cols(col([1.0, 0.0, 0.0]), col([0.0, 1.0, 0.0]), col([0.0, 0.0, 1.0]));
    let shift = glam::DVec3::from(d);
    ids.into_iter().map(|body| RigidMove { body, rot, shift }).collect()
}

#[cfg(test)]
#[path = "owners_tests.rs"]
mod tests;
