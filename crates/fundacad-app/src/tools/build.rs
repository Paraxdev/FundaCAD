//! The tools that build solids, FundaCAD 1's extrudeTool, revolve, loft, sweep and holeTool starters: what each makes
//! from the selection, and what a click on a sketch area or a face spot stores in them.

#[cfg(test)]
mod tests;

use serde_json::{json, Value};

use super::{entries, feature, Doc, Start, Target};
use crate::selection::{Pick, PickKind, Selection};

const REGIONS: Target = Target { field: "regions", kind: PickKind::Area, many: true };
/// A datum plane's plane, which a click on a face or on a drawn plane fills.
pub const PLANE: Target = Target { field: "plane", kind: PickKind::Face, many: false };

/// The features that make no solid of their own.
const NO_SOLID: &[&str] = &["sketch", "datumPlane", "datumAxis", "datumPoint", "parameter", "group"];

/// "new" while nothing before the marker makes a solid, else "join", as FundaCAD 1's plannedOperation with no body.
pub fn operation(doc: &Doc) -> &'static str {
    let features = doc.get("features").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let end = doc.get("rollback").and_then(Value::as_u64).map_or(features.len(), |r| (r as usize).min(features.len()));
    let solid = features[..end].iter().any(|f| {
        let ty = f.get("type").and_then(Value::as_str).unwrap_or("");
        let id = f.get("id").and_then(Value::as_str).unwrap_or("");
        !ty.is_empty() && !NO_SOLID.contains(&ty) && !crate::items::suppressed(doc, id)
    });
    if solid {
        "join"
    } else {
        "new"
    }
}

fn picked_sketch(s: &Selection) -> Option<&str> {
    s.picks.iter().find_map(|p| match p {
        Pick::Sketch { feature } => Some(feature.as_str()),
        _ => None,
    })
}

/// The areas picked, all of the first sketch picked.
fn picked_areas(s: &Selection) -> Option<(String, Vec<Value>)> {
    let sketch = s.picks.iter().find_map(|p| match p {
        Pick::Area { sketch, .. } => Some(sketch.clone()),
        _ => None,
    })?;
    let points = s
        .picks
        .iter()
        .filter_map(|p| match p {
            Pick::Area { sketch: k, point } if *k == sketch => Some(json!(point)),
            _ => None,
        })
        .collect();
    Some((sketch, points))
}

/// The curves a thin wall can follow, FundaCAD 1's WALL_CURVES.
const WALL_CURVES: &[&str] = &["line", "arc", "circle", "rectangle", "polygon", "slot", "projected"];

/// FundaCAD 1's thinExtrudeOf: a wall 2 mm thick along every curve of a sketch with no closed area.
fn thin_wall(doc: &Doc, sketch: &str) -> Option<Value> {
    let curves: Vec<&str> = feature(doc, sketch)?
        .get("entities")?
        .as_array()?
        .iter()
        .filter(|e| e.get("type").and_then(Value::as_str).is_some_and(|t| WALL_CURVES.contains(&t)))
        .filter(|e| e.get("construction") != Some(&Value::Bool(true)))
        .filter_map(|e| e.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()))
        .collect();
    (!curves.is_empty()).then(|| {
        json!({"type": "extrude", "sketch": sketch, "distance": 10, "operation": "new", "thin": true, "curves": curves,
            "thickness": 2, "side": "center"})
    })
}

/// Extrude on a sketch or its areas, a thin wall on a sketch with no closed area, Press/Pull on a face, else an
/// extrude that waits for areas, refused when no sketch has one.
pub fn extrude(doc: &Doc, s: &Selection) -> Result<Start, String> {
    if let Some(face) = s.of(PickKind::Face).first() {
        return press_pull(doc, &Selection { picks: vec![(*face).clone()] });
    }
    let mut f = json!({"type": "extrude", "distance": 10, "operation": operation(doc), "regions": []});
    if let Some((sketch, regions)) = picked_areas(s) {
        f["sketch"] = json!(sketch);
        f["regions"] = json!(regions);
    } else if let Some(sketch) = picked_sketch(s) {
        if crate::sketch::Editor::open(doc, sketch).is_some_and(|e| e.regions().is_empty()) {
            let wall = thin_wall(doc, sketch).ok_or("The sketch has no curve to extrude")?;
            return Ok(Start { feature: wall, need: Vec::new() });
        }
        f["sketch"] = json!(sketch);
        f.as_object_mut().expect("an object").remove("regions");
        return Ok(Start { feature: f, need: Vec::new() });
    } else if crate::sketch::areas::shown(doc, true, None).iter().all(|k| k.areas.is_empty()) {
        return Err("Extrude needs a profile, draw a closed sketch first".into());
    }
    Ok(Start { feature: f, need: vec![REGIONS] })
}

