//! The 3D Printing Toolbox's feature geometry as a FundaCAD plugin component,
//! the Rust twin of geometry/*.py. Every tool edits the body's exact B-rep
//! through the engine's generic kernel, so a later fillet or boolean sees the
//! reshaped hole.

wit_bindgen::generate!({
    world: "plugin",
    path: "../../../crates/fundacad-geom/wit",
});

mod edges;
mod g;
mod holes;
mod layers;
mod read;
mod ribs;
mod zip;

use serde_json::Value;

pub use fundacad::plugin::{feature, kernel};

const FEATURES: [&str; 8] = [
    "teardropHole",
    "roofBridge",
    "counterboreBridge",
    "sacrificialLayer",
    "threadRibs",
    "zipTieChannel",
    "elephantFootChamfer",
    "verticalFillet",
];

/// The feature being built: its JSON and the numbers read from it.
pub struct F {
    raw: Value,
}

impl F {
    fn load() -> Result<F, String> {
        let raw = serde_json::from_str(&feature::definition()).map_err(|e| e.to_string())?;
        Ok(F { raw })
    }

    /// `float(ctx.val(f.get(key, default)))`.
    pub fn num(&self, key: &str, default: f64) -> Result<f64, String> {
        match self.raw.get(key) {
            None => Ok(default),
            Some(v) => feature::number(&v.to_string()),
        }
    }

    /// `f.get(key) or default` for a string field.
    pub fn text<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        self.raw
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(default)
    }

    /// `bool(f.get(key, False))`.
    pub fn flag(&self, key: &str) -> bool {
        match self.raw.get(key) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
            Some(Value::String(s)) => !s.is_empty(),
            Some(Value::Array(a)) => !a.is_empty(),
            Some(Value::Object(o)) => !o.is_empty(),
        }
    }
}

struct Toolbox;

impl Guest for Toolbox {
    fn register() -> Registration {
        Registration {
            features: FEATURES.iter().map(|s| s.to_string()).collect(),
            mesh_passes: vec![],
            exporters: vec![],
            shape_generators: vec![],
        }
    }

    fn run_feature(type_name: String) -> Result<(), String> {
        let f = F::load()?;
        match type_name.as_str() {
            "teardropHole" => holes::teardrop(&f),
            "roofBridge" => holes::roof_bridge(&f),
            "counterboreBridge" => layers::counterbore_bridge(&f),
            "sacrificialLayer" => layers::sacrificial_layer(&f),
            "threadRibs" => ribs::thread_ribs(&f),
            "zipTieChannel" => zip::zip_tie_channel(&f),
            "elephantFootChamfer" => edges::elephant_foot_chamfer(&f),
            "verticalFillet" => edges::vertical_fillet(&f),
            other => Err(format!("unknown feature type: {other}")),
        }
    }

    fn resolve_pass(pass: String, _body: &Shape, _spec: String) -> Result<Vec<Shape>, String> {
        Err(format!("no mesh pass {pass:?} here"))
    }

    fn displace(pass: String, _face: &Shape, _triangles: Mesh, _spec: String, _cap: u32) -> Result<Mesh, String> {
        Err(format!("no mesh pass {pass:?} here"))
    }

    fn write_export(exporter: String, _bodies: Vec<ExportBody>, _options: String) -> Result<String, String> {
        Err(format!("no exporter {exporter:?} here"))
    }

    fn generate_shape(generator: String, _params: String) -> Result<Shape, String> {
        Err(format!("no shape generator {generator:?} here"))
    }
}

export!(Toolbox);
