//! What each tool makes, featureStarters.ts with FundaCAD 1's defaults. A tool whose references are several kinds at
//! once (a midplane's two planes, an angled plane's edge and face) reads them from the selection.

use serde_json::{json, Value};

use super::{bodies, Doc, Start, Target, Tool};
use crate::selection::{Pick, PickKind, Selection};

const fn t(id: &'static str, label: &'static str, start: fn(&Doc, &Selection) -> Result<Start, String>) -> Tool {
    Tool { id, label, start }
}

pub const TOOLS: &[Tool] = &[
    t("primitive", "Box", |_, _| plain(json!({"type": "box", "length": 20, "width": 20, "height": 20}))),
    t("primitive-box", "Box", |_, _| plain(json!({"type": "box", "length": 20, "width": 20, "height": 20}))),
    t("primitive-cylinder", "Cylinder", |_, _| plain(json!({"type": "cylinder", "radius": 10, "height": 20}))),
    t("primitive-sphere", "Sphere", |_, _| plain(json!({"type": "sphere", "radius": 10}))),
    t("primitive-cone", "Cone", |_, _| {
        plain(json!({"type": "cone", "bottomRadius": 10, "topRadius": 0, "height": 20}))
    }),
    t("primitive-torus", "Torus", |_, _| plain(json!({"type": "torus", "majorRadius": 15, "minorRadius": 5}))),
    t("boolean-union", "Union", |_, s| boolean("union", s)),
    t("boolean-subtract", "Subtract", |_, s| boolean("subtract", s)),
    t("boolean-intersect", "Intersect", |_, s| boolean("intersect", s)),
    t("fillet", "Fillet", |_, s| edged(json!({"type": "fillet", "radius": 2}), s)),
    t("chamfer", "Chamfer", |_, s| edged(json!({"type": "chamfer", "distance": 1}), s)),
    t("shell", "Shell", |_, s| {
        let faces = selectors(s, PickKind::Face);
        let arm = faces.is_empty().then_some(Target { field: "faces", kind: PickKind::Face, many: true });
        Ok(Start { feature: json!({"type": "shell", "thickness": 2, "faces": faces}), arm })
    }),
    t("offset-plane", "Offset Plane", |_, s| datum_plane(s, 10.0, "Offset plane")),
    t("datum-plane", "Datum Plane", |_, s| datum_plane(s, 0.0, "Plane")),
    t("midplane", "Midplane", |_, s| {
        let [a, b] = two(plane_refs(s), "Select two flat faces or planes, then Midplane")?;
        let at = mid_cache(s);
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": at, "name": "Midplane", "through": {"kind": "mid", "a": a, "b": b}}),
            arm: None,
        })
    }),
    t("plane-normal-edge", "Normal to Edge", |_, s| {
        let [edge] = one(selectors(s, PickKind::Edge), "Select an edge, then Normal to Edge")?;
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": "XY", "name": "Normal plane", "t": 0.5,
                "through": {"kind": "normalToEdge", "edge": edge}}),
            arm: None,
        })
    }),
    t("plane-two-edges", "Plane Through Two Edges", |_, s| {
        let [a, b] = two(selectors(s, PickKind::Edge), "Select two edges, then Plane Through Two Edges")?;
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": "XY", "name": "Plane", "through": {"kind": "twoEdges", "a": a, "b": b}}),
            arm: None,
        })
    }),
    t("plane-angle", "Plane at Angle", |_, s| {
        let words = "Select an edge and a flat face or plane, then Plane at Angle";
        let [edge] = one(selectors(s, PickKind::Edge), words)?;
        let [from] = one(plane_refs(s), words)?;
        Ok(Start {
            feature: json!({"type": "datumPlane", "plane": "XY", "name": "Angled plane", "angle": 45,
                "through": {"kind": "angle", "edge": edge, "from": from}}),
            arm: None,
        })
    }),
    t("datum-point", "Datum Point", |_, s| {
        let (point, at) = match s.picks.first() {
            Some(p @ Pick::Face { point, .. }) => (*point, Some(json!({"face": p.selector()}))),
            Some(p @ Pick::Edge { mid, .. }) => (*mid, Some(json!({"edge": p.selector(), "t": 0.5}))),
            _ => ([0.0; 3], None),
        };
        let mut f = json!({"type": "datumPoint", "point": round(point), "name": "Point"});
        if let Some(at) = at {
            f["at"] = at;
        }
        Ok(Start { feature: f, arm: None })
    }),
    t("datum-axis", "Datum Axis", |_, s| {
        let points = point_refs(s);
        let [a, b] = two(points, "Select two faces or edges to run the axis through, then Datum Axis")?;
        let (pa, pb) = (spot(&s.picks[0]), spot(&s.picks[1]));
        let dir = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": round(pa), "dir": round(dir), "name": "Axis",
                "through": {"kind": "points", "a": a, "b": b}}),
            arm: None,
        })
    }),
    t("datum-axis-edge", "Axis on Edge", |_, s| {
        let [edge] = one(selectors(s, PickKind::Edge), "Select a straight edge, then Axis on Edge")?;
        let mid = s.of(PickKind::Edge).first().map_or([0.0; 3], |p| spot(p));
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": round(mid), "dir": [0, 0, 1], "axisEdge": edge, "name": "Axis"}),
            arm: None,
        })
    }),
    t("axis-cylinder", "Axis of Cylinder", |_, s| {
        let [face] = one(selectors(s, PickKind::Face), "Select a round face, then Axis of Cylinder")?;
        let at = s.of(PickKind::Face).first().map_or([0.0; 3], |p| spot(p));
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": round(at), "dir": [0, 0, 1], "name": "Axis",
                "through": {"kind": "cylinder", "face": face}}),
            arm: None,
        })
    }),
    t("axis-planes", "Axis of Two Planes", |_, s| {
        let [a, b] = two(plane_refs(s), "Select two flat faces or planes, then Axis of Two Planes")?;
        Ok(Start {
            feature: json!({"type": "datumAxis", "origin": [0, 0, 0], "dir": [0, 0, 1], "name": "Axis",
                "through": {"kind": "planes", "a": a, "b": b}}),
            arm: None,
        })
    }),
];