pub fn press_pull(_: &Doc, s: &Selection) -> Result<Start, String> {
    let need = vec![Target { field: "face", kind: PickKind::Face, many: false }];
    let mut f = json!({"type": "press-pull", "distance": 10, "mode": "auto"});
    if let Some(p) = s.of(PickKind::Face).first() {
        f["face"] = p.selector().unwrap_or_default();
        f["body"] = json!(p.body());
    }
    Ok(Start { feature: f, need })
}

/// The sketch's first construction line as a revolve axis in world mm, else the sketch's own Y axis, as Finish &
/// Revolve turns.
pub fn sketch_axis(doc: &Doc, sketch: &str) -> Option<Value> {
    let e = crate::sketch::Editor::open(doc, sketch)?;
    let line = e.solved.entities.iter().filter(|x| e.is_construction(x.id())).find_map(|x| x.as_line_seg());
    let line = line.map(|(a, b)| (glam::DVec2::new(a.x, a.y), glam::DVec2::new(b.x, b.y)));
    let (a, b) = line.filter(|(a, b)| a.distance(*b) > 1e-9).unwrap_or((glam::DVec2::ZERO, glam::DVec2::Y));
    let (o, t) = (e.plane.to_3d(a), e.plane.to_3d(b));
    let r = |v: glam::DVec3| [v.x, v.y, v.z].map(|c| (c * 1e4).round() / 1e4 + 0.0);
    Some(json!({"origin": r(o), "dir": r(t - o)}))
}

/// Revolve about the sketch's construction line or its Y axis, or the straight edge picked with it.
pub fn revolve(doc: &Doc, s: &Selection) -> Result<Start, String> {
    let mut f = json!({"type": "revolve", "axis": "Z", "angle": 360, "operation": operation(doc), "regions": []});
    let mut need = vec![REGIONS];
    if let Some((sketch, regions)) = picked_areas(s) {
        f["sketch"] = json!(sketch);
        f["regions"] = json!(regions);
    } else if let Some(sketch) = picked_sketch(s) {
        f["sketch"] = json!(sketch);
        f.as_object_mut().expect("an object").remove("regions");
        need.clear();
    }
    if let Some(axis) = f.get("sketch").and_then(Value::as_str).and_then(|k| sketch_axis(doc, k)) {
        f["axis"] = axis;
    }
    if let Some(p) = s.of(PickKind::Edge).first().copied() {
        f["axis"] = edge_axis(p).ok_or(STRAIGHT)?;
        f["axisEdge"] = p.selector().unwrap_or_default();
    }
    Ok(Start { feature: f, need })
}

pub const STRAIGHT: &str = "Pick a straight edge for the axis";

/// A straight edge as an `{origin, dir}` line, which the engine keeps as the axis an `axisEdge` caches.
pub fn edge_axis(p: &Pick) -> Option<Value> {
    match p {
        Pick::Edge { mid, dir: Some(dir), .. } => Some(json!({"origin": round(*mid), "dir": round(*dir)})),
        _ => None,
    }
}

pub fn loft(_: &Doc, s: &Selection) -> Result<Start, String> {
    let mut profiles: Vec<Value> = Vec::new();
    for p in &s.picks {
        if let Pick::Area { sketch, point } = p {
            if !profiles.iter().any(|q| q["sketch"] == json!(sketch)) {
                profiles.push(json!({"sketch": sketch, "region": point}));
            }
        }
    }
    let need = vec![Target { field: "profiles", kind: PickKind::Area, many: true }];
    Ok(Start { feature: json!({"type": "loft", "profiles": profiles, "operation": "new"}), need })
}

/// The latest sketch before the marker other than `profile`, an open one first, the path a sweep follows.
fn path_for(doc: &Doc, profile: &str) -> Option<String> {
    let shown = crate::sketch::areas::shown(doc, true, Some(profile));
    let open = shown.iter().rev().find(|s| s.areas.is_empty()).or(shown.last());
    open.map(|s| s.sketch.clone())
}

