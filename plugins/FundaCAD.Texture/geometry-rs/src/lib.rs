//! The surface texture's geometry as a FundaCAD plugin component, the Rust
//! twin of geometry/*.py.
//!
//! Two registrations, because a texture happens at two times. The FEATURE
//! validates the values against the body as it stands, so a bad value turns
//! the row red at once, and stashes the spec on the body; it displaces nothing.
//! The MESH PASS runs at tessellation against the FINAL shape, which is why a
//! texture survives the booleans and fillets applied after it: it resolves the
//! stored selector then, and displaces each face's triangulation.
//!
//! With grime on, the faces next to the textured ones are claimed too, tagged
//! "bleed", and get a fading noise instead of the pattern (Python keeps that
//! set in a module global between resolve and displace; a component keeps no
//! state between calls, so the tag carries it).

wit_bindgen::generate!({
    world: "plugin",
    path: "../../../crates/fundacad-geom/wit",
});

mod chart;
mod displace;
mod height;
mod image;
mod lattice;
mod nearest;
mod np;
mod py;
mod rng;
mod spec;
mod v3;

#[cfg(test)]
mod vector_tests;

use serde_json::{json, Value};

pub use fundacad::plugin::{feature, kernel};

/// Bumped on ANY change to the displacement's output, as texture.py's
/// CODE_VERSION is; it keys the mesh caches. The two halves share the number
/// because they make the same mesh.
pub const CODE_VERSION: u32 = 11;

const BLEED: &str = "bleed";

fn faces_selector(spec: &Value) -> String {
    spec.get("faces")
        .filter(|v| py::truthy(v))
        .cloned()
        .unwrap_or(json!({"by": "all"}))
        .to_string()
}

/// `_resolve_texture_faces`: the faces a selector (or a list) names, once each.
fn resolve_faces(shape: &Shape, sel: &str) -> Result<Vec<Shape>, String> {
    let found = kernel::select_faces(shape, sel)?;
    let mut out: Vec<Shape> = Vec::new();
    for f in found {
        if !out.iter().any(|o| o.is_same(&f)) {
            out.push(f);
        }
    }
    Ok(out)
}

/// `_adjacent_faces`: the faces sharing an edge with the primary ones.
fn adjacent_faces(shape: &Shape, primary: &[Shape]) -> Vec<Shape> {
    let mut out: Vec<Shape> = Vec::new();
    for p in primary {
        for e in p.edges() {
            for f in shape.faces_of_edge(&e) {
                if primary.iter().any(|q| q.is_same(&f)) || out.iter().any(|o| o.is_same(&f)) {
                    continue;
                }
                out.push(f);
            }
        }
    }
    out
}

fn run_texture() -> Result<(), String> {
    let raw: Value = serde_json::from_str(&feature::definition()).map_err(|e| e.to_string())?;
    let f = raw.as_object().ok_or("the feature is not an object")?;
    let body = *feature::target_bodies("body", "Texture")?
        .first()
        .ok_or("Texture: the target body no longer exists")?;
    let shape = feature::body_shape(body)?;
    let found = resolve_faces(&shape, &faces_selector(&raw))?;
    if found.is_empty() {
        return Err("no face found for texture".into());
    }
    let spec = spec::validate(f, &image::check)?;
    feature::stash_pass(body, &spec.to_string())
}

struct Texture;

impl Guest for Texture {
    fn register() -> Registration {
        Registration {
            features: vec!["texture".into()],
            mesh_passes: vec![MeshPass {
                name: spec::PASS.into(),
                code_version: CODE_VERSION,
            }],
            exporters: vec![],
            shape_generators: vec![],
        }
    }

    fn run_feature(type_name: String) -> Result<(), String> {
        match type_name.as_str() {
            "texture" => run_texture(),
            other => Err(format!("unknown feature type: {other}")),
        }
    }

    fn resolve_pass(pass: String, body: &Shape, spec: String) -> Result<Vec<Claimed>, String> {
        if pass != spec::PASS {
            return Err(format!("no mesh pass {pass:?} here"));
        }
        let spec: Value = serde_json::from_str(&spec).map_err(|e| e.to_string())?;
        let primary = resolve_faces(body, &faces_selector(&spec))?;
        let grime = spec::Spec::read(&spec).grime;
        let bleed = if !primary.is_empty() && grime > 0.0 {
            adjacent_faces(body, &primary)
        } else {
            Vec::new()
        };
        let mut out: Vec<Claimed> = primary
            .into_iter()
            .map(|face| Claimed { face, tag: String::new() })
            .collect();
        out.extend(bleed.into_iter().map(|face| Claimed { face, tag: BLEED.into() }));
        Ok(out)
    }

    fn displace(pass: String, face: &Shape, spec: String, tag: String, options: DisplaceOptions) -> Result<Mesh, String> {
        if pass != spec::PASS {
            return Err(format!("no mesh pass {pass:?} here"));
        }
        let spec: Value = serde_json::from_str(&spec).map_err(|e| e.to_string())?;
        displace::displace_face(
            face,
            &spec::Spec::read(&spec),
            tag == BLEED,
            options.density_cap,
            options.split_creases,
        )
    }

    fn write_export(exporter: String, _bodies: Vec<ExportBody>, _options: String) -> Result<String, String> {
        Err(format!("no exporter {exporter:?} here"))
    }

    fn generate_shape(generator: String, _params: String) -> Result<Shape, String> {
        Err(format!("no shape generator {generator:?} here"))
    }
}

export!(Texture);
