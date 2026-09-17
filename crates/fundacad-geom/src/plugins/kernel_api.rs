//! The generic kernel behind `wit/plugin.wit`'s `kernel` interface, and the
//! engine side of `generateShape` and `exportWith`.

use std::path::Path;

use cxx::UniquePtr;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, ItemKind};
use opencascade_sys::plugin_ops as ffi;
use opencascade_sys::topo_ds::TopoDS_Shape;
use serde_json::{json, Map, Value};

use super::host::{fail_text, ExportMesh};
use crate::builder::{self, Ctx, Watch};
use crate::export;
use crate::features::blend::{ops, sequential_blend};
use crate::import::blobstore::{self, BlobStore};
use crate::kernel;
use crate::mesh::{self, MeshParams};

use super::host::types::{
    BooleanOp, Circle, Curve, Cylinder, Line, Mesh, Plane, PointState, ShapeKind, Surface, Vec3,
};

pub fn tuple(v: [f64; 3]) -> Vec3 {
    (v[0], v[1], v[2])
}


fn nonnull(p: UniquePtr<TopoDS_Shape>, what: &str) -> Result<Shape, String> {
    let s = Shape::from_raw(p);
    if kernel::is_null(&s) {
        Err(format!("the kernel could not make {what}"))
    } else {
        Ok(s)
    }
}

fn shapes(v: UniquePtr<cxx::CxxVector<TopoDS_Shape>>) -> Vec<Shape> {
    v.as_ref()
        .map(|v| v.iter().map(Shape::from_raw_ref).collect())
        .unwrap_or_default()
}

pub fn kind(s: &Shape) -> ShapeKind {
    use kernel::ShapeType as T;
    match kernel::shape_type(s) {
        Some(T::Compound) => ShapeKind::Compound,
        Some(T::CompSolid) => ShapeKind::CompSolid,
        Some(T::Solid) => ShapeKind::Solid,
        Some(T::Shell) => ShapeKind::Shell,
        Some(T::Face) => ShapeKind::Face,
        Some(T::Wire) => ShapeKind::Wire,
        Some(T::Edge) => ShapeKind::Edge,
        Some(T::Vertex) => ShapeKind::Vertex,
        _ => ShapeKind::Other,
    }
}

pub enum Items {
    Solids,
    Faces,
    Wires,
    Edges,
}

pub fn items(s: &Shape, which: Items) -> Vec<Shape> {
    match which {
        Items::Faces => sa::items(s, ItemKind::Face),
        Items::Edges => sa::items(s, ItemKind::Edge),
        Items::Solids => shapes(ffi::po_items(s.raw(), 0)),
        Items::Wires => shapes(ffi::po_items(s.raw(), 1)),
    }
}

pub fn outer_wire(face: &Shape) -> Option<Shape> {
    let w = Shape::from_raw(ffi::po_outer_wire(face.raw()));
    (!kernel::is_null(&w)).then_some(w)
}

pub fn inner_wires(face: &Shape) -> Vec<Shape> {
    let Some(outer) = outer_wire(face) else {
        return Vec::new();
    };
    items(face, Items::Wires)
        .into_iter()
        .filter(|w| !is_same(w, &outer))
        .collect()
}

pub fn is_same(a: &Shape, b: &Shape) -> bool {
    opencascade_sys::builder_ops::bo_is_same(a.raw(), b.raw())
}

const SURFACE_NAMES: [&str; 11] = [
    "plane", "cylinder", "cone", "sphere", "torus", "bezier", "bspline", "revolution",
    "extrusion", "offset", "other",
];

pub fn surface(face: &Shape) -> Surface {
    let mut o = [0.0; 7];
    match ffi::po_surface(face.raw(), &mut o) {
        0 => Surface::Plane(Plane {
            origin: (o[0], o[1], o[2]),
            normal: (o[3], o[4], o[5]),
        }),
        1 => Surface::Cylinder(Cylinder {
            origin: (o[0], o[1], o[2]),
            axis: (o[3], o[4], o[5]),
            radius: o[6],
        }),
        -1 => Surface::Other("not a face".into()),
        code => Surface::Other(
            SURFACE_NAMES
                .get(usize::try_from(code - 10).unwrap_or(10))
                .unwrap_or(&"other")
                .to_string(),
        ),
    }
}

const CURVE_NAMES: [&str; 9] = [
    "line", "circle", "ellipse", "hyperbola", "parabola", "bezier", "bspline", "offset", "other",
];

