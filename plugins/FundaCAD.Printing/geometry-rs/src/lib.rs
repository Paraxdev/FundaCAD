//! The printer connection's geometry half as a FundaCAD plugin component, the
//! Rust twin of geometry/*.py: the slicer project 3MF exporter. The engine
//! rebuilds, meshes and budgets; this decides what the file looks like. The
//! LAN device talk and the native commands are not engine geometry and stay in
//! the window half.

wit_bindgen::generate!({
    world: "plugin",
    path: "../../../crates/fundacad-geom/wit",
});

mod presets;
mod project;
pub mod py;
mod zipw;

use serde_json::{Map, Value};

pub const EXPORTER: &str = "print-project-3mf";

/// The settings a project carries when no slicer presets could be read: the
/// minimal keys Orca needs to pick the machine on "open as project".
fn base_settings() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("printer_model".into(), "Snapmaker U1".into());
    m.insert("printer_variant".into(), "0.4".into());
    m.insert("version".into(), "2.4.0.0".into());
    m
}

/// register.py `export_project`: options {palette, bodyColors, bodyNames,
/// settings?, presets?: {datadir, filamentCount}}. Failing to read the presets
/// is not an error, the project still carries the colours, and `info.presets`
/// says which happened.
fn export_project(bodies: &[ExportBody], options: &Value) -> Result<Value, String> {
    let (palette, colors, names) = project::sanitize_inputs(
        options.get("palette"),
        options.get("bodyColors"),
        options.get("bodyNames"),
    );
    let mut settings = base_settings();
    if let Some(Value::Object(extra)) = options.get("settings") {
        for (k, v) in extra {
            settings.insert(k.clone(), v.clone());
        }
    }
    let mut info = Map::new();
    if let Some(Value::Object(p)) = options.get("presets") {
        match presets::project_settings(p.get("datadir"), p.get("filamentCount")) {
            Ok(cfg) => {
                for (k, v) in cfg {
                    settings.insert(k, v);
                }
                info.insert("presets".into(), Value::Bool(true));
            }
            Err(e) => {
                info.insert("presets".into(), Value::Bool(false));
                info.insert("presetError".into(), Value::String(e.chars().take(300).collect()));
            }
        }
    }
    project::write_project_3mf(bodies, &palette, &colors, &names, &settings)?;
    Ok(Value::Object(info))
}

struct Printing;

impl Guest for Printing {
    fn register() -> Registration {
        Registration {
            features: vec![],
            mesh_passes: vec![],
            exporters: vec![EXPORTER.to_string()],
            shape_generators: vec![],
        }
    }

    fn run_feature(type_name: String) -> Result<(), String> {
        Err(format!("unknown feature type: {type_name}"))
    }

    fn resolve_pass(pass: String, _body: &Shape, _spec: String) -> Result<Vec<Claimed>, String> {
        Err(format!("no mesh pass {pass:?} here"))
    }

    fn displace(pass: String, _face: &Shape, _spec: String, _tag: String, _options: DisplaceOptions) -> Result<Mesh, String> {
        Err(format!("no mesh pass {pass:?} here"))
    }

    fn write_export(exporter: String, bodies: Vec<ExportBody>, options: String) -> Result<String, String> {
        if exporter != EXPORTER {
            return Err(format!("no exporter {exporter:?} here"));
        }
        let options: Value = serde_json::from_str(&options).map_err(|e| e.to_string())?;
        let info = export_project(&bodies, &options)?;
        Ok(serde_json::to_string(&info).map_err(|e| e.to_string())?)
    }

    fn generate_shape(generator: String, _params: String) -> Result<Shape, String> {
        Err(format!("no shape generator {generator:?} here"))
    }
}

export!(Printing);
