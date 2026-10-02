//! The `stress` op: a linear static analysis of one body. The document is rebuilt through the
//! warm cache, a copy of the body is meshed (never the live shape, whose stored triangulation
//! the viewport shares), welded into one closed surface that keeps each triangle's face index,
//! filled with tetrahedra (`fem::tetmesh`) and solved on TET10 elements (`fem::solve`). Fixed
//! faces and loaded faces are selectors resolved on that same copy, so their indices are the
//! mesh's face ids. The reply carries the peaks, the balance of applied load and reaction, and
//! the boundary of the volume mesh coloured by von Mises stress for the viewport.
//!
//! Besides fixed faces, a support may be a slider (held along the face normal only) or a pin
//! (a cylindrical face held towards its axis and along it, free to turn), and gravity may pull
//! on the whole body with the material's density.

use std::collections::HashMap;
use std::time::Duration;

use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::{Shape, ShapeType};
use serde_json::{json, Map, Value};

use crate::builder::{Fail, FeatureError, Watch};
use crate::export;
use crate::fem::solve::{
    self, Axis, Hold, Load, LoadKind, Problem, SlideFace, Solution, SolveError, Support,
};
use crate::fem::tetmesh::{self, MeshError};
use crate::fem::{MeshOptions, MeshStats, SurfaceMesh, TetMesh};
use crate::kernel::{self, Kind};
use crate::mesh::{tessellate, MeshParams};
use crate::select::entity::py_round;
use crate::select::Resolver;

/// Elements a mesh may have when the request names no limit.
pub const DEFAULT_MAX_ELEMENTS: usize = 30_000;
/// The most elements any request gets. The solver needs about 2 GB at 50000 elements and
/// its factorisation may take 3 GB, so a compact part rarely fits above about 50000, while
/// a slender or thin walled one can go further.
pub const MAX_ELEMENTS: usize = 80_000;
/// The default element size aims at this share of the element limit, so the mesh lands near
/// it without the mesher having to coarsen.
const DEFAULT_FILL: f64 = 0.7;
/// Tetrahedra per element size cubed of the mesher's lattice, with its allowance for the
/// stencils that split boundary cells (`tetmesh` TETS_PER_CELL x BOUNDARY_ALLOWANCE).
const TETS_PER_SIZE_CUBED: f64 = 12.0 * 1.15;
/// The surface the mesher fills is triangulated this much finer than the elements.
const SURFACE_DEFLECTION: f64 = 0.02;
const SURFACE_ANGLE: f64 = 0.25;
/// Two faces folding inward by more than this, in degrees, make a sharp inside corner.
const SHARP_FOLD_DEG: f64 = 30.0;
/// A peak this many element sizes from a sharp inside corner is at that corner.
const CORNER_REACH: f64 = 1.5;
/// How long the factorisation may keep the job's heartbeat going. `FACTOR_MEMORY_CAP` bounds
/// it to well under a minute, so this only stops beats for a call that is truly stuck.
const FACTOR_BEATS: Duration = Duration::from_secs(600);

/// Standard gravity in m/s2, what `gravity: true` pulls with along -Z.
pub const STANDARD_GRAVITY: f64 = 9.81;

/// A material for the analysis: Young's modulus and yield strength in MPa, density in g/cm3.
#[derive(Debug, Clone, PartialEq)]
pub struct Material {
    pub name: String,
    pub e: f64,
    pub nu: f64,
    pub yield_strength: Option<f64>,
    pub density: Option<f64>,
    /// Usually 3D printed, so weaker across its layers than these bulk values say.
    pub printed: bool,
}

/// (name, other spellings, E, nu, yield, density, printed). The app mirrors the names and
/// values.
#[allow(clippy::type_complexity)]
const PRESETS: [(&str, &[&str], f64, f64, f64, f64, bool); 8] = [
    ("PLA", &[], 3500.0, 0.36, 50.0, 1.24, true),
    ("PETG", &[], 2100.0, 0.38, 50.0, 1.27, true),
    ("ABS", &[], 2200.0, 0.35, 40.0, 1.04, true),
    ("ASA", &[], 2200.0, 0.35, 45.0, 1.07, true),
    (
        "PA12 nylon",
        &["PA12", "nylon", "PA"],
        1700.0,
        0.40,
        45.0,
        1.01,
        true,
    ),
    ("PC", &["polycarbonate"], 2400.0, 0.37, 60.0, 1.20, true),
    (
        "aluminium 6061-T6",
        &[
            "aluminium",
            "aluminum",
            "aluminum 6061-T6",
            "6061",
            "6061-T6",
        ],
        69000.0,
        0.33,
        275.0,
        2.70,
        false,
    ),
    (
        "steel S235",
        &["steel", "S235"],
        210000.0,
        0.30,
        235.0,
        7.85,
        false,
    ),
];

/// The preset called `name`, ignoring case.
pub fn preset(name: &str) -> Option<Material> {
    let want = name.trim().to_lowercase();
    PRESETS
        .iter()
        .find(|(n, alt, ..)| {
            n.to_lowercase() == want || alt.iter().any(|a| a.to_lowercase() == want)
        })
        .map(|&(n, _, e, nu, y, density, printed)| Material {
            name: n.to_string(),
            e,
            nu,
            yield_strength: Some(y),
            density: Some(density),
            printed,
        })
}

fn preset_names() -> String {
    PRESETS.iter().map(|p| p.0).collect::<Vec<_>>().join(", ")
}