pub fn curve(edge: &Shape) -> Curve {
    let mut o = [0.0; 7];
    match ffi::po_curve(edge.raw(), &mut o) {
        0 => Curve::Line(Line {
            origin: (o[0], o[1], o[2]),
            direction: (o[3], o[4], o[5]),
        }),
        1 => Curve::Circle(Circle {
            center: (o[0], o[1], o[2]),
            axis: (o[3], o[4], o[5]),
            radius: o[6],
        }),
        -1 => Curve::Other("not an edge".into()),
        code => Curve::Other(
            CURVE_NAMES
                .get(usize::try_from(code - 10).unwrap_or(8))
                .unwrap_or(&"other")
                .to_string(),
        ),
    }
}

pub fn sample_edges(s: &Shape, segments: u32) -> Vec<Vec3> {
    let n = i32::try_from(segments.clamp(1, 10_000)).unwrap_or(1);
    ffi::po_sample_edges(s.raw(), n)
        .chunks_exact(3)
        .map(|c| (c[0], c[1], c[2]))
        .collect()
}

pub fn point_at(edge: &Shape, position: f64) -> Option<Vec3> {
    let mut o = [0.0; 3];
    ffi::po_point_at(edge.raw(), position, &mut o).then(|| tuple(o))
}

pub fn center(s: &Shape) -> Option<Vec3> {
    let mut o = [0.0; 3];
    ffi::po_center(s.raw(), &mut o).then(|| tuple(o))
}

pub fn normal_at(face: &Shape, p: Vec3) -> Option<Vec3> {
    let mut o = [0.0; 3];
    ffi::po_normal_at(face.raw(), p.0, p.1, p.2, &mut o).then(|| tuple(o))
}

pub fn classify(s: &Shape, p: Vec3, tol: f64) -> PointState {
    match ffi::po_classify(s.raw(), p.0, p.1, p.2, tol) {
        0 => PointState::Inside,
        1 => PointState::On,
        _ => PointState::Outside,
    }
}

pub fn faces_of_edge(s: &Shape, edge: &Shape) -> Vec<Shape> {
    shapes(ffi::po_faces_of_edge(s.raw(), edge.raw()))
}

pub fn is_valid(s: &Shape) -> bool {
    ffi::po_is_valid(s.raw())
}

pub fn triangulate(face: &Shape, deflection: f64) -> Result<Mesh, String> {
    if !(deflection > 0.0) {
        return Err("the deflection must be greater than 0".into());
    }
    let access = MeshAccess::new(face);
    let t = mesh::tessellate(
        face,
        &access,
        MeshParams {
            linear: deflection,
            angular: 0.5,
            relative: false,
            display: true,
            force_remesh: false,
        },
    );
    Ok(Mesh {
        positions: t.positions,
        indices: t.indices,
        normals: t
            .normals
            .map(|n| n.iter().map(|&v| v as f32).collect())
            .unwrap_or_default(),
    })
}

fn finite(v: &[f64]) -> Result<(), String> {
    if v.iter().all(|x| x.is_finite()) {
        Ok(())
    } else {
        Err("every coordinate must be a finite number".into())
    }
}

fn unit(v: Vec3) -> Result<Vec3, String> {
    let n = (v.0 * v.0 + v.1 * v.1 + v.2 * v.2).sqrt();
    if !(n > 1e-12) || !n.is_finite() {
        return Err("a direction must not be zero".into());
    }
    Ok((v.0 / n, v.1 / n, v.2 / n))
}

pub fn make_box(c: Vec3, s: Vec3) -> Result<Shape, String> {
    finite(&[c.0, c.1, c.2, s.0, s.1, s.2])?;
    if !(s.0 > 0.0 && s.1 > 0.0 && s.2 > 0.0) {
        return Err("a box needs a size greater than 0 on every axis".into());
    }
    nonnull(ffi::po_box(c.0, c.1, c.2, s.0, s.1, s.2), "a box")
}

pub fn make_cylinder(b: Vec3, a: Vec3, r: f64, h: f64) -> Result<Shape, String> {
    finite(&[b.0, b.1, b.2, r, h])?;
    let a = unit(a)?;
    if !(r > 0.0 && h > 0.0) {
        return Err("a cylinder needs a radius and height greater than 0".into());
    }
    nonnull(ffi::po_cylinder(b.0, b.1, b.2, a.0, a.1, a.2, r, h), "a cylinder")
}

