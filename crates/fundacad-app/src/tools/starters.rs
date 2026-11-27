//! What each tool makes, featureStarters.ts with FundaCAD 1's defaults. A tool whose references are several kinds at
//! once (a midplane's two planes, an angled plane's edge and face) reads them from the selection.

mod modify;

pub use modify::fit::{fit, sources_extent, Fitted};
pub use modify::keys::{press, replace};
pub use modify::place::{offer, place, places};

use serde_json::{json, Value};

use super::{bodies, build, Doc, Start, Target, Tool};
use crate::i18n;
use crate::selection::{Pick, PickKind, Selection};

const fn t(id: &'static str, label: &'static str, start: fn(&Doc, &Selection) -> Result<Start, String>) -> Tool {
    Tool { id, label, start }
}

pub const TOOLS: &[Tool] = &[
    t("primitive", "feature.box", |_, _| plain(json!({"type": "box", "length": 20, "width": 20, "height": 20}))),
    t("primitive-box", "feature.box", |_, _| plain(json!({"type": "box", "length": 20, "width": 20, "height": 20}))),
    t("primitive-cylinder", "feature.cylinder", |_, _| plain(json!({"type": "cylinder", "radius": 10, "height": 20}))),
    t("primitive-sphere", "feature.sphere", |_, _| plain(json!({"type": "sphere", "radius": 10}))),
    t("primitive-cone", "feature.cone", |_, _| {
        plain(json!({"type": "cone", "bottomRadius": 10, "topRadius": 0, "height": 20}))
    }),
    t("primitive-torus", "feature.torus", |_, _| plain(json!({"type": "torus", "majorRadius": 15, "minorRadius": 5}))),
    t("boolean-union", "tool.union", |_, s| boolean("union", s)),
    t("boolean-subtract", "tool.subtract", |_, s| boolean("subtract", s)),
    t("boolean-intersect", "tool.intersect", |_, s| boolean("intersect", s)),
    t("fillet", "tool.fillet", |_, s| edged(json!({"type": "fillet", "radius": 2}), s)),
    t("chamfer", "tool.chamfer", |_, s| edged(json!({"type": "chamfer", "distance": 1}), s)),
    t("shell", "tool.shell", |_, s| {
        let faces = selectors(s, PickKind::Face);
        let need = vec![Target { field: "faces", kind: PickKind::Face, many: true }];
        Ok(Start { feature: json!({"type": "shell", "thickness": 2, "faces": faces}), need })
    }),
    t("draft", "tool.draft", modify::draft),
    t("offset-face", "tool.offsetFace", modify::offset_face),
    t("split", "tool.splitBody", modify::split),
    t("separate", "tool.separate", modify::separate),
    t("pattern-linear", "tool.linearPattern", modify::pattern_linear),
    t("pattern-circular", "tool.circularPattern", modify::pattern_circular),
    t("pattern-rect", "tool.rectPattern", modify::pattern_rect),
    t("mirror", "tool.mirror", modify::mirror),
    t("move", "tool.move", modify::move_bodies),
    t("scale", "tool.scale", modify::scale),
    t("extrude", "tool.extrude", build::extrude),
    t("presspull", "tool.pressPull", build::press_pull),
    t("revolve", "tool.revolve", build::revolve),
    t("loft", "tool.loft", build::loft),
    t("sweep", "tool.sweep", build::sweep),
    t("hole", "tool.hole", build::hole),
    t("offset-plane", "tool.offsetPlane", |_, s| datum_plane(s, 10.0, "Offset plane")),
    t("datum-plane", "tool.datumPlane", |_, s| datum_plane(s, 0.0, "Plane")),
    t("midplane", "tool.midplane", |_, s| {
        let [a, b] = two(plane_refs(s), &i18n::t("tool.datum.need.midplane"))?;
        let at = mid_cache(s);
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": at, "name": "Midplane", "through": {"kind": "mid", "a": a, "b": b}}),
            need: Vec::new(),
        })
    }),
    t("plane-normal-edge", "tool.normalToEdge", |_, s| {
        let [edge] = one(selectors(s, PickKind::Edge), &i18n::t("tool.datum.need.normalToEdge"))?;
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": "XY", "name": "Normal plane", "t": 0.5,
                "through": {"kind": "normalToEdge", "edge": edge}}),
            need: Vec::new(),
        })
    }),
    t("plane-two-edges", "tool.planeTwoEdges", |_, s| {
        let [a, b] = two(selectors(s, PickKind::Edge), &i18n::t("tool.datum.need.twoEdges"))?;
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": "XY", "name": "Plane", "through": {"kind": "twoEdges", "a": a, "b": b}}),
            need: Vec::new(),
        })
    }),
    t("plane-angle", "tool.planeAtAngle", |_, s| {
        let words = &i18n::t("tool.datum.need.angle");
        let [edge] = one(selectors(s, PickKind::Edge), words)?;
        let [from] = one(plane_refs(s), words)?;
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": "XY", "name": "Angled plane", "angle": 45,
                "through": {"kind": "angle", "edge": edge, "from": from}}),
            need: Vec::new(),
        })
    }),
    t("plane-points", "tool.planePoints", |_, s| {
        // The engine takes a face's centre, not the spot clicked, so only edge middles can be checked for a line.
        let words = &i18n::t("tool.datum.need.pointEdges");
        let edges: Vec<&Pick> = s.of(PickKind::Edge).into_iter().take(3).collect();
        if edges.len() < 3 {
            return Err(words.into());
        }
        let points = point_refs(&edges);
        let spots: Vec<glam::Vec3> = edges.iter().map(|p| spot(p).into()).collect();
        let n = (spots[1] - spots[0]).cross(spots[2] - spots[0]);
        if n.length() < 1e-6 {
            return Err(i18n::t("tool.datum.need.pointsInLine"));
        }
        let n = n.normalize();
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": plane_def((n * n.dot(spots[0])).to_array(), n.to_array()),
                "name": "Plane", "through": {"kind": "points", "points": points}}),
            need: Vec::new(),
        })
    }),
    t("datum-point", "tool.datumPoint", |_, s| {
        let (point, at) = match s.picks.first() {
            Some(p @ Pick::Face { point, .. }) => (*point, Some(json!({"face": p.selector()}))),
            Some(p @ Pick::Edge { mid, .. }) => (*mid, Some(json!({"edge": p.selector(), "t": 0.5}))),
            _ => ([0.0; 3], None),
        };
        let mut f = json!({"type": "datumPoint", "point": round(point), "name": "Point"});
        if let Some(at) = at {
            f["at"] = at;
        }
        Ok(Start { feature: f, need: Vec::new() })
    }),
    t("datum-axis", "tool.datumAxis", |_, s| {
        // The engine takes a face's centre, not the spot clicked, as for Plane Through Points.
        let on: Vec<&Pick> = s.of(PickKind::Edge).into_iter().take(2).collect();
        let [a, b] = two(point_refs(&on), &i18n::t("tool.datum.need.axisEdges"))?;
        let (pa, pb) = (spot(on[0]), spot(on[1]));
        let dir = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        if dir.iter().all(|c| c.abs() < 1e-6) {
            return Err("Pick two different spots".into());
        }
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": round(pa), "dir": round(dir), "name": "Axis",
                "through": {"kind": "points", "a": a, "b": b}}),
            need: Vec::new(),
        })
    }),
    t("datum-axis-edge", "tool.axisOnEdge", |_, s| {
        let words = &i18n::t("tool.datum.need.axisEdge");
        let [edge] = one(selectors(s, PickKind::Edge), words)?;
        let line = s.of(PickKind::Edge).first().and_then(|p| build::edge_axis(p)).ok_or(words)?;
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": line["origin"], "dir": line["dir"], "axisEdge": edge, "name": "Axis"}),
            need: Vec::new(),
        })
    }),
    t("axis-cylinder", "tool.axisOfCylinder", |_, s| {
        let [face] = one(selectors(s, PickKind::Face), &i18n::t("tool.datum.need.cylinder"))?;
        let at = s.of(PickKind::Face).first().map_or([0.0; 3], |p| spot(p));
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": round(at), "dir": [0, 0, 1], "name": "Axis",
                "through": {"kind": "cylinder", "face": face}}),
            need: Vec::new(),
        })
    }),
    t("axis-planes", "tool.axisTwoPlanes", |_, s| {
        let [a, b] = two(plane_refs(s), &i18n::t("tool.datum.need.planes"))?;
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1], "name": "Axis",
                "through": {"kind": "planes", "a": a, "b": b}}),
            need: Vec::new(),
        })
    }),
];