fn material_of(v: Option<&Value>) -> Result<Material, String> {
    match v {
        None | Some(Value::Null) => Ok(preset("PLA").expect("PLA is a preset")),
        Some(Value::String(s)) => preset(s).ok_or_else(|| {
            format!(
                "there is no material called '{s}', the presets are {}, or give {{E, nu, yield}}",
                preset_names()
            )
        }),
        Some(Value::Object(m)) => {
            let num = |k: &str| m.get(k).and_then(Value::as_f64);
            let e = num("E").ok_or("a custom material needs E, its Young's modulus in MPa")?;
            let nu = num("nu").ok_or("a custom material needs nu, its Poisson's ratio")?;
            if !(e.is_finite() && e > 0.0) {
                return Err(format!("the material's E must be above 0 MPa, got {e}"));
            }
            if !(nu.is_finite() && nu > -1.0 && nu < 0.5) {
                return Err(format!(
                    "the material's nu must be between -1 and 0.5, got {nu}"
                ));
            }
            let yield_strength = match m.get("yield") {
                None | Some(Value::Null) => None,
                Some(y) => match y.as_f64() {
                    Some(y) if y.is_finite() && y > 0.0 => Some(y),
                    _ => {
                        return Err(format!(
                            "the material's yield must be a number above 0 MPa, got {y}"
                        ))
                    }
                },
            };
            let density = match m.get("density") {
                None | Some(Value::Null) => None,
                Some(d) => match d.as_f64() {
                    Some(d) if d.is_finite() && d > 0.0 => Some(d),
                    _ => {
                        return Err(format!(
                            "the material's density must be a number above 0 g/cm3, got {d}"
                        ))
                    }
                },
            };
            let name = m
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("custom")
                .to_string();
            // Polymers sit far below metals; a custom one is most likely printed too.
            Ok(Material {
                name,
                e,
                nu,
                yield_strength,
                density,
                printed: e < 20_000.0,
            })
        }
        Some(other) => Err(format!(
            "material must be a preset name or {{E, nu, yield}}, got {other}"
        )),
    }
}

fn positive(req: &Map<String, Value>, key: &str) -> Result<Option<f64>, String> {
    match req.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(x) if x.is_finite() && x > 0.0 => Ok(Some(x)),
            _ => Err(format!("{key} must be a number above 0, got {v}")),
        },
    }
}

/// Below this, in m/s2 along every axis, a gravity vector pulls on nothing.
const NO_GRAVITY: f64 = 1e-9;

/// What `gravity` asks for, in m/s2: true is standard gravity along -Z. A vector of no length
/// is no gravity, so a request with no load is refused as it is without gravity, rather than
/// solved for nothing.
fn gravity_of(v: Option<&Value>) -> Result<Option<[f64; 3]>, String> {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
        Some(Value::Bool(true)) => Ok(Some([0.0, 0.0, -STANDARD_GRAVITY])),
        Some(g) => vec3_of(g)
            .map(|v| v.iter().any(|c| c.abs() >= NO_GRAVITY).then_some(v))
            .ok_or_else(|| format!("gravity must be true, false or [gx, gy, gz] in m/s2, got {g}")),
    }
}

/// The force per cubic mm, N, that gravity `g` in m/s2 puts on a material of `density` in
/// g/cm3: a g/cm3 is 1e-9 t/mm3 and a m/s2 is 1000 mm/s2, and t mm/s2 is N.
pub fn body_force(density: f64, g: [f64; 3]) -> [f64; 3] {
    g.map(|c| density * 1e-9 * c * 1e3)
}

/// How a support of the request holds its faces.
#[derive(Debug, Clone, PartialEq)]
enum SupportKind {
    Fixed,
    /// One surface per face, in the order of the support's face ids.
    Slider(Vec<SlideFace>),
    /// One axis per face, in the order of the support's face ids.
    Pinned(Vec<Axis>),
}

impl SupportKind {
    /// The word for it, as the panel and the request spell it.
    fn word(&self) -> &'static str {
        match self {
            SupportKind::Fixed => "fixed",
            SupportKind::Slider(_) => "slider",
            SupportKind::Pinned(_) => "pinned",
        }
    }
}

/// The exact surface of face `face` of `shape`, as a slider holds it: a plane, a cylinder,
/// a cone, a sphere, a torus or another surface turned about an axis, with its axis or centre,
/// else a free-form face whose normal the mesh gives.
fn slide_face(shape: &Shape, face: u32) -> SlideFace {
    let Some((kind, o)) = surface_kind(shape, face) else {
        return SlideFace::Mesh;
    };
    let axis = Axis {
        origin: [o[4], o[5], o[6]],
        dir: [o[1], o[2], o[3]],
    };
    match kind {
        0 => SlideFace::Plane(axis.dir),
        1 => SlideFace::Cylinder(axis),
        2 => SlideFace::Cone {
            axis,
            semi_angle: o[7],
        },
        3 => SlideFace::Sphere(axis.origin),
        4 => SlideFace::Torus { axis, major: o[7] },
        5 => SlideFace::Revolution(axis),
        _ => SlideFace::Mesh,
    }
}

/// The surface kind of face `face` of `shape` and its parameters, as `FQ_surface` gives them:
/// 0 plane, 1 cylinder, 2 cone, 3 sphere, 4 torus, 5 surface of revolution, -1 other.
fn surface_kind(shape: &Shape, face: u32) -> Option<(i32, [f64; 13])> {
    let f = shape.shape_map(ShapeType::Face).get(face as usize + 1)?;
    let mut o = [0.0; 13];
    let kind = opencascade_sys::face_query::FQ_surface(f.raw(), &mut o).ok()?;
    Some((kind, o))
}

/// What a face that is not a cylinder is, in words a person can find it by.
fn not_round_words(kind: Option<i32>) -> &'static str {
    match kind {
        Some(0) => "flat",
        Some(2) => "a cone",
        Some(3) => "a ball",
        Some(4) => "ring-shaped (a torus)",
        _ => "curved but not a cylinder",
    }
}

/// A support or a load as a refusal names it: the panel's words, counted from 1, then where
/// it sits in the request, as an MCP caller wrote it, "support 1 (supports[0])".
fn named(what: &str, list: &str, i: usize) -> String {
    format!("{what} {} ({list}[{i}])", i + 1)
}