pub fn make_cone(b: Vec3, a: Vec3, r1: f64, r2: f64, h: f64) -> Result<Shape, String> {
    finite(&[b.0, b.1, b.2, r1, r2, h])?;
    let a = unit(a)?;
    if r1 < 0.0 || r2 < 0.0 || !(h > 0.0) || (r1 == 0.0 && r2 == 0.0) {
        return Err("a cone needs a height greater than 0 and one radius greater than 0".into());
    }
    nonnull(ffi::po_cone(b.0, b.1, b.2, a.0, a.1, a.2, r1, r2, h), "a cone")
}

pub fn make_sphere(c: Vec3, r: f64) -> Result<Shape, String> {
    finite(&[c.0, c.1, c.2, r])?;
    if !(r > 0.0) {
        return Err("a sphere needs a radius greater than 0".into());
    }
    nonnull(ffi::po_sphere(c.0, c.1, c.2, r), "a sphere")
}

pub fn polygon_face(points: &[Vec3]) -> Result<Shape, String> {
    let flat: Vec<f64> = points.iter().flat_map(|p| [p.0, p.1, p.2]).collect();
    finite(&flat)?;
    if points.len() < 3 {
        return Err("a polygon needs at least three points".into());
    }
    nonnull(ffi::po_polygon_face(&flat), "a planar polygon face")
}

pub fn face_from_wire(wire: &Shape) -> Result<Shape, String> {
    nonnull(ffi::po_face_from_wire(wire.raw()), "a planar face from this wire")
}

pub fn sketch_faces(ctx: Option<&mut Ctx>, plane: &str, entities: &str) -> Result<Vec<Shape>, String> {
    let plane: Value = serde_json::from_str(plane).map_err(|e| e.to_string())?;
    let entities: Value = serde_json::from_str(entities).map_err(|e| e.to_string())?;
    let raw = json!({"id": "plugin-sketch", "type": "sketch", "plane": plane, "entities": entities});
    let typed: fundacad_core::schema::SketchFeature =
        serde_json::from_value(raw).map_err(|e| format!("the sketch does not parse: {e}"))?;
    let entry = match ctx {
        // Nothing to follow: a plugin authors a sketch on a plane it names,
        // never on a placement carried down from a feature above it.
        Some(ctx) => crate::features::sketch::build(ctx, &typed, None),
        None => crate::features::sketch::build(&Ctx::detached(), &typed, None),
    }
    .map_err(fail_text)?;
    Ok(entry.faces)
}

pub fn prism(profile: &Shape, d: Vec3) -> Result<Shape, String> {
    finite(&[d.0, d.1, d.2])?;
    nonnull(ffi::po_prism(profile.raw(), d.0, d.1, d.2), "a prism")
}

pub fn revolve(profile: &Shape, o: Vec3, a: Vec3, degrees: f64) -> Result<Shape, String> {
    finite(&[o.0, o.1, o.2, degrees])?;
    let a = unit(a)?;
    nonnull(
        ffi::po_revolve(profile.raw(), o.0, o.1, o.2, a.0, a.1, a.2, degrees),
        "a revolved solid",
    )
}

pub fn boolean(op: BooleanOp, base: &Shape, tools: &[&Shape]) -> Result<Shape, String> {
    let (kind, verb) = match op {
        BooleanOp::Fuse => (0, "join"),
        BooleanOp::Cut => (1, "cut"),
        BooleanOp::Common => (2, "intersect"),
    };
    if tools.is_empty() {
        return Err(format!("nothing to {verb} with"));
    }
    let c = kernel::compound(tools.iter().copied());
    let mut status = 0;
    let out = Shape::from_raw(ffi::po_boolean(kind, base.raw(), c.raw(), &mut status));
    match status {
        0 => Ok(out),
        2 => Err(format!("{verb} produced an invalid solid")),
        _ => Err(format!("the geometry engine could not {verb} this body")),
    }
}

pub fn unify(s: &Shape) -> Shape {
    Shape::from_raw(ffi::po_unify(s.raw()))
}

pub fn translate(s: &Shape, d: Vec3) -> Result<Shape, String> {
    finite(&[d.0, d.1, d.2])?;
    nonnull(ffi::po_translate(s.raw(), d.0, d.1, d.2), "a moved shape")
}

