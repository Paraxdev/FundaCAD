//! The plane or axis a Split, Mirror or Circular Pattern takes from a click once it runs, as FundaCAD 1's
//! pickPlaneInteractive and pattern axis pick: a flat face or a plane to cut or mirror by, an edge or face to turn about.

#[cfg(test)]
mod tests;

use glam::Vec3;
use serde_json::{json, Map, Value};

use super::super::{plane_def, round, spot};
use crate::selection::{Pick, PickKind, Selection};
use crate::tools::{next_id, Doc, Target};

pub const PLANE: Target = Target { field: "plane", kind: PickKind::Plane, many: false };
pub const AXIS: Target = Target { field: "axisRef", kind: PickKind::Edge, many: false };

/// The pick a tool waits for when the selection gave it no plane or axis. It is not needed: OK keeps the default.
pub fn offer(tool: &str, s: &Selection) -> Option<Target> {
    let has = |f: fn(&Pick) -> bool| s.picks.iter().any(f);
    match tool {
        "split" | "mirror" if !has(|p| matches!(p, Pick::Face { .. } | Pick::Plane { .. })) => Some(PLANE),
        "pattern-circular" if !has(|p| matches!(p, Pick::Face { .. } | Pick::Edge { .. })) => Some(AXIS),
        _ => None,
    }
}

/// Whether a click for `field` goes through `place`.
pub fn places(arm: &Target) -> bool {
    arm.kind == PickKind::Plane || arm.field == "axisRef"
}

/// What a click on `pick` puts in `field` of the feature `id`, after any other edit it makes: a split drops its
/// datum, a mirror about a face gets a "Mirror plane" datum before it, a circular axis falls back on the line
/// through the pick. `line` is the picked edge's polyline.
pub fn place(doc: &mut Doc, id: &str, field: &str, pick: &Pick, line: Option<&[Vec3]>) -> Result<Value, String> {
    let list = doc.get("features").and_then(Value::as_array).ok_or("the document has no features")?;
    let at = list.iter().position(|f| f.get("id").and_then(Value::as_str) == Some(id));
    let at = at.ok_or_else(|| format!("the document has no feature {id}"))?;
    let ty = list[at].get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let named = list[at].get("bodies").is_some();
    let datum = next_id(doc);
    let list = doc.get_mut("features").and_then(Value::as_array_mut).expect("found above");
    let f = list[at].as_object_mut().ok_or("the feature is not an object")?;
    match (ty.as_str(), field, pick) {
        ("split", "plane", Pick::Face { point, normal, .. }) => {
            f.remove("planeId");
            f.remove("offset");
            Ok(plane_def(*point, *normal))
        }
        ("mirror", "plane", Pick::Face { point, normal, .. }) => {
            let mut d = Map::new();
            d.insert("id".into(), json!(datum));
            d.extend(
                json!({"type": "datumPlane", "plane": plane_def(*point, *normal), "offset": 0, "name": "Mirror plane",
                    "face": pick.selector(), "at": round(*point)})
                .as_object()
                .cloned()
                .unwrap_or_default(),
            );
            list.insert(at, Value::Object(d));
            Ok(if named { json!({"name": datum}) } else { json!(datum) })
        }
        ("patternCircular", "axisRef", Pick::Face { .. } | Pick::Edge { .. }) => {
            let (origin, dir) = axis_line(pick, line);
            f.insert("axis".into(), json!({"origin": round(origin), "dir": round(dir)}));
            pick.selector().ok_or_else(|| crate::i18n::t("tool.place.cannotPick"))
        }
        (_, "plane", _) => Err(crate::i18n::t("tool.place.flatFace")),
        _ => Err(crate::i18n::t("tool.place.edgeOrFace")),
    }
}

/// The line a circular pattern turns about when its picked edge or face cannot be found: a straight edge itself,
/// the middle and normal of a closed one (a circle), a face's normal through the pick.
pub fn axis_line(pick: &Pick, line: Option<&[Vec3]>) -> ([f32; 3], [f32; 3]) {
    let at = spot(pick);
    let fallback = match pick {
        Pick::Face { normal, .. } => *normal,
        Pick::Edge { dir: Some(dir), .. } => super::canonical_dir(*dir),
        _ => [0.0, 0.0, 1.0],
    };
    let Some(pts) = line.filter(|l| l.len() >= 2) else { return (at, fallback) };
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    let span = pts.iter().fold(0.0f32, |m, p| m.max(p.distance(first)));
    if last.distance(first) > span * 1e-3 {
        return (at, super::canonical_dir((last - first).to_array()));
    }
    let ring = if first.distance(last) < 1e-6 { &pts[..pts.len() - 1] } else { pts };
    let mid = ring.iter().copied().sum::<Vec3>() / ring.len() as f32;
    let mut n = Vec3::ZERO;
    for (i, a) in ring.iter().enumerate() {
        let b = ring[(i + 1) % ring.len()];
        n += (*a - mid).cross(b - mid);
    }
    match n.length() > 1e-9 {
        true => (mid.to_array(), super::canonical_dir(n.to_array())),
        false => (at, fallback),
    }
}