pub fn sweep(doc: &Doc, s: &Selection) -> Result<Start, String> {
    let mut f = json!({"type": "sweep", "operation": "new"});
    let sketches: Vec<&str> = s
        .picks
        .iter()
        .filter_map(|p| match p {
            Pick::Sketch { feature } | Pick::Area { sketch: feature, .. } => Some(feature.as_str()),
            _ => None,
        })
        .collect();
    if let Some(profile) = sketches.first() {
        f["profile"] = json!(profile);
        let path = sketches.iter().find(|k| *k != profile).map(|k| k.to_string()).or_else(|| path_for(doc, profile));
        if let Some(path) = path {
            f["path"] = json!(path);
        }
    }
    Ok(Start { feature: f, need: vec![Target { field: "profile", kind: PickKind::Area, many: false }] })
}

/// FundaCAD 1's hole defaults: an M3 clearance hole through, one at each spot clicked on the face.
pub fn hole(_: &Doc, s: &Selection) -> Result<Start, String> {
    let mut f = json!({"type": "hole", "holeType": "simple", "standard": "clearance", "size": "M3", "fit": "normal",
        "extent": "through", "depth": 10, "points": []});
    if let Some(p @ Pick::Face { point, .. }) = s.of(PickKind::Face).first().copied() {
        f["face"] = p.selector().unwrap_or_default();
        f["points"] = json!([round(*point)]);
    }
    let need = vec![
        Target { field: "face", kind: PickKind::Face, many: false },
        Target { field: "points", kind: PickKind::Point, many: true },
    ];
    Ok(Start { feature: f, need })
}

/// The point of `held` nearest `at` within `reach`, which a click there drops, as FundaCAD 1's hole pointNear.
pub fn point_near(held: &[Value], at: [f32; 3], reach: f64) -> Option<Value> {
    let d = |e: &Value| {
        let p: Vec<f64> = e.as_array()?.iter().filter_map(Value::as_f64).collect();
        let [x, y, z] = <[f64; 3]>::try_from(p).ok()?;
        Some(((x - at[0] as f64).powi(2) + (y - at[1] as f64).powi(2) + (z - at[2] as f64).powi(2)).sqrt())
    };
    held.iter().filter_map(|e| Some((d(e)?, e))).filter(|(d, _)| *d <= reach).min_by(|a, b| a.0.total_cmp(&b.0)).map(|(_, e)| e.clone())
}

fn round(v: [f32; 3]) -> [f64; 3] {
    v.map(|c| ((c as f64) * 1e4).round() / 1e4 + 0.0)
}

fn ty<'a>(doc: &'a Doc, id: &str) -> &'a str {
    feature(doc, id).and_then(|f| f.get("type")).and_then(Value::as_str).unwrap_or("")
}

fn set(doc: &mut Doc, id: &str, field: &str, value: Value) {
    if let Some(f) = doc
        .get_mut("features")
        .and_then(Value::as_array_mut)
        .and_then(|fs| fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(id)))
    {
        f[field] = value;
    }
}