pub fn place(s: &Shape, o: Vec3, z: Vec3) -> Result<Shape, String> {
    finite(&[o.0, o.1, o.2])?;
    let z = unit(z)?;
    nonnull(ffi::po_place(s.raw(), o.0, o.1, o.2, z.0, z.1, z.2), "a placed shape")
}

fn vec_of(v: Option<&Value>, what: &str, default: Vec3) -> Result<Vec3, String> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(default);
    };
    let bad = || format!("placement {what} must be three numbers");
    let a = v.as_array().filter(|a| a.len() == 3).ok_or_else(bad)?;
    let n: Vec<f64> = a.iter().map(Value::as_f64).collect::<Option<_>>().ok_or_else(bad)?;
    if !n.iter().all(|x| x.is_finite()) {
        return Err(format!("placement {what} must be finite"));
    }
    Ok((n[0], n[1], n[2]))
}

/// shape_generate.py `place`.
pub fn place_json(s: &Shape, placement: &Value) -> Result<Shape, String> {
    let o = vec_of(placement.get("origin"), "origin", (0.0, 0.0, 0.0))?;
    let z = vec_of(placement.get("zAxis"), "zAxis", (0.0, 0.0, 1.0))?;
    if (z.0 * z.0 + z.1 * z.1 + z.2 * z.2).sqrt() < 1e-9 {
        return Err("placement zAxis must not be zero".into());
    }
    place(s, o, z)
}

pub enum Blend {
    Fillet(f64),
    Chamfer(f64, f64),
}

/// A batch blend, then with `one_by_one` blends.py `_sequential_blend`.
pub fn blend(s: &Shape, edges: &[Shape], how: Blend, one_by_one: bool) -> Result<(Shape, u32), String> {
    if edges.is_empty() {
        return Err("no edges to blend".into());
    }
    let (size, verb) = match how {
        Blend::Fillet(r) => (r, "fillet"),
        Blend::Chamfer(d, _) => (d, "chamfer"),
    };
    let one = |shape: &Shape, es: &[Shape]| -> Result<Shape, String> {
        let r = match how {
            Blend::Fillet(r) => ops::fillet(shape, es, &vec![r; es.len()]),
            Blend::Chamfer(d1, d2) => ops::chamfer(shape, es, &vec![d1; es.len()], &vec![d2; es.len()]),
        };
        match r {
            Ok((out, ops::Built::Done)) => Ok(out),
            Ok(_) => Err(format!("Failed creating a {verb}, try a smaller value")),
            Err(e) => Err(e),
        }
    };
    match one(s, edges) {
        Ok(out) => return Ok((out, 0)),
        Err(e) if !one_by_one => return Err(e),
        Err(_) => {}
    }
    let apply = |shape: &Shape, e: &Shape| {
        one(shape, std::slice::from_ref(e)).map_err(crate::features::blend::BlendErr::Kernel)
    };
    let (out, unresolved) = sequential_blend(s, edges, &apply, size);
    if unresolved.len() == edges.len() {
        return Err(format!(
            "the kernel could not {verb} any of the {} edge(s), try a smaller size",
            edges.len()
        ));
    }
    Ok((out, unresolved.len() as u32))
}

pub fn read_blob(id: &str) -> Result<Shape, String> {
    let store = BlobStore::open(blobstore::default_root()).map_err(|e| e.to_string())?;
    let bytes = store
        .get_bytes(id)
        .ok_or_else(|| format!("no stored geometry {id:?}"))?;
    opencascade::xcaf::from_bin(&bytes).map_err(|e| e.to_string())
}

pub fn write_blob(s: &Shape) -> Result<String, String> {
    let store_err = |e: &dyn std::fmt::Display| {
        format!(
            "could not store the imported geometry ({e}). Check free disk space and permissions on the FundaCAD data directory."
        )
    };
    let bytes = opencascade::xcaf::to_bin_v3(s).map_err(|e| store_err(&e))?;
    let store = BlobStore::open(blobstore::default_root()).map_err(|e| store_err(&e))?;
    store.put_bytes(&bytes).map_err(|e| store_err(&e))
}

const MAX_PREVIEW_TRIANGLES: usize = 400_000;

fn round_to(v: f64, digits: i32) -> f64 {
    let m = 10f64.powi(digits);
    (v * m).round() / m
}

