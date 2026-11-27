//! The Modify tools, FundaCAD 1's draft, face offset, split, pattern, mirror, move and scale starters.

pub mod fit;
pub mod keys;
pub mod place;
#[cfg(test)]
mod tests;

use serde_json::{json, Value};

use super::{plane_def, round, selectors, spot};
use crate::selection::{Pick, PickKind, Selection};
use crate::tools::{bodies, Doc, Start, Target};

const FACES: Target = Target { field: "faces", kind: PickKind::Face, many: true };
const WORLD: [&str; 3] = ["XY", "XZ", "YZ"];

fn start(feature: Value, need: Vec<Target>) -> Result<Start, String> {
    Ok(Start { feature, need })
}

/// `bodies` only when the selection names some, an absent list means the active body.
fn with_bodies(mut f: Value, ids: Vec<String>) -> Value {
    if !ids.is_empty() {
        f["bodies"] = json!(ids);
    }
    f
}

/// draftMath's pullAxisFor: the world axis the face normal leans on least.
pub fn pull_axis(n: [f32; 3]) -> &'static str {
    let [x, y, z] = n.map(f32::abs);
    if x <= y && x <= z {
        "X"
    } else if y <= z {
        "Y"
    } else {
        "Z"
    }
}

fn first_normal(s: &Selection) -> Option<[f32; 3]> {
    s.picks.iter().find_map(|p| match p {
        Pick::Face { normal, .. } => Some(*normal),
        _ => None,
    })
}

pub fn draft(_: &Doc, s: &Selection) -> Result<Start, String> {
    let axis = first_normal(s).map_or("Z", pull_axis);
    start(json!({"type": "draft", "faces": selectors(s, PickKind::Face), "angle": 3, "axis": axis}), vec![FACES])
}

pub fn offset_face(_: &Doc, s: &Selection) -> Result<Start, String> {
    start(json!({"type": "offsetFace", "faces": selectors(s, PickKind::Face), "distance": 1}), vec![FACES])
}

/// The first plane picked cuts: a flat face as its plane, a world plane by name, a datum plane by id, else XY. The
/// bodies it reaches are split, the active body when none is picked.
pub fn split(_: &Doc, s: &Selection) -> Result<Start, String> {
    let mut f = json!({"type": "split", "plane": "XY", "keep": "both", "groupSides": true});
    let cut = s.picks.iter().find(|p| matches!(p, Pick::Face { .. } | Pick::Plane { .. }));
    match cut {
        Some(Pick::Face { point, normal, .. }) => f["plane"] = plane_def(*point, *normal),
        Some(Pick::Plane { id }) if WORLD.contains(&id.as_str()) => f["plane"] = json!(id),
        Some(Pick::Plane { id }) => {
            f.as_object_mut().expect("an object").remove("plane");
            f["planeId"] = json!(id);
        }
        _ => {}
    }
    start(with_bodies(f, bodies(s)), Vec::new())
}

pub fn pattern_linear(_: &Doc, s: &Selection) -> Result<Start, String> {
    let f = json!({"type": "patternLinear", "count": 4, "spacing": 20, "axis": "X"});
    start(with_bodies(f, bodies(s)), Vec::new())
}

/// About Z through the origin, or about the first edge or face picked, which `axisRef` follows with the picked spot
/// as the line it falls back on. A straight edge lends its own direction, a curved one Z.
pub fn pattern_circular(_: &Doc, s: &Selection) -> Result<Start, String> {
    let mut f = json!({"type": "patternCircular", "count": 4, "angle": 360, "axis": "Z"});
    let about = s.picks.iter().find(|p| matches!(p, Pick::Face { .. } | Pick::Edge { .. }));
    let picked: Vec<String> = s.of(PickKind::Body).into_iter().filter_map(Pick::body).map(str::to_string).collect();
    if let Some(p) = about {
        let dir = match p {
            Pick::Face { normal, .. } => *normal,
            Pick::Edge { dir: Some(dir), .. } => canonical_dir(*dir),
            _ => [0.0, 0.0, 1.0],
        };
        f["axis"] = json!({"origin": round(spot(p)), "dir": round(dir)});
        f["axisRef"] = p.selector().unwrap_or_default();
    }
    start(with_bodies(f, picked), Vec::new())
}

/// The engine's `canonical` rule, largest component positive, so either way along an edge gives the same axis.
pub fn canonical_dir(d: [f32; 3]) -> [f32; 3] {
    let u = glam::Vec3::from(d).normalize_or_zero();
    if u == glam::Vec3::ZERO {
        return [0.0, 0.0, 1.0];
    }
    let a = u.abs();
    let k = if a.x >= a.y && a.x >= a.z { 0 } else if a.y >= a.z { 1 } else { 2 };
    (if u[k] < 0.0 { -u } else { u }).to_array().map(|c| c + 0.0)
}

pub fn pattern_rect(_: &Doc, s: &Selection) -> Result<Start, String> {
    let f = json!({"type": "patternRect", "countX": 3, "countY": 3, "spacingX": 20, "spacingY": 20});
    start(with_bodies(f, bodies(s)), Vec::new())
}

/// A mirror naming bodies writes its plane as `{name}`, which builds that would read a bare name as a mirror of the
/// active body refuse.
pub fn mirror(_: &Doc, s: &Selection) -> Result<Start, String> {
    let plane = s
        .picks
        .iter()
        .find_map(|p| match p {
            Pick::Plane { id } => Some(id.clone()),
            _ => None,
        })
        .unwrap_or_else(|| "XY".into());
    let ids = bodies(s);
    let plane = if ids.is_empty() { json!(plane) } else { json!({"name": plane}) };
    start(with_bodies(json!({"type": "mirror", "plane": plane}), ids), Vec::new())
}

pub fn move_bodies(_: &Doc, s: &Selection) -> Result<Start, String> {
    start(with_bodies(json!({"type": "move"}), bodies(s)), Vec::new())
}

/// The selected bodies, or the only one there is (`fit`), else a click picks them.
pub fn separate(_: &Doc, s: &Selection) -> Result<Start, String> {
    let need = vec![Target { field: "bodies", kind: PickKind::Body, many: true }];
    start(json!({"type": "separate", "bodies": bodies(s)}), need)
}

pub fn scale(_: &Doc, s: &Selection) -> Result<Start, String> {
    start(with_bodies(json!({"type": "scale", "factor": 1}), bodies(s)), Vec::new())
}