/// What a click stores in `target` of feature `id`, from the value the pick gave: an area `{sketch, point}` becomes a
/// region point and names the sketch, a loft profile or a sweep's sketch; a spot on a face becomes its point. Writes
/// what the feature needs beside it, and says why a pick does not fit.
pub fn placed(doc: &mut Doc, id: &str, target: Target, value: Value) -> Result<Value, String> {
    if takes_plane(doc, id, target.field) {
        return Ok(plane_placed(doc, id, value));
    }
    match target.kind {
        PickKind::Point => return value.get("point").cloned().ok_or_else(|| "Click on a face".to_string()),
        PickKind::Area => {}
        _ => {
            if ty(doc, id) == "hole" && target.field == "face" && entries(doc, id, "points").is_empty() {
                if let Some(p) = value.get("point").cloned() {
                    set(doc, id, "points", json!([p]));
                }
            }
            return Ok(value);
        }
    }
    let sketch = value.get("sketch").and_then(Value::as_str).ok_or("Click inside a closed sketch area")?.to_string();
    let point = value.get("point").cloned().unwrap_or_default();
    match ty(doc, id).to_string().as_str() {
        "loft" => {
            if entries(doc, id, "profiles").iter().any(|p| p["sketch"] == json!(sketch)) {
                return Err("Pick one profile of each sketch".into());
            }
            Ok(json!({"sketch": sketch, "region": point}))
        }
        "sweep" => {
            let path = feature(doc, id).and_then(|f| f.get("path")).and_then(Value::as_str).map(str::to_string);
            if path.as_deref().is_none_or(|p| p == sketch) {
                match path_for(doc, &sketch) {
                    Some(p) => set(doc, id, "path", json!(p)),
                    None => set(doc, id, "path", Value::Null),
                }
            }
            Ok(json!(sketch))
        }
        kind => {
            let had = feature(doc, id).and_then(|f| f.get("sketch")).and_then(Value::as_str).map(str::to_string);
            if had.as_deref().is_some_and(|h| h != sketch) && !entries(doc, id, target.field).is_empty() {
                return Err("Pick areas of one sketch".into());
            }
            if had.as_deref() != Some(sketch.as_str()) {
                set(doc, id, "sketch", json!(sketch));
                let on_edge = !entries(doc, id, "axisEdge").is_empty();
                if let Some(axis) = (kind == "revolve" && !on_edge).then(|| sketch_axis(doc, &sketch)).flatten() {
                    set(doc, id, "axis", axis);
                }
            }
            Ok(point)
        }
    }
}

/// Whether a click on a drawn plane fills `field`, a datum plane's own plane.
pub fn takes_plane(doc: &Doc, id: &str, field: &str) -> bool {
    ty(doc, id) == "datumPlane" && field == PLANE.field
}

/// A face keeps its selector beside the plane, which after_pick writes from the face. A world plane is the plane, a
/// datum plane is named by planeId, as the starter writes for a plane picked first.
fn plane_placed(doc: &mut Doc, id: &str, value: Value) -> Value {
    for k in ["face", "at", "planeId"] {
        if let Some(f) = doc.get_mut("features").and_then(Value::as_array_mut).and_then(|fs| {
            fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(id)).and_then(Value::as_object_mut)
        }) {
            f.remove(k);
        }
    }
    match value.get("plane").and_then(Value::as_str) {
        Some(world @ ("XY" | "XZ" | "YZ")) => json!(world),
        Some(datum) => {
            set(doc, id, "planeId", json!(datum));
            json!("XY")
        }
        None => {
            set(doc, id, "face", value);
            json!("XY")
        }
    }
}

/// Why `pick` cannot go in `field` before anything is written: a revolve axis edge must be straight.
pub fn fits(doc: &Doc, id: &str, field: &str, pick: &Pick) -> Result<(), String> {
    match (ty(doc, id), field) {
        ("revolve", "axisEdge") if edge_axis(pick).is_none() => Err(STRAIGHT.into()),
        _ => Ok(()),
    }
}

/// What a click writes beside the field it fills: a datum plane on a face takes the face's plane and the spot, as the
/// starter does for a face picked first, and a revolve's axis edge its line.
pub fn after_pick(doc: &mut Doc, id: &str, field: &str, pick: &Pick) {
    match (pick, ty(doc, id), field) {
        (Pick::Face { point, normal, .. }, "datumPlane", "face" | "plane") => {
            let (plane, at) = (super::starters::plane_def(*point, *normal), json!(round(*point)));
            set(doc, id, "plane", plane);
            set(doc, id, "at", at);
        }
        (_, "revolve", "axisEdge") => {
            if let Some(axis) = edge_axis(pick) {
                set(doc, id, "axis", axis);
            }
        }
        _ => {}
    }
}

/// The field a click arms next after `field` was picked, when it is not the next empty one.
pub fn then(doc: &Doc, id: &str, field: &str) -> Option<&'static str> {
    (ty(doc, id) == "hole" && field == "face").then_some("points")
}

/// What OK waits for beyond the needed fields.
pub fn short(doc: &Doc, id: &str) -> Option<String> {
    match ty(doc, id) {
        "loft" if entries(doc, id, "profiles").len() < 2 => Some("Pick two profiles first".into()),
        "sweep" if super::empty(feature(doc, id)?, "path") => Some("Draw a path sketch first".into()),
        _ => None,
    }
}