/// shape_generate.py `_measure` plus the mesh or the stored blob.
pub fn generated_reply(s: &Shape, output: &str) -> Result<Map<String, Value>, String> {
    let solids = items(s, Items::Solids);
    if solids.is_empty() {
        return Err("the generator made no solid".into());
    }
    let mut m = Map::new();
    m.insert("solid".into(), json!(true));
    m.insert("solids".into(), json!(solids.len()));
    m.insert("valid".into(), json!(is_valid(s)));
    m.insert("faces".into(), json!(items(s, Items::Faces).len()));
    m.insert("volume".into(), json!(solids.iter().map(kernel::volume).sum::<f64>()));
    let bb = kernel::bbox(s).unwrap_or([0.0; 6]);
    m.insert("bbox".into(), json!({"min": [bb[0], bb[1], bb[2]], "max": [bb[3], bb[4], bb[5]]}));
    if output == "mesh" {
        let size = (bb[3] - bb[0]).max(bb[4] - bb[1]).max(bb[5] - bb[2]).max(1e-3);
        let access = MeshAccess::new(s);
        let t = mesh::tessellate(
            s,
            &access,
            MeshParams {
                linear: (size * 0.0015).max(0.002),
                angular: 0.3,
                relative: false,
                display: true,
                force_remesh: false,
            },
        );
        if t.indices.len() / 3 > MAX_PREVIEW_TRIANGLES {
            return Err("this shape is too detailed to preview".into());
        }
        let normals: Vec<f64> = match &t.normals {
            Some(n) if n.len() == t.positions.len() => n.iter().map(|&v| round_to(v, 4)).collect(),
            _ => Vec::new(),
        };
        m.insert(
            "mesh".into(),
            json!({
                "positions": t.positions.iter().map(|&v| round_to(v, 5)).collect::<Vec<_>>(),
                "indices": t.indices,
                "normals": normals,
            }),
        );
    } else {
        m.insert("geom".into(), json!(write_blob(s)?));
    }
    Ok(m)
}

/// server.py `_plugin_export_job`.
pub fn export_with(
    req: &Map<String, Value>,
    watch: &dyn Watch,
    cancel: Option<fundacad_protocol::CancelToken>,
) -> Result<Map<String, Value>, String> {
    let exporter = req
        .get("exporter")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty() && e.len() <= 100)
        .ok_or("exportWith: bad exporter")?;
    let options = req.get("options").filter(|o| !o.is_null()).cloned().unwrap_or(json!({}));
    if !options.is_object() || options.to_string().len() > 262_144 {
        return Err("exportWith: bad options".into());
    }
    let path = req
        .get("path")
        .and_then(Value::as_str)
        .ok_or("exportWith: a request needs a path")?;
    let doc = req.get("document").ok_or("exportWith: a request needs a document")?;
    super::exporter_declared(exporter)?;
    let typed: fundacad_core::CadDocument =
        serde_json::from_value(doc.clone()).map_err(|e| format!("the document does not parse: {e}"))?;
    let r = builder::rebuild(&typed, doc, watch).map_err(|_| "cancelled".to_string())?;
    if r.bodies.is_empty() {
        return Err(r
            .errors
            .first()
            .map_or_else(|| "nothing to export, no bodies built yet".into(), |e| e.message.clone()));
    }
    let opts = export::mesh_options(None);
    let mut meshed = Vec::new();
    let mut ntri = 0;
    for b in &r.bodies {
        let (positions, indices) = export::export_mesh(&b.shape, &opts);
        if indices.is_empty() {
            continue;
        }
        ntri += indices.len() / 3;
        if let Some(refusal) = export::budget_refusal(ntri) {
            return Err(refusal);
        }
        meshed.push(ExportMesh {
            id: b.id.clone(),
            name: b.name.clone(),
            positions,
            indices,
        });
    }
    if meshed.is_empty() {
        return Err("nothing to export, no meshable bodies".into());
    }
    let target = Path::new(path);
    let _ = std::fs::remove_file(target);
    let info = super::exporter_call(exporter, meshed, &options, target, cancel)?;
    let mut res = Map::new();
    res.insert("path".into(), json!(path));
    if let Some(info @ Value::Object(_)) = info {
        res.insert("info".into(), info);
    }
    if !r.errors.is_empty() {
        res.insert(
            "warnings".into(),
            Value::Array(r.errors.iter().map(builder::FeatureError::wire).collect()),
        );
    }
    Ok(res)
}