/// The request's `supports`, each with its face ids. A missing type is fixed.
fn supports_of(
    shape: &Shape,
    body_id: &str,
    v: Option<&Value>,
) -> Result<Vec<(SupportKind, Vec<u32>)>, String> {
    let list = match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().collect(),
        Some(one) => vec![one],
    };
    let mut out = Vec::with_capacity(list.len());
    for (i, sup) in list.iter().enumerate() {
        let at = named("support", "supports", i);
        let Some(m) = sup.as_object() else {
            return Err(format!(
                "{at} must be {{type, faces}}, a type of fixed, pinned or slider and the faces it holds, got {sup}"
            ));
        };
        let kind = match m.get("type") {
            None | Some(Value::Null) => "fixed",
            Some(Value::String(t)) => t.as_str(),
            Some(other) => {
                return Err(format!(
                    "the type of {at} must be fixed, pinned or slider, got {other}"
                ))
            }
        };
        let Some(faces) = m.get("faces") else {
            return Err(format!("{at} has no faces, give the faces it holds"));
        };
        let check = match kind.trim().to_lowercase().as_str() {
            k @ ("fixed" | "pinned" | "slider") => k.to_string(),
            _ => {
                return Err(format!(
                    "{at} has type '{kind}', a support is fixed, pinned or slider"
                ))
            }
        };
        let faces = face_ids(
            shape,
            body_id,
            faces,
            &format!("support {}", i + 1),
            &format!("supports[{i}].faces"),
        )?;
        let kind = match check.as_str() {
            "fixed" => SupportKind::Fixed,
            "slider" => SupportKind::Slider(faces.iter().map(|&f| slide_face(shape, f)).collect()),
            _ => {
                let mut axes = Vec::with_capacity(faces.len());
                for &f in &faces {
                    let kind = surface_kind(shape, f);
                    match kind {
                        Some((1, o)) => axes.push(Axis {
                            origin: [o[4], o[5], o[6]],
                            dir: [o[1], o[2], o[3]],
                        }),
                        _ => {
                            // The face ids mean nothing to a person, so the face is told by
                            // what it is.
                            let which = if faces.len() == 1 {
                                "its face".to_string()
                            } else {
                                format!("one of its {} faces", faces.len())
                            };
                            return Err(format!(
                                "{at} is pinned, which needs cylindrical faces (a hole or a pin), but {which} is {}, pick the round face of the hole or the pin",
                                not_round_words(kind.map(|k| k.0))
                            ));
                        }
                    }
                }
                SupportKind::Pinned(axes)
            }
        };
        out.push((kind, faces));
    }
    Ok(out)
}

/// A selector or a list of them, as a list.
fn selector_list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Array(a) => a.iter().collect(),
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

fn fail_text(f: &Fail) -> String {
    match f {
        Fail::Value { message, .. } => message.clone(),
        Fail::Missing(k) => format!("'{k}'"),
        Fail::Internal(n) => n.clone(),
    }
}

/// The error reply. A feature that failed may be why the body or a face is not there, so the
/// first failure is named in the message and its feature id goes with it, as the wire carries
/// an error's message and feature id only.
fn refuse(message: &str, errors: &[FeatureError]) -> JobResult {
    match errors.first() {
        None => error_result(message),
        Some(first) => {
            let n = errors.len();
            let which = first
                .feature_id
                .as_deref()
                .map_or(String::new(), |id| format!(" ({id})"));
            let lead = if n == 1 {
                "a feature failed".to_string()
            } else {
                format!("{n} features failed")
            };
            let mut error = json!({"message": format!(
                "{message}, note that {lead}, the first{which}: {}",
                first.message
            )});
            if let Some(id) = &first.feature_id {
                error["feature_id"] = json!(id);
            }
            let mut m = Map::new();
            m.insert("error".into(), error);
            JobResult::Json(m)
        }
    }
}