pub fn tool(id: &str) -> Option<&'static Tool> {
    TOOLS.iter().find(|t| t.id == id)
}

fn plain(feature: Value) -> Result<Start, String> {
    Ok(Start { feature, arm: None })
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

fn point_refs(s: &Selection) -> Vec<Value> {
    s.picks
        .iter()
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
fn plane_def(origin: [f32; 3], normal: [f32; 3]) -> Value {
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
            return Ok(Start { feature: f, arm: Some(Target { field: "face", kind: PickKind::Face, many: false }) });
        }
    }
    Ok(Start { feature: f, arm: None })
}

fn edged(mut f: Value, s: &Selection) -> Result<Start, String> {
    let edges = selectors(s, PickKind::Edge);
    let arm = edges.is_empty().then_some(Target { field: "edges", kind: PickKind::Edge, many: true });
    f["edges"] = Value::Array(edges);
    Ok(Start { feature: f, arm })
}

/// The first body picked is kept, the rest are used, as FundaCAD 1's boolean starters.
fn boolean(op: &str, s: &Selection) -> Result<Start, String> {
    let picked = bodies(s);
    let mut f = json!({"type": "boolean", "operation": op, "tools": []});
    let arm = match picked.split_first() {
        None => Some(Target { field: "target", kind: PickKind::Body, many: false }),
        Some((target, rest)) => {
            f["target"] = json!(target);
            f["tools"] = json!(rest);
            rest.is_empty().then_some(Target { field: "tools", kind: PickKind::Body, many: true })
        }
    };
    Ok(Start { feature: f, arm })
}
