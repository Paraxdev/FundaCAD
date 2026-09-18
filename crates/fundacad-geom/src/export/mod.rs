//! The `export` op, replaces `_export_job`, `_mesh_options`, `_budget_refusal`
//! and `_budget_warning` of `sidecar/server.py`, with the writers of
//! `mesh_writers.py`, `mesh_refine.py`, `exporters.py` and `export_tree.py`.
//!
//! Not here yet: the export mesh cache tiers and plugin mesh passes, so the
//! per face density cap has nothing to bound.

pub mod glb;
pub mod names;
pub mod pyfmt;
pub mod refine;
pub mod step;
pub mod stl;
pub mod threemf;

use std::path::{Path, PathBuf};

use fundacad_core::CadDocument;
use fundacad_engine::error_result;
use fundacad_protocol::JobResult;
use opencascade::mesh_access::MeshAccess;
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

use crate::builder::{self, BuiltBody, Watch};
use crate::mesh::{self, MeshParams};

pub const EXPORT_TOL: f64 = 0.02;
pub const EXPORT_ANG_TOL: f64 = 0.3;
pub const EXPORT_DENSITY_CAP_PER_FACE: usize = 200_000;
pub const EXPORT_TRIANGLE_HARD_CAP: usize = 10_000_000;
pub const EXPORT_TRIANGLE_WARN: usize = 500_000;

/// Output unit: its key, millimetres per unit and its 3MF name.
pub const UNITS: [(&str, f64, &str); 5] = [
    ("mm", 1.0, "millimeter"),
    ("cm", 10.0, "centimeter"),
    ("m", 1000.0, "meter"),
    ("in", 25.4, "inch"),
    ("ft", 304.8, "foot"),
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeshOptions {
    pub tol: f64,
    pub ang: f64,
    pub max_edge: f64,
    pub mm_per_unit: f64,
    pub unit_name: &'static str,
    pub binary: bool,
}

/// `_mesh_options`: anything absent, mistyped or non finite takes its default,
/// anything out of range is clamped.
pub fn mesh_options(mesh: Option<&Value>) -> MeshOptions {
    let empty = Map::new();
    let mesh = mesh.and_then(Value::as_object).unwrap_or(&empty);
    let num = |key: &str, default: f64, lo: f64, hi: f64| match mesh.get(key).and_then(Value::as_f64) {
        Some(v) if v.is_finite() => v.max(lo).min(hi),
        _ => default,
    };
    let unit = UNITS
        .iter()
        .find(|u| mesh.get("unit").and_then(Value::as_str) == Some(u.0))
        .unwrap_or(&UNITS[0]);
    MeshOptions {
        tol: num("surfaceDeviation", EXPORT_TOL, 1e-4, 10.0),
        ang: num("normalDeviation", EXPORT_ANG_TOL.to_degrees(), 0.5, 90.0).to_radians(),
        max_edge: num("maxEdgeLength", 0.0, 0.0, 1e6),
        mm_per_unit: unit.1,
        unit_name: unit.2,
        binary: mesh.get("binary") != Some(&Value::Bool(false)),
    }
}

pub fn budget_refusal(ntri: usize) -> Option<String> {
    (ntri > EXPORT_TRIANGLE_HARD_CAP).then(|| {
        format!(
            "export too dense ({}+ triangles), reduce texture scale or depth, or export fewer bodies",
            pyfmt::thousands(ntri)
        )
    })
}

pub fn budget_warning(ntri: usize) -> Option<String> {
    (ntri > EXPORT_TRIANGLE_WARN)
        .then(|| format!("export is very dense ({} triangles)", pyfmt::thousands(ntri)))
}

/// Export grade triangles of one shape: absolute deflection, the kernel's own
/// winding with reversed faces flipped, faces never welded.
pub fn export_mesh(shape: &Shape, opts: &MeshOptions) -> (Vec<f64>, Vec<u32>) {
    export_mesh_with(shape, opts, &[])
}

/// `export_mesh` with the body's plugin mesh passes displacing the faces they
/// claim, under the export density cap.
pub fn export_mesh_with(shape: &Shape, opts: &MeshOptions, passes: &[Value]) -> (Vec<f64>, Vec<u32>) {
    let access = MeshAccess::new(shape);
    let claims = mesh::PassClaims::resolve(shape, passes);
    let t = claims.tessellate(
        shape,
        &access,
        MeshParams {
            linear: opts.tol,
            angular: opts.ang,
            relative: false,
            display: false,
            force_remesh: false,
        },
        EXPORT_DENSITY_CAP_PER_FACE as u32,
    );
    if opts.max_edge > 0.0 {
        refine::cap_edge_length(&t.positions, &t.indices, opts.max_edge, EXPORT_TRIANGLE_HARD_CAP)
    } else {
        (t.positions, t.indices)
    }
}

/// Which group each index belongs to, the inverse of `par::share_groups`.
fn group_index(groups: &[Vec<usize>], n: usize) -> Vec<usize> {
    let mut out = vec![0; n];
    for (g, members) in groups.iter().enumerate() {
        for &i in members {
            out[i] = g;
        }
    }
    out
}

struct Failure(String);

impl<E: std::fmt::Display> From<E> for Failure {
    fn from(e: E) -> Self {
        Failure(e.to_string())
    }
}

/// A body as the export sees it.
pub struct ExportBody<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub shape: &'a Shape,
    /// `"<import feature id>/<manifest node index>"` for an imported part.
    pub node_ref: Option<&'a str>,
    /// The plugin mesh pass specs on the body, displaced into its mesh.
    pub mesh_passes: &'a [Value],
}