/// What the face selectors at `path` in the request pick on `shape` (the copy that was meshed),
/// as its mesh face ids. A refusal names them by `words` first when there are any (the panel's
/// "support 1"), then by `path`. A selector that picks nothing is refused rather than ignored.
fn face_ids(
    shape: &Shape,
    body_id: &str,
    sels: &Value,
    words: &str,
    path: &str,
) -> Result<Vec<u32>, String> {
    let label = |path: String| {
        if words.is_empty() {
            path
        } else {
            format!("{words} ({path})")
        }
    };
    let list = selector_list(sels);
    if list.is_empty() {
        return Err(format!("{} names no faces", label(path.to_string())));
    }
    let map = shape.shape_map(ShapeType::Face);
    let mut ids = Vec::new();
    for (i, sel) in list.iter().enumerate() {
        let at = label(if list.len() > 1 || sels.is_array() {
            format!("{path}[{i}]")
        } else {
            path.to_string()
        });
        if let Some(b) = sel.get("body").and_then(Value::as_str) {
            if b != body_id {
                return Err(format!(
                    "{at} picks a face of {b}, not of the body analysed, {body_id}"
                ));
            }
        }
        let faces = Resolver::new(None, None)
            .faces(shape, sel)
            .map_err(|e| format!("{at} could not be resolved, {}", fail_text(&e)))?;
        if faces.is_empty() {
            return Err(format!("{at} matches no face of {body_id}"));
        }
        for f in &faces {
            if let Some(id) = map.index_of(f).checked_sub(1) {
                ids.push(id as u32);
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn vec3_of(v: &Value) -> Option<[f64; 3]> {
    let a = v.as_array().filter(|a| a.len() == 3)?;
    let mut out = [0.0; 3];
    for (slot, x) in out.iter_mut().zip(a) {
        *slot = x.as_f64().filter(|x| x.is_finite())?;
    }
    Some(out)
}

/// The loads, which may be none when gravity is on.
fn loads_of(
    shape: &Shape,
    body_id: &str,
    v: Option<&Value>,
    gravity: bool,
) -> Result<Vec<Load>, String> {
    let list = match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().collect(),
        Some(one) => vec![one],
    };
    if list.is_empty() && !gravity {
        return Err(
            "there is no load, add a force or a pressure on a face, or turn gravity on".into(),
        );
    }
    let mut out = Vec::with_capacity(list.len());
    for (i, l) in list.iter().enumerate() {
        let at = named("load", "loads", i);
        let Some(faces) = l.get("faces") else {
            return Err(format!("{at} has no faces, give the faces it pushes on"));
        };
        let faces = face_ids(
            shape,
            body_id,
            faces,
            &format!("load {}", i + 1),
            &format!("loads[{i}].faces"),
        )?;
        let kind =
            match (l.get("force"), l.get("pressure")) {
                (Some(f), None) => LoadKind::Force(vec3_of(f).ok_or_else(|| {
                    format!("the force of {at} must be three numbers in N, got {f}")
                })?),
                (None, Some(p)) => {
                    LoadKind::Pressure(p.as_f64().filter(|p| p.is_finite()).ok_or_else(|| {
                        format!("the pressure of {at} must be a number in MPa, got {p}")
                    })?)
                }
                (Some(_), Some(_)) => {
                    return Err(format!("{at} has both a force and a pressure, give one"))
                }
                (None, None) => {
                    return Err(format!(
                        "{at} needs a force [x, y, z] in N or a pressure in MPa"
                    ))
                }
            };
        out.push(Load { faces, kind });
    }
    Ok(out)
}

/// One vertex per position, so the faces that meet share the nodes along their common edge,
/// keeping each triangle's face id. Triangles the weld collapses are dropped with their ids.
/// The export's weld, carrying the face ids along.
pub fn weld(positions: &[f64], indices: &[u32], face_ids: &[u32]) -> SurfaceMesh {
    let (welded, remap) = export::weld_vertices(positions);
    let mut out = SurfaceMesh {
        positions: welded.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect(),
        ..SurfaceMesh::default()
    };
    for (t, &face) in indices.chunks_exact(3).zip(face_ids) {
        if let Some(t) = export::welded_triangle(&remap, t) {
            out.triangles.push(t);
            out.face_ids.push(face);
        }
    }
    out
}

/// Edges not shared by exactly two triangles running opposite ways.
pub fn open_edges(mesh: &SurfaceMesh) -> usize {
    let mut count: HashMap<(u32, u32), i32> = HashMap::new();
    for t in &mesh.triangles {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            // +1 for a -> b with a < b, -1 for the reverse, and a use count in the high bits.
            let (key, sign) = if a < b { ((a, b), 1) } else { ((b, a), -1) };
            *count.entry(key).or_insert(0) += sign + 1000;
        }
    }
    count.values().filter(|&&v| v != 2000).count()
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = dot(a, a).sqrt();
    if n > 0.0 {
        [a[0] / n, a[1] / n, a[2] / n]
    } else {
        a
    }
}

/// Where the peak lies on the boundary of the volume mesh.
struct PeakPlace {
    /// The face with the most boundary area touching the peak node, None for a node inside.
    face: Option<u32>,
    /// How the support holds a face whose edge the peak is at: the node touches both held
    /// and free boundary.
    support_edge: Option<&'static str>,
}

/// The boundary triangles touching TET10 node `node`: a corner node by being one of their
/// corners, a mid-edge node by holding both ends of its edge. `held` lists the faces the
/// supports hold, sorted, each with how it is held.
fn peak_place(
    mesh: &TetMesh,
    sol: &Solution,
    node: u32,
    held: &[(u32, &'static str)],
) -> PeakPlace {
    let ends: Vec<u32> = if (node as usize) < sol.corners {
        vec![node]
    } else {
        sol.edges[node as usize - sol.corners].to_vec()
    };
    let touching: Vec<usize> = (0..mesh.boundary.len())
        .filter(|&t| ends.iter().all(|e| mesh.boundary[t].contains(e)))
        .collect();
    // A node on an edge touches triangles of both faces, the one it lies on mostly.
    let mut areas: Vec<(u32, f64)> = Vec::new();
    for &t in &touching {
        let f = mesh.boundary_face[t];
        let s = triangle_area(&mesh.nodes, &mesh.boundary[t]);
        match areas.iter_mut().find(|(g, _)| *g == f) {
            Some(slot) => slot.1 += dot(s, s).sqrt(),
            None => areas.push((f, dot(s, s).sqrt())),
        }
    }
    areas.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let held_as = |t: usize| {
        held.binary_search_by_key(&mesh.boundary_face[t], |h| h.0)
            .ok()
            .map(|i| held[i].1)
    };
    let free = touching.iter().any(|&t| held_as(t).is_none());
    // A fixed face first, as the one whose edge stress grows most with refinement.
    let mut ways: Vec<&'static str> = touching.iter().filter_map(|&t| held_as(t)).collect();
    ways.sort_by_key(|&w| w != "fixed");
    PeakPlace {
        face: areas.first().map(|a| a.0),
        support_edge: ways.first().copied().filter(|_| free),
    }
}

/// The edges where two faces meet folding inward by more than `SHARP_FOLD_DEG`, as segments.
/// Read on the welded surface, whose triangles follow the exact faces, not on the volume
/// mesh, which rounds and kinks every edge within about an element.
fn inside_corners(surface: &SurfaceMesh) -> Vec<[[f64; 3]; 2]> {
    let mut by_edge: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (i, t) in surface.triangles.iter().enumerate() {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            by_edge.entry((a.min(b), a.max(b))).or_default().push(i);
        }
    }
    let p = |i: u32| surface.positions[i as usize];
    let normal = |t: usize| {
        let [a, b, c] = surface.triangles[t];
        unit(cross(sub(p(b), p(a)), sub(p(c), p(a))))
    };
    let cos_sharp = SHARP_FOLD_DEG.to_radians().cos();
    let mut out = Vec::new();
    for (&(a, b), tris) in &by_edge {
        let &[s, t] = tris.as_slice() else {
            continue;
        };
        if surface.face_ids[s] == surface.face_ids[t] || dot(normal(s), normal(t)) > cos_sharp {
            continue;
        }
        let far = surface.triangles[t]
            .into_iter()
            .find(|&v| v != a && v != b)
            .expect("a triangle has a third corner");
        if dot(normal(s), sub(p(far), p(a))) > 0.0 {
            out.push([p(a), p(b)]);
        }
    }
    out
}

/// The distance from `q` to the segment `s`.
fn segment_distance(q: [f64; 3], s: &[[f64; 3]; 2]) -> f64 {
    let d = sub(s[1], s[0]);
    let len2 = dot(d, d);
    let t = if len2 > 0.0 {
        (dot(sub(q, s[0]), d) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let r = sub(
        q,
        [s[0][0] + t * d[0], s[0][1] + t * d[1], s[0][2] + t * d[2]],
    );
    dot(r, r).sqrt()
}

/// Six places, and never a negative zero.
fn round6(x: f64) -> f64 {
    py_round(x, 6) + 0.0
}

fn r6(x: f64) -> Value {
    json!(round6(x))
}

fn r3(v: [f64; 3]) -> Value {
    json!(v.map(round6))
}

/// The boundary of the volume mesh with its fields, vertices renumbered in order of first use.
fn surface_of(mesh: &TetMesh, sol: &Solution) -> Value {
    let mut new_index = vec![u32::MAX; mesh.nodes.len()];
    let mut used: Vec<u32> = Vec::new();
    let mut indices = Vec::with_capacity(mesh.boundary.len() * 3);
    for tri in &mesh.boundary {
        for &v in tri {
            if new_index[v as usize] == u32::MAX {
                new_index[v as usize] = used.len() as u32;
                used.push(v);
            }
            indices.push(new_index[v as usize]);
        }
    }
    // Rounded, as plenty for a picture and far shorter than every digit of an f64 (an f32
    // goes out widened, so no shorter): positions to 0.1 um, the fields to six places.
    let positions: Vec<f64> = used
        .iter()
        .flat_map(|&v| mesh.nodes[v as usize].map(|x| py_round(x, 4) + 0.0))
        .collect();
    let von_mises: Vec<f64> = used
        .iter()
        .map(|&v| round6(sol.von_mises[v as usize]))
        .collect();
    let displacement: Vec<f64> = used
        .iter()
        .flat_map(|&v| sol.displacement[v as usize].map(round6))
        .collect();
    json!({
        "positions": positions,
        "indices": indices,
        "faceIds": mesh.boundary_face,
        "vonMises": von_mises,
        "displacement": displacement,
    })
}

/// The smallest element size `max_elements` allows for a body of `volume`, as the mesher
/// works it out. A smaller request would only tessellate the surface for a size never used.
pub fn size_floor(volume: f64, max_elements: usize) -> f64 {
    (TETS_PER_SIZE_CUBED * volume / max_elements.max(1) as f64).cbrt()
}

/// The default element size: near `max_elements * DEFAULT_FILL` elements for the body's
/// volume, and at least two elements through its typical thickness `2 V / A`.
pub fn default_size(volume: f64, area: f64, max_elements: usize) -> f64 {
    let target = (max_elements as f64 * DEFAULT_FILL).max(1.0);
    let by_count = (TETS_PER_SIZE_CUBED * volume / target).cbrt();
    let thickness = 2.0 * volume / area;
    if thickness.is_finite() && thickness > 0.0 {
        by_count.min(thickness / 2.0)
    } else {
        by_count
    }
}

fn triangle_area(p: &[[f64; 3]], t: &[u32; 3]) -> [f64; 3] {
    let [a, b, c] = t.map(|i| p[i as usize]);
    cross(sub(b, a), sub(c, a)).map(|x| x / 2.0)
}

/// Pressures that load the faces they name with the force the real faces would take.
/// Isosurface stuffing rounds a sharp edge over within about an element, and each boundary
/// triangle of the rounding goes to one of the two faces, so the elements tagged with a face
/// cover a little more or less than it, at a slant. A pressure on a planar face is the
/// uniform traction `-p n` over its true area, so it becomes that face's own force, exact in
/// size and direction. A pressure on curved faces keeps following the surface, scaled so its
/// size matches their true area. The second list gives the request's load index of each one.
fn exact_pressures(
    loads: Vec<Load>,
    surface: &SurfaceMesh,
    planar: &[bool],
    mesh: &TetMesh,
) -> (Vec<Load>, Vec<usize>) {
    let faces = surface
        .face_ids
        .iter()
        .chain(&mesh.boundary_face)
        .copied()
        .max()
        .map_or(0, |m| m as usize + 1);
    let mut vector = vec![[0.0; 3]; faces];
    let mut area = vec![0.0; faces];
    for (t, &f) in surface.triangles.iter().zip(&surface.face_ids) {
        let s = triangle_area(&surface.positions, t);
        let v = &mut vector[f as usize];
        *v = [v[0] + s[0], v[1] + s[1], v[2] + s[2]];
        area[f as usize] += dot(s, s).sqrt();
    }
    let mut meshed = vec![0.0; faces];
    for (t, &f) in mesh.boundary.iter().zip(&mesh.boundary_face) {
        let s = triangle_area(&mesh.nodes, t);
        meshed[f as usize] += dot(s, s).sqrt();
    }
    let (mut out, mut origin) = (
        Vec::with_capacity(loads.len()),
        Vec::with_capacity(loads.len()),
    );
    for (i, load) in loads.into_iter().enumerate() {
        let LoadKind::Pressure(p) = load.kind else {
            out.push(load);
            origin.push(i);
            continue;
        };
        let (flat, curved): (Vec<u32>, Vec<u32>) = load
            .faces
            .iter()
            .copied()
            .partition(|&f| planar.get(f as usize).copied().unwrap_or(false));
        for f in flat {
            let s = vector[f as usize];
            out.push(Load {
                faces: vec![f],
                kind: LoadKind::Force(s.map(|x| -p * x)),
            });
            origin.push(i);
        }
        if !curved.is_empty() {
            let real: f64 = curved.iter().map(|&f| area[f as usize]).sum();
            let tagged: f64 = curved.iter().map(|&f| meshed[f as usize]).sum();
            let scale = if real > 0.0 && tagged > 0.0 {
                real / tagged
            } else {
                1.0
            };
            out.push(Load {
                faces: curved,
                kind: LoadKind::Pressure(p * scale),
            });
            origin.push(i);
        }
    }
    (out, origin)
}

/// A solver error about a load, pointed back at the load the request numbered.
fn renumber_load(e: SolveError, origin: &[usize]) -> SolveError {
    let back = |l: usize| origin.get(l).copied().unwrap_or(l);
    match e {
        SolveError::EmptyLoad { load } => SolveError::EmptyLoad { load: back(load) },
        SolveError::InvalidLoad { load } => SolveError::InvalidLoad { load: back(load) },
        SolveError::MissingLoadFace { load, face } => SolveError::MissingLoadFace {
            load: back(load),
            face,
        },
        other => other,
    }
}

/// A solver error in words. Too large for the memory names the element limit that would fit
/// a mesh like this one, `elements` being its count: the factor of a solid's mesh grows about
/// as the count to the power 4/3, so the count that fits goes as the memory to the 3/4.
fn solve_error_text(e: &SolveError, elements: usize) -> String {
    match e {
        SolveError::Cancelled => "cancelled".into(),
        SolveError::TooLarge { needed, limit } => {
            let fits = elements as f64 * (*limit as f64 / *needed as f64).powf(0.75) * 0.9;
            let fits = ((fits / 1000.0).floor() as usize).max(1) * 1000;
            format!(
                "solving this mesh of {elements} elements needs about {:.1} GB of memory, more than the {:.1} GB it may use, set maxElements to about {fits} or use a larger size",
                *needed as f64 / 1e9,
                *limit as f64 / 1e9
            )
        }
        other => other.to_string(),
    }
}

fn mesh_error_text(e: &MeshError) -> String {
    match e {
        MeshError::Cancelled => "cancelled".into(),
        other => format!("the body could not be meshed, {other}"),
    }
}

/// The `stress` op.
pub fn stress_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let _beat = crate::heartbeat::install(watch.heartbeat());
    let _cancel = crate::cancel::install(watch.cancel_token());
    let (_, r) = match crate::inspect::rebuild_request(req, watch) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let errors = &r.errors;
    let Some(wanted) = req.get("body").and_then(Value::as_str) else {
        return refuse(
            "name the body to analyse in 'body', by id or by name",
            errors,
        );
    };
    let Some(body) = r
        .bodies
        .iter()
        .find(|b| b.id == wanted)
        .or_else(|| r.bodies.iter().find(|b| b.name == wanted))
    else {
        if r.bodies.is_empty() {
            if let Some(e) = errors.first() {
                let mut m = Map::new();
                m.insert("error".into(), e.wire());
                return JobResult::Json(m);
            }
            return refuse("the document has no bodies to analyse", errors);
        }
        let have: Vec<String> = r
            .bodies
            .iter()
            .map(|b| format!("{} ({})", b.id, b.name))
            .collect();
        return refuse(
            &format!(
                "there is no body '{wanted}', the bodies are {}",
                have.join(", ")
            ),
            errors,
        );
    };
    match analyse(req, &body.id, &body.name, &body.shape, watch) {
        Ok(mut m) => {
            if !errors.is_empty() {
                m.insert(
                    "errors".into(),
                    Value::Array(errors.iter().map(FeatureError::wire).collect()),
                );
            }
            JobResult::Json(m)
        }
        Err(message) => refuse(&message, errors),
    }
}

fn analyse(
    req: &Map<String, Value>,
    id: &str,
    name: &str,
    live: &Shape,
    watch: &dyn Watch,
) -> Result<Map<String, Value>, String> {
    let material = material_of(req.get("material"))?;
    let gravity = gravity_of(req.get("gravity"))?;
    let density = match (gravity, material.density) {
        (None, _) => None,
        (Some(_), Some(d)) => Some(d),
        (Some(_), None) => {
            return Err(
                "gravity needs the material's density in g/cm3, add density to the material or turn gravity off"
                    .into(),
            )
        }
    };
    let size = positive(req, "size")?;
    let mut warnings: Vec<String> = Vec::new();
    let max_elements = match positive(req, "maxElements")? {
        None => DEFAULT_MAX_ELEMENTS,
        Some(n) if n > MAX_ELEMENTS as f64 => {
            warnings.push(format!(
                "maxElements is capped at {MAX_ELEMENTS}, and above about 50000 elements a compact part usually needs more memory than the solver may use"
            ));
            MAX_ELEMENTS
        }
        Some(n) => (n.trunc() as usize).max(1),
    };

    let solids = kernel::count(live, Kind::Solid);
    if solids == 0 {
        return Err(format!("{id} is not a solid, it has no volume to analyse"));
    }
    if solids > 1 {
        return Err(format!(
            "{id} is {solids} separate solids, the analysis takes one solid, split it into bodies or join the pieces"
        ));
    }
    let open = kernel::open_edge_count(live);
    if open > 0 {
        return Err(format!(
            "{id} is not closed, {open} of its edges bound only one face, so it has no inside to analyse"
        ));
    }
    let shape =
        kernel::copy(live).map_err(|e| format!("{id} could not be copied for meshing, {e}"))?;
    let volume = kernel::volume(&shape).abs();
    let area = kernel::area(&shape).abs();
    if !(volume > 0.0 && area > 0.0) {
        return Err(format!("{id} encloses no volume"));
    }
    let thickness = 2.0 * volume / area;

    let fixed_sel = req.get("fixed").unwrap_or(&Value::Null);
    let has_supports = selector_list(req.get("supports").unwrap_or(&Value::Null))
        .iter()
        .any(|s| !s.is_null());
    if selector_list(fixed_sel).is_empty() && !has_supports {
        return Err(
            "no face is fixed, fix at least one face or add a support (fixed, pinned or slider) so the body is held"
                .into(),
        );
    }
    let given_fixed = if selector_list(fixed_sel).is_empty() {
        Vec::new()
    } else {
        face_ids(&shape, id, fixed_sel, "", "fixed")?
    };
    let supports = supports_of(&shape, id, req.get("supports"))?;
    // Every face held in all three directions, by `fixed` or a fixed support.
    let mut fixed = given_fixed.clone();
    // Every face any support holds, with how the first support to name it holds it.
    let mut held: Vec<(u32, &'static str)> = given_fixed.iter().map(|&f| (f, "fixed")).collect();
    for (kind, faces) in &supports {
        if *kind == SupportKind::Fixed {
            fixed.extend(faces);
        }
        held.extend(faces.iter().map(|&f| (f, kind.word())));
    }
    fixed.sort_unstable();
    fixed.dedup();
    // A fixed face holds most, so it names the face whatever else holds it.
    held.sort_by_key(|&(f, word)| (f, word != "fixed"));
    held.dedup_by_key(|h| h.0);
    let loads = loads_of(&shape, id, req.get("loads"), gravity.is_some())?;
    // A fixed face does not move, so a load only on fixed faces goes straight into the
    // fixture and does nothing to the part.
    let dead: Vec<usize> = (0..loads.len())
        .filter(|&i| {
            loads[i]
                .faces
                .iter()
                .all(|f| fixed.binary_search(f).is_ok())
        })
        .collect();
    if dead.len() == loads.len() && gravity.is_none() {
        return Err(if loads.len() == 1 {
            "the load is only on fixed faces, a fixed face does not move, so the load pushes on the fixture and not the part, load a face that is not fixed".into()
        } else {
            "every load is only on fixed faces, a fixed face does not move, so the loads push on the fixture and not the part, load a face that is not fixed".into()
        });
    }
    for i in dead {
        warnings.push(format!(
            "{} is only on fixed faces, so it pushes on the fixture and does nothing to the part",
            named("load", "loads", i)
        ));
    }

    let requested = size.unwrap_or_else(|| default_size(volume, area, max_elements));
    // The mesher would grow a size below the floor anyway, and the surface it fills is
    // triangulated for the size used: a curved part tessellated for a far smaller one takes
    // minutes and gigabytes for nothing.
    let effective = requested.max(size_floor(volume, max_elements));
    let deflection = (effective * SURFACE_DEFLECTION).clamp(1e-3, 0.2);
    let (surface, planar) = crate::heartbeat::while_running(Duration::from_secs(120), || {
        let access = MeshAccess::new(&shape);
        let t = tessellate(
            &shape,
            &access,
            MeshParams {
                linear: deflection,
                angular: SURFACE_ANGLE,
                relative: false,
                display: false,
                force_remesh: true,
            },
        );
        let planar: Vec<bool> = (0..access.face_count())
            .map(|f| access.face_plane_normal(f).is_some())
            .collect();
        (weld(&t.positions, &t.indices, &t.face_ids), planar)
    });
    if surface.triangles.is_empty() {
        return Err(format!("{id} could not be triangulated"));
    }
    let open = open_edges(&surface);
    if open > 0 {
        return Err(format!(
            "the surface of {id} does not close once triangulated, {open} of its mesh edges are open, so it has no inside to fill"
        ));
    }

    let mut tick = || {
        crate::heartbeat::beat();
        !(watch.cancelled() || crate::cancel::requested())
    };
    let (mesh, stats): (TetMesh, MeshStats) = tetmesh::tetrahedralize(
        &surface,
        &MeshOptions {
            size: effective,
            max_tets: max_elements,
        },
        &mut tick,
    )
    .map_err(|e| mesh_error_text(&e))?;

    let (loads, origin) = exact_pressures(loads, &surface, &planar, &mesh);
    let supports: Vec<Support> = supports
        .into_iter()
        .map(|(kind, faces)| Support {
            hold: match kind {
                SupportKind::Fixed => Hold::Fixed,
                SupportKind::Slider(surfaces) => Hold::Slider(surfaces),
                SupportKind::Pinned(axes) => Hold::Pinned(axes),
            },
            faces,
        })
        .collect();
    let problem = Problem {
        mesh: &mesh,
        material: solve::Material {
            e: material.e,
            nu: material.nu,
        },
        fixed: given_fixed,
        supports,
        loads,
        // Scaled by the body's true volume over the mesh's, which rounds its edges over
        // within about an element, so the weight is what the real body weighs, as the
        // pressures above are what the real faces take.
        body_force: gravity.zip(density).map(|(g, d)| {
            let scale = if stats.volume > 0.0 {
                volume / stats.volume
            } else {
                1.0
            };
            body_force(d, g).map(|c| c * scale)
        }),
    };
    let sol = solve::solve_with(&problem, &mut tick, &mut |f| {
        crate::heartbeat::while_running(FACTOR_BEATS, f)
    })
    .map_err(|e| solve_error_text(&renumber_load(e, &origin), mesh.tets.len()))?;

    // Warnings, most telling first.
    let bb = kernel::bbox(&shape).unwrap_or([0.0; 6]);
    let smallest = (0..3)
        .map(|k| bb[k + 3] - bb[k])
        .fold(f64::INFINITY, f64::min);
    if smallest.is_finite() && sol.max_displacement > smallest / 10.0 {
        warnings.push(format!(
            "the largest deflection, {:.3} mm, is more than a tenth of the part's smallest size ({:.3} mm), a linear analysis is not trustworthy for deflection this large",
            sol.max_displacement, smallest
        ));
    }
    let peak = sol.max_von_mises;
    let peak_at = sol.nodes[sol.max_von_mises_node as usize];
    let place = peak_place(&mesh, &sol, sol.max_von_mises_node, &held);
    let at_inside_corner = inside_corners(&surface)
        .iter()
        .any(|s| segment_distance(peak_at, s) <= CORNER_REACH * stats.size);
    if peak > 0.0 && (at_inside_corner || place.support_edge.is_some()) {
        let spot = match place.support_edge {
            Some(word) if !at_inside_corner => format!("where a {word} face ends"),
            _ => "at a sharp inside corner".to_string(),
        };
        warnings.push(format!(
            "the peak stress is {spot}, stress at a sharp inside corner or where a support ends grows as the mesh is refined, look at the colour away from it"
        ));
    }
    if stats.size > thickness / 2.0 * 1.0001 {
        warnings.push(format!(
            "the elements ({:.3} mm) are larger than half the part's typical thickness (2 V / A, {:.3} mm), so its thinnest walls may have fewer than 2 elements through them and read stiffer than they are, use a smaller size or allow more elements",
            stats.size, thickness
        ));
    }
    if stats.size > requested * 1.0001 {
        warnings.push(format!(
            "the element size grew from {requested:.3} mm to {:.3} mm to stay within {max_elements} elements, allow more elements for a finer mesh",
            stats.size
        ));
    }
    if !sol.missing_fixed.is_empty() {
        let n = sol.missing_fixed.len();
        let which = if has_supports { "held" } else { "fixed" };
        warnings.push(format!(
            "{n} of the {which} faces got no elements, they are narrower than the element size and hold nothing"
        ));
    }
    if material.printed {
        warnings.push(
            "printed parts are weaker across their layers than these bulk values, often by half, so keep a margin when the load pulls the layers apart"
                .into(),
        );
    }

    let disp_node = sol.max_displacement_node as usize;
    let mut out = Map::new();
    out.insert("body".into(), json!(id));
    out.insert("name".into(), json!(name));
    let mut mat = json!({"name": material.name, "E": material.e, "nu": material.nu});
    mat["yield"] = material.yield_strength.map_or(Value::Null, |y| json!(y));
    mat["density"] = material.density.map_or(Value::Null, |d| json!(d));
    out.insert("material".into(), mat);
    out.insert(
        "mesh".into(),
        json!({
            "nodes": sol.nodes.len(),
            "elements": sol.elements,
            "size": py_round(stats.size, 4),
            "minDihedral": py_round(stats.min_dihedral_deg, 1),
        }),
    );
    out.insert(
        "maxVonMises".into(),
        json!({"value": r6(peak), "at": r3(peak_at), "face": place.face}),
    );
    out.insert(
        "maxDisplacement".into(),
        json!({
            "value": r6(sol.max_displacement),
            "at": r3(sol.nodes[disp_node]),
            "vector": r3(sol.displacement[disp_node]),
        }),
    );
    let safety = material
        .yield_strength
        .filter(|_| peak > 0.0)
        .map(|y| y / peak);
    out.insert("safetyFactor".into(), safety.map_or(Value::Null, |s| r6(s)));
    out.insert("applied".into(), r3(sol.applied));
    out.insert("weight".into(), sol.weight.map_or(Value::Null, r3));
    out.insert("reaction".into(), r3(sol.reaction));
    out.insert(
        "reactions".into(),
        Value::Array(sol.reactions.iter().map(|&r| r3(r)).collect()),
    );
    out.insert("warnings".into(), json!(warnings));
    out.insert("surface".into(), surface_of(&mesh, &sol));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_ignore_case_and_take_other_spellings() {
        assert_eq!(preset("pla").unwrap().e, 3500.0);
        assert_eq!(preset("Nylon").unwrap().name, "PA12 nylon");
        assert_eq!(preset("ALUMINUM").unwrap().name, "aluminium 6061-T6");
        assert_eq!(preset("aluminium").unwrap().yield_strength, Some(275.0));
        assert_eq!(preset(" steel ").unwrap().e, 210000.0);
        assert!(preset("unobtainium").is_none());
        assert!(material_of(Some(&json!("wood")))
            .unwrap_err()
            .contains("PLA, PETG"));
        let custom = material_of(Some(
            &json!({"E": 2000, "nu": 0.3, "yield": 30, "name": "my PETG"}),
        ))
        .unwrap();
        assert_eq!(
            (custom.name.as_str(), custom.e, custom.yield_strength),
            ("my PETG", 2000.0, Some(30.0))
        );
        assert!(material_of(Some(&json!({"E": 2000, "nu": 0.6}))).is_err());
    }

    #[test]
    fn gravity_reads_as_a_force_per_volume_in_newtons() {
        assert_eq!(gravity_of(None), Ok(None));
        assert_eq!(gravity_of(Some(&json!(false))), Ok(None));
        assert_eq!(
            gravity_of(Some(&json!(true))),
            Ok(Some([0.0, 0.0, -STANDARD_GRAVITY]))
        );
        assert_eq!(
            gravity_of(Some(&json!([1, 2, 3]))),
            Ok(Some([1.0, 2.0, 3.0]))
        );
        assert!(gravity_of(Some(&json!([1, 2]))).is_err());
        // A vector of no length pulls nowhere, so it is no gravity.
        assert_eq!(gravity_of(Some(&json!([0, 0, 0]))), Ok(None));
        assert_eq!(gravity_of(Some(&json!([0, -0.0, 1e-300]))), Ok(None));
        // A litre of water, 1 g/cm3 over a million cubic mm, weighs 9.81 N.
        let b = body_force(1.0, [0.0, 0.0, -9.81]);
        assert!((b[2] * 1e6 + 9.81).abs() < 1e-12, "{b:?}");
        assert_eq!(preset("PLA").unwrap().density, Some(1.24));
        assert_eq!(preset("steel").unwrap().density, Some(7.85));
        let custom = material_of(Some(&json!({"E": 2000, "nu": 0.3}))).unwrap();
        assert_eq!(custom.density, None);
        assert!(material_of(Some(&json!({"E": 2000, "nu": 0.3, "density": 0}))).is_err());
    }

    #[test]
    fn the_weld_keeps_face_ids_and_drops_collapsed_triangles() {
        // Two triangles of different faces sharing an edge, given as separate copies, and a
        // sliver that collapses once welded.
        let p = [
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, // face 0
            1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, // face 1
            0.0, 0.0, 0.0, 1e-9, 0.0, 0.0, 0.0, 1.0, 0.0, // face 2, collapses
        ];
        let w = weld(&p, &[0, 1, 2, 3, 4, 5, 6, 7, 8], &[0, 1, 2]);
        assert_eq!(w.positions.len(), 4);
        assert_eq!(w.triangles, vec![[0, 1, 2], [1, 3, 2]]);
        assert_eq!(w.face_ids, vec![0, 1]);
        assert_eq!(open_edges(&w), 4);
    }

    #[test]
    fn a_closed_tetrahedron_has_no_open_edges() {
        let m = SurfaceMesh {
            positions: vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            triangles: vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
            face_ids: vec![0, 1, 2, 3],
        };
        assert_eq!(open_edges(&m), 0);
        let mut flipped = m.clone();
        flipped.triangles[0] = [0, 1, 2];
        assert_eq!(open_edges(&flipped), 3);
    }

    #[test]
    fn the_default_size_follows_the_count_and_the_thickness() {
        // A 100 x 10 x 10 bar: thickness 2V/A = 4.76, the count asks for about 1.9 mm.
        let s = default_size(10_000.0, 4_200.0, DEFAULT_MAX_ELEMENTS);
        assert!(s > 1.5 && s < 2.38, "{s}");
        // A thin plate: the thickness wins.
        let plate = default_size(
            100.0 * 100.0 * 1.0,
            2.0 * 100.0 * 100.0 + 400.0,
            DEFAULT_MAX_ELEMENTS,
        );
        assert!(plate <= 2.0 * 10_000.0 / 20_400.0 / 2.0 + 1e-12, "{plate}");
    }

    #[test]
    fn the_size_floor_is_where_the_element_limit_lands() {
        // A hemisphere of radius 150: a size of 0.05 would triangulate its dome for elements
        // three hundred times smaller than the ones the limit allows.
        let v = 2.0 / 3.0 * std::f64::consts::PI * 150.0f64.powi(3);
        let floor = size_floor(v, DEFAULT_MAX_ELEMENTS);
        assert!(floor > 14.0 && floor < 15.0, "{floor}");
        let count = TETS_PER_SIZE_CUBED * v / floor.powi(3);
        assert!((count - DEFAULT_MAX_ELEMENTS as f64).abs() < 1.0, "{count}");
    }

    #[test]
    fn too_large_for_the_memory_names_a_limit_that_fits() {
        let e = SolveError::TooLarge {
            needed: 3_900_000_000,
            limit: 3_200_000_000,
        };
        let text = solve_error_text(&e, 60_000);
        assert!(
            text.contains("mesh of 60000 elements needs about 3.9 GB")
                && text.contains("set maxElements to about 46000"),
            "{text}"
        );
    }

    #[test]
    fn a_segment_measures_to_its_nearest_point() {
        let s = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]];
        assert_eq!(segment_distance([5.0, 3.0, 4.0], &s), 5.0);
        assert_eq!(segment_distance([-3.0, 4.0, 0.0], &s), 5.0);
        assert_eq!(segment_distance([13.0, 0.0, 4.0], &s), 5.0);
    }
}
