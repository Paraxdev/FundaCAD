//! A Modify starter's opening values from what the build shows: a pattern one source length apart, a pattern of the
//! hole or cut a picked face came from, a datum cut reaching every body, a mirror about a flat face.

#[cfg(test)]
mod tests;

use std::sync::Arc;

use serde_json::{json, Value};

use super::super::{plane_def, round};
use crate::selection::{Pick, Selection};
use crate::tools::{self, insert, next_id, Doc, Start};
use crate::viewport::scene::Body;

/// A started feature and the features that go in just before it, as the mirror's plane on a picked face.
#[derive(Debug, PartialEq)]
pub struct Fitted {
    pub start: Start,
    pub before: Vec<Value>,
}

/// The pattern spacing FundaCAD 1 fell back on when the sources have no length along the axis.
const SPACING: f64 = 20.0;

/// `shown` is the visible bodies in build order, the last the active one, as the engine's `require_active`.
pub fn fit(tool: &str, mut start: Start, doc: &Doc, s: &Selection, shown: &[Arc<Body>]) -> Fitted {
    let mut before = Vec::new();
    let f = &mut start.feature;
    match tool {
        "pattern-linear" | "pattern-circular" | "pattern-rect" => pattern(f, doc, s, shown),
        "split" if f.get("planeId").is_some() && f.get("bodies").is_none() => {
            f["bodies"] = json!(shown.iter().map(|b| b.id.clone()).collect::<Vec<_>>());
        }
        "separate" if tools::empty(f, "bodies") && shown.len() == 1 => f["bodies"] = json!([shown[0].id]),
        "mirror" => {
            if let Some(datum) = mirror_face(f, doc, s) {
                before.push(datum);
            }
        }
        _ => {}
    }
    Fitted { start, before }
}

/// Owners FundaCAD 1's patternSources could repeat: a hole, or a cut or join, which a features pattern writes instead
/// of the bodies. A face of anything else patterns its body.
fn patternable(f: &Value) -> bool {
    let op = f.get("mode").and_then(Value::as_str).filter(|m| *m != "auto").or(f.get("operation").and_then(Value::as_str));
    match f.get("type").and_then(Value::as_str) {
        Some("hole") => true,
        Some("extrude" | "revolve" | "sweep" | "loft" | "press-pull") => matches!(op, Some("cut" | "join")),
        Some("patternRect" | "patternLinear" | "patternCircular") => !tools::empty(f, "features"),
        _ => false,
    }
}

fn pattern(f: &mut Value, doc: &Doc, s: &Selection, shown: &[Arc<Body>]) {
    let mut owners: Vec<String> = Vec::new();
    for p in &s.picks {
        let Pick::Face { body, face, .. } = p else { continue };
        let Some(owner) = owner(shown, body, *face) else { continue };
        if !owners.contains(&owner) && tools::feature(doc, &owner).is_some_and(patternable) {
            owners.push(owner);
        }
    }
    owners.sort_by_key(|o| tools::index_of(doc, o));
    let extent = if owners.is_empty() {
        let named: Vec<String> = f.get("bodies").and_then(Value::as_array).map_or_else(Vec::new, |a| {
            a.iter().filter_map(Value::as_str).map(str::to_string).collect()
        });
        let reached: Vec<&Body> = match named.is_empty() {
            true => shown.last().map(|b| &**b).into_iter().collect(),
            false => shown.iter().filter(|b| named.contains(&b.id)).map(|b| &**b).collect(),
        };
        extent(&reached, None)
    } else {
        let obj = f.as_object_mut().expect("an object");
        obj.remove("bodies");
        obj.insert("features".into(), json!(owners));
        extent(&shown.iter().map(|b| &**b).collect::<Vec<_>>(), Some(&owners))
    };
    let span = |axis: usize| {
        extent.map(|(lo, hi)| ((hi[axis] - lo[axis]) as f64 * 100.0).round() / 100.0).filter(|d| *d > 0.0).unwrap_or(SPACING)
    };
    match f.get("type").and_then(Value::as_str) {
        Some("patternLinear") => f["spacing"] = json!(span(0)),
        Some("patternRect") => {
            f["spacingX"] = json!(span(0));
            f["spacingY"] = json!(span(1));
        }
        _ => {}
    }
}

fn owner(shown: &[Arc<Body>], body: &str, face: u32) -> Option<String> {
    shown.iter().find(|b| b.id == body)?.face_owners.get(face as usize)?.clone()
}

/// The box around the bodies' triangles, only those of faces `owners` made when given.
fn extent(bodies: &[&Body], owners: Option<&[String]>) -> Option<([f32; 3], [f32; 3])> {
    let mut out: Option<([f32; 3], [f32; 3])> = None;
    for b in bodies {
        for (t, tri) in b.indices.chunks_exact(3).enumerate() {
            if let Some(want) = owners {
                let face = b.face_ids.get(t).copied().unwrap_or(t as u32) as usize;
                let made = b.face_owners.get(face).and_then(Option::as_deref);
                if !made.is_some_and(|m| want.iter().any(|w| w == m)) {
                    continue;
                }
            }
            for &v in tri {
                let i = v as usize * 3;
                let Some(p) = b.positions.get(i..i + 3) else { continue };
                let (lo, hi) = out.get_or_insert(([p[0], p[1], p[2]], [p[0], p[1], p[2]]));
                for k in 0..3 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
        }
    }
    out
}

/// FundaCAD 1 mirrored about a picked flat face through a "Mirror plane" datum that follows the face, the mirror
/// naming the datum. A world or datum plane picked as well wins.
fn mirror_face(f: &mut Value, doc: &Doc, s: &Selection) -> Option<Value> {
    if s.picks.iter().any(|p| matches!(p, Pick::Plane { .. })) {
        return None;
    }
    let p = s.picks.iter().find(|p| matches!(p, Pick::Face { .. }))?;
    let Pick::Face { point, normal, .. } = p else { return None };
    let mut after = doc.clone();
    insert(&mut after, f.clone()).ok()?;
    let id = next_id(&after);
    f["plane"] = match f.get("bodies") {
        Some(_) => json!({"name": id}),
        None => json!(id),
    };
    Some(json!({"id": id, "type": "datumPlane", "plane": plane_def(*point, *normal), "offset": 0, "name": "Mirror plane",
        "face": p.selector(), "at": round(*point)}))
}