pub struct Exporter<'a> {
    pub format: String,
    pub opts: MeshOptions,
    pub palette: Vec<Value>,
    pub body_colors: Map<String, Value>,
    pub warnings: Vec<Value>,
    pub document: &'a Value,
}

impl Exporter<'_> {
    fn meshes<'b>(
        &mut self,
        bodies: &[ExportBody<'b>],
        mut each: impl FnMut(&ExportBody<'b>, Vec<f64>, Vec<u32>),
    ) -> Result<(), Failure> {
        let mut ntri = 0;
        let shapes: Vec<&Shape> = bodies.iter().map(|b| b.shape).collect();
        let groups = crate::par::share_groups(&shapes);
        let of_group: Vec<usize> = group_index(&groups, bodies.len());
        // A batch at a time, in body order, because the triangle budget refuses
        // AT the body that passes it: a whole document meshed up front would
        // hold the very mesh the budget exists to refuse. One batch of extra
        // work is the price, and the refusal names the same body and count.
        for batch in (0..bodies.len()).collect::<Vec<_>>().chunks(crate::par::threads().max(1)) {
            let mut sub: Vec<Vec<usize>> = vec![Vec::new(); groups.len()];
            for &i in batch {
                sub[of_group[i]].push(i);
            }
            sub.retain(|g| !g.is_empty());
            let opts = &self.opts;
            let work = crate::par::Shared((bodies, opts));
            let meshed = crate::par::map_grouped(&sub, move |i| {
                let (bodies, opts) = *work.get();
                export_mesh_with(bodies[i].shape, opts, bodies[i].mesh_passes)
            });
            for (i, (pos, idx)) in meshed {
                ntri += idx.len() / 3;
                if let Some(refusal) = budget_refusal(ntri) {
                    return Err(Failure(refusal));
                }
                each(&bodies[i], pos, idx);
            }
        }
        if let Some(w) = budget_warning(ntri) {
            self.warnings.push(json!({ "message": w }));
        }
        Ok(())
    }

    /// `_mesh_export`: every body merged into one soup.
    fn merged(&mut self, bodies: &[ExportBody<'_>], path: &Path) -> Result<(), Failure> {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        self.meshes(bodies, |_, pos, idx| {
            let base = (positions.len() / 3) as u32;
            positions.extend_from_slice(&pos);
            indices.extend(idx.iter().map(|i| i + base));
        })?;
        if self.opts.mm_per_unit != 1.0 {
            for p in &mut positions {
                *p /= self.opts.mm_per_unit;
            }
        }
        match self.format.as_str() {
            "stl" if self.opts.binary => stl::write_binary_file(&positions, &indices, path)?,
            "stl" => stl::write_ascii_file(&positions, &indices, path)?,
            "3mf" => threemf::write_file(&positions, &indices, self.opts.unit_name, path)?,
            other => return Err(Failure(format!("texture is not supported for {other} export"))),
        }
        Ok(())
    }

    fn glb(&mut self, bodies: &[ExportBody<'_>], path: &Path) -> Result<(), Failure> {
        let mut entries = Vec::new();
        let palette = self.palette.clone();
        let slots = self.body_colors.clone();
        self.meshes(bodies, |b, pos, idx| {
            let slot = match slots.get(b.id) {
                None => Some(0),
                Some(Value::Number(n)) => n.as_i64(),
                Some(_) => None,
            };
            let entry = slot
                .and_then(|s| usize::try_from(s).ok())
                .and_then(|s| palette.get(s));
            let color = entry.map(|e| {
                glb::norm_color(&match e.get("color") {
                    Some(Value::String(s)) => s.clone(),
                    None | Some(Value::Null) => String::new(),
                    Some(other) => other.to_string(),
                })
            });
            let name = if b.name.is_empty() { b.id } else { b.name };
            entries.push((name.to_string(), pos, idx, color));
        })?;
        let meshes: Vec<glb::GlbMesh<'_>> = entries
            .iter()
            .map(|(name, pos, idx, color)| glb::GlbMesh {
                name: Some(name.clone()),
                positions: pos,
                indices: idx,
                color: color.clone(),
            })
            .collect();
        glb::write_file(&meshes, path)?;
        Ok(())
    }

    fn one_body(&mut self, b: &ExportBody<'_>, path: &Path) -> Result<(), Failure> {
        match self.format.as_str() {
            "glb" => self.glb(std::slice::from_ref(b), path),
            "stl" | "3mf" => self.merged(std::slice::from_ref(b), path),
            "step" => {
                step::write_shape(b.shape, path)?;
                Ok(())
            }
            other => Err(Failure(format!("unknown export format: {other}"))),
        }
    }
}