#[cfg(test)]
pub fn tool(id: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.id == id)
}

fn plain(feature: Value) -> Result<Start, String> {
    Ok(Start { feature, need: Vec::new() })
}

fn round(v: [f32; 3]) -> [f64; 3] {
    v.map(|c| ((c as f64) * 1e4).round() / 1e4 + 0.0)
}

fn spot(p: &Pick) -> [f32; 3] {
    match p {
        Pick::Face { point, .. } => *point,
        Pick::Edge { mid, .. } => *mid,
        _ => [0.0; 3],
    }
}

fn selectors(s: &Selection, kind: PickKind) -> Vec<Value> {
    s.of(kind).into_iter().filter_map(Pick::selector).collect()
}

/// The selection as planes a datum is built from: faces by selector, world and datum planes by name.
fn plane_refs(s: &Selection) -> Vec<Value> {
    s.picks
        .iter()
        .filter_map(|p| match p {
            Pick::Face { .. } => Some(json!({"face": p.selector()})),
            Pick::Plane { id } => Some(json!({"plane": id})),
            _ => None,
        })
        .collect()
}

fn point_refs(picks: &[&Pick]) -> Vec<Value> {
    picks
        .iter()
        .copied()
        .filter_map(|p| match p {
            Pick::Face { .. } => Some(json!({"face": p.selector()})),
            Pick::Edge { .. } => Some(json!({"edge": p.selector(), "t": 0.5})),
            _ => None,
        })
        .collect()
}