fn py_splitext(path: &str) -> (&str, &str) {
    let sep = path.rfind(['/', '\\']).map_or(0, |i| i + 1);
    let file = &path[sep..];
    let lead = file.len() - file.trim_start_matches('.').len();
    match file[lead..].rfind('.') {
        Some(dot) => path.split_at(sep + lead + dot),
        None => (path, ""),
    }
}

/// `_export_job` on bodies that already built.
pub fn export_bodies(
    exporter: &mut Exporter<'_>,
    bodies: &[ExportBody<'_>],
    path: &str,
    body: Option<&str>,
    separate: bool,
) -> Map<String, Value> {
    match export_inner(exporter, bodies, path, body, separate) {
        Ok(mut m) => {
            if !exporter.warnings.is_empty() {
                m.insert("warnings".into(), Value::Array(exporter.warnings.clone()));
            }
            m
        }
        Err(Failure(message)) => {
            let mut m = Map::new();
            m.insert("error".into(), json!({ "message": message }));
            m
        }
    }
}

fn export_inner(
    ex: &mut Exporter<'_>,
    bodies: &[ExportBody<'_>],
    path: &str,
    body: Option<&str>,
    separate: bool,
) -> Result<Map<String, Value>, Failure> {
    let mut out = Map::new();
    if separate {
        if bodies.is_empty() {
            return Err(Failure("nothing to export, no bodies".into()));
        }
        let names = ex.document.get("bodyNames").and_then(Value::as_object);
        let (base, ext) = py_splitext(path);
        let outdir = PathBuf::from(base);
        match std::fs::create_dir(&outdir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let shown = outdir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                return Err(Failure(format!(
                    "{shown} already exists, the separate-bodies export writes a folder of that name. \
                     Choose another name, or move the existing folder."
                )));
            }
            Err(e) => return Err(Failure(format!("could not create {base}: {e}"))),
        }
        let mut written = Vec::new();
        let mut used = std::collections::HashSet::new();
        for b in bodies {
            let label = names
                .and_then(|n| n.get(b.id))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(b.name);
            let name = names::safe_part_filename(label, b.id);
            let mut cand = name.clone();
            let mut i = 2;
            while used.contains(&cand.to_lowercase()) {
                cand = format!("{name}_{i}");
                i += 1;
            }
            used.insert(cand.to_lowercase());
            let p = format!("{}{}{cand}{ext}", base, std::path::MAIN_SEPARATOR);
            ex.one_body(b, Path::new(&p))?;
            written.push(Value::String(p));
        }
        out.insert("path".into(), Value::String(base.to_string()));
        out.insert("paths".into(), Value::Array(written));
        return Ok(out);
    }
    if let Some(id) = body {
        let Some(tgt) = bodies.iter().find(|b| b.id == id) else {
            return Err(Failure(format!("body '{id}' not found to export")));
        };
        ex.one_body(tgt, Path::new(path))?;
    } else {
        match ex.format.as_str() {
            "glb" => ex.glb(bodies, Path::new(path))?,
            "stl" | "3mf" => ex.merged(bodies, Path::new(path))?,
            "step" => {
                let stem = Path::new(path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Model".into());
                if let Some(tree) = step::build_export_tree(ex.document, bodies, &stem) {
                    step::write_tree(&tree, Path::new(path))?;
                } else {
                    let all = crate::kernel::compound(bodies.iter().map(|b| b.shape));
                    step::write_shape(&all, Path::new(path))?;
                }
            }
            other => return Err(Failure(format!("unknown export format: {other}"))),
        }
    }
    out.insert("path".into(), Value::String(path.to_string()));
    Ok(out)
}

/// The `export` op: rebuild, then write what built.
pub fn export_result(req: &Map<String, Value>, watch: &dyn Watch) -> JobResult {
    let Some(doc) = req.get("document") else {
        return error_result("export: a request needs a document");
    };
    let (Some(format), Some(path)) = (
        req.get("format").and_then(Value::as_str),
        req.get("path").and_then(Value::as_str),
    ) else {
        return error_result("export: a request needs a format and a path");
    };
    let typed: CadDocument = match serde_json::from_value(doc.clone()) {
        Ok(d) => d,
        Err(e) => return error_result(&format!("the document does not parse: {e}")),
    };
    let Ok(r) = builder::rebuild(&typed, doc, watch) else {
        return error_result("cancelled");
    };
    JobResult::Json(export_built(req, doc, format, path, &r.bodies, &r.errors))
}

pub fn export_built(
    req: &Map<String, Value>,
    doc: &Value,
    format: &str,
    path: &str,
    built: &[BuiltBody],
    errors: &[builder::FeatureError],
) -> Map<String, Value> {
    if built.is_empty() {
        let mut m = Map::new();
        let err = errors.first().map_or_else(
            || json!({ "message": "nothing to export, no bodies built yet" }),
            builder::FeatureError::wire,
        );
        m.insert("error".into(), err);
        return m;
    }
    let mut exporter = Exporter {
        format: format.to_lowercase(),
        opts: mesh_options(req.get("mesh")),
        palette: req.get("palette").and_then(Value::as_array).cloned().unwrap_or_default(),
        body_colors: req.get("bodyColors").and_then(Value::as_object).cloned().unwrap_or_default(),
        warnings: errors.iter().map(builder::FeatureError::wire).collect(),
        document: doc,
    };
    let bodies: Vec<ExportBody<'_>> = built
        .iter()
        .map(|b| ExportBody {
            id: &b.id,
            name: &b.name,
            shape: &b.shape,
            node_ref: b.node_ref.as_deref(),
            mesh_passes: &b.mesh_passes,
        })
        .collect();
    if format.eq_ignore_ascii_case("step") && built.iter().any(|b| !b.mesh_passes.is_empty()) {
        // Generic on purpose: true for whichever plugin put the displacement there.
        exporter.warnings.push(json!({
            "message": "surface displacement from a plugin is not represented in STEP exports"
        }));
    }
    let body = req.get("body").and_then(Value::as_str).filter(|s| !s.is_empty());
    let separate = fundacad_protocol::pyjson::truthy(req.get("separate"));
    export_bodies(&mut exporter, &bodies, path, body, separate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mesh_options_default_and_clamp() {
        let d = mesh_options(None);
        assert_eq!((d.tol, d.max_edge, d.mm_per_unit, d.unit_name, d.binary), (0.02, 0.0, 1.0, "millimeter", true));
        assert!((d.ang - 0.3).abs() < 1e-12);
        let o = mesh_options(Some(&json!({
            "surfaceDeviation": 50, "normalDeviation": true, "maxEdgeLength": -3,
            "unit": "in", "binary": false
        })));
        assert_eq!((o.tol, o.max_edge, o.unit_name, o.binary), (10.0, 0.0, "inch", false));
        assert!((o.ang - 0.3).abs() < 1e-12);
        assert_eq!(mesh_options(Some(&json!({"unit": "yd", "binary": 0}))).unit_name, "millimeter");
    }

    #[test]
    fn budget_messages() {
        assert_eq!(budget_refusal(10_000_000), None);
        assert_eq!(
            budget_refusal(10_000_001).unwrap(),
            "export too dense (10,000,001+ triangles), reduce texture scale or depth, or export fewer bodies"
        );
        assert_eq!(budget_warning(500_001).unwrap(), "export is very dense (500,001 triangles)");
    }

    #[test]
    fn splitext_follows_python() {
        assert_eq!(py_splitext("C:/a/parts.step"), ("C:/a/parts", ".step"));
        assert_eq!(py_splitext("/a.b/parts"), ("/a.b/parts", ""));
        assert_eq!(py_splitext("/a/.hidden"), ("/a/.hidden", ""));
        assert_eq!(py_splitext("x.tar.gz"), ("x.tar", ".gz"));
    }
}