fn one(v: Vec<Value>, words: &str) -> Result<[Value; 1], String> {
    <[Value; 1]>::try_from(v).map_err(|_| words.to_string())
}

fn two(mut v: Vec<Value>, words: &str) -> Result<[Value; 2], String> {
    if v.len() < 2 {
        return Err(words.to_string());
    }
    v.truncate(2);
    <[Value; 2]>::try_from(v).map_err(|_| words.to_string())
}

/// The plane halfway between the first two picks, the cache the engine replaces with the real one.
fn mid_cache(s: &Selection) -> Value {
    let faces: Vec<_> = s.picks.iter().filter_map(face_plane).take(2).collect();
    match faces.as_slice() {
        [(a, n), (b, _)] => plane_def([(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0], *n),
        _ => json!("XY"),
    }
}

fn face_plane(p: &Pick) -> Option<([f32; 3], [f32; 3])> {
    match p {
        Pick::Face { point, normal, .. } => Some((*point, *normal)),
        _ => None,
    }
}

/// `{origin, normal, xdir}` with an x direction square to the normal.
pub(super) fn plane_def(origin: [f32; 3], normal: [f32; 3]) -> Value {
    let n = glam::Vec3::from(normal).normalize_or(glam::Vec3::Z);
    let x = if n.z.abs() < 0.9 { glam::Vec3::Z.cross(n) } else { glam::Vec3::X - n * n.x }.normalize();
    json!({"origin": round(origin), "normal": round(n.to_array()), "xdir": round(x.to_array())})
}

fn datum_plane(s: &Selection, offset: f64, name: &str) -> Result<Start, String> {
    let mut f = json!({"type": "datumPlane", "plane": "XY", "offset": offset, "name": name});
    match s.picks.first() {
        Some(p @ Pick::Face { point, normal, .. }) => {
            f["plane"] = plane_def(*point, *normal);
            f["face"] = p.selector().unwrap_or_default();
            f["at"] = json!(round(*point));
        }
        Some(Pick::Plane { id }) if ["XY", "XZ", "YZ"].contains(&id.as_str()) => f["plane"] = json!(id),
        Some(Pick::Plane { id }) => f["planeId"] = json!(id),
        _ => {
            f.as_object_mut().expect("an object").remove("plane");
            return Ok(Start { feature: f, need: vec![build::PLANE] });
        }
    }
    Ok(Start { feature: f, need: Vec::new() })
}

fn edged(mut f: Value, s: &Selection) -> Result<Start, String> {
    let edges = selectors(s, PickKind::Edge);
    f["edges"] = Value::Array(edges);
    Ok(Start { feature: f, need: vec![Target { field: "edges", kind: PickKind::Edge, many: true }] })
}

/// The first body picked is kept, the rest are used, as FundaCAD 1's boolean starters.
fn boolean(op: &str, s: &Selection) -> Result<Start, String> {
    let picked = bodies(s);
    let mut f = json!({"type": "boolean", "operation": op, "tools": []});
    if let Some((target, rest)) = picked.split_first() {
        f["target"] = json!(target);
        f["tools"] = json!(rest);
    }
    let need = vec![
        Target { field: "target", kind: PickKind::Body, many: false },
        Target { field: "tools", kind: PickKind::Body, many: true },
    ];
    Ok(Start { feature: f, need })
}
