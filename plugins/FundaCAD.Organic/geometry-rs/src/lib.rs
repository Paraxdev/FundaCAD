//! Node bodies as a FundaCAD plugin component. A node is a sized, turned
//! ellipsoid at a point; a chain of nodes is a limb lofted smoothly through
//! them; every limb and every node on no chain fuse into one solid.

wit_bindgen::generate!({
    world: "plugin",
    path: "../../../crates/fundacad-geom/wit",
});

mod limb;
mod math;
mod nodes;

use serde_json::Value;

use fundacad::plugin::types::BooleanOp;
pub use fundacad::plugin::{feature, kernel};

const FEATURE: &str = "organic";

/// Edges meeting at less than this many degrees are part of a smooth surface,
/// not a junction the blend should round.
const CREASE_DEG: f64 = 4.0;

fn ellipsoid(node: &nodes::Node) -> Result<Shape, String> {
    let ball = kernel::make_sphere((0.0, 0.0, 0.0), 1.0)?;
    let m = node.shape;
    let c = node.center;
    kernel::gtransform(&ball, &[
        m[0][0], m[0][1], m[0][2], c[0],
        m[1][0], m[1][1], m[1][2], c[1],
        m[2][0], m[2][1], m[2][2], c[2],
    ])
}

/// Every limb and every node on no chain, fused.
pub fn node_solid(raw: &Value) -> Result<Shape, String> {
    let nodes = nodes::read_nodes(raw)?;
    if nodes.is_empty() {
        return Err("add at least one node".into());
    }
    let chains = nodes::read_chains(raw, &nodes)?;
    let mut parts: Vec<Shape> = Vec::new();
    for chain in &chains {
        let ids: Vec<&str> = chain.iter().map(|&i| nodes[i].id.as_str()).collect();
        parts.push(limb::limb(&nodes, chain).map_err(|e| format!("the chain {}: {e}", ids.join(" > ")))?);
    }
    for (i, node) in nodes.iter().enumerate() {
        if !chains.iter().any(|c| c.contains(&i)) {
            parts.push(ellipsoid(node).map_err(|e| format!("node {}: {e}", node.id))?);
        }
    }
    let first = parts.remove(0);
    if parts.is_empty() {
        return Ok(first);
    }
    let tools: Vec<&Shape> = parts.iter().collect();
    kernel::boolean(BooleanOp::Fuse, &first, &tools)
}

fn warn(reason: String) {
    let entry = serde_json::json!({
        "kind": "edgeOpFailed",
        "reason": reason,
        "resolved": 0,
        "confidence": 0.5,
        "lossy": true,
    });
    feature::diagnostic(&entry.to_string());
}

/// The junctions rounded to `radius`, or the solid as it was with a warning
/// when the kernel refuses every one of them.
fn blended(solid: Shape, radius: f64) -> Shape {
    let creases: Vec<Shape> = solid
        .edges()
        .into_iter()
        .filter(|e| solid.dihedral_deg(e).is_some_and(|d| d > CREASE_DEG))
        .collect();
    if creases.is_empty() {
        return solid;
    }
    let refs: Vec<&Shape> = creases.iter().collect();
    match kernel::fillet(&solid, &refs, radius, true) {
        Ok(b) => {
            if b.skipped > 0 {
                warn(format!("{} of {} junction edges could not be blended and were left sharp", b.skipped, creases.len()));
            }
            b.shape
        }
        Err(e) => {
            warn(format!("the blend could not be applied ({e}), the node body is shown unblended"));
            solid
        }
    }
}

fn run(raw: &Value) -> Result<(), String> {
    let mut solid = node_solid(raw)?;
    let blend = match raw.get("blend") {
        None | Some(Value::Null) => 0.0,
        Some(v) => feature::number(&v.to_string()).map_err(|e| format!("blend: {e}"))?,
    };
    if blend > 0.0 {
        solid = blended(solid, blend);
    }
    let operation = raw.get("operation").and_then(Value::as_str).unwrap_or("new").to_owned();
    let targets: Vec<String> = match raw.get("targets") {
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        _ => vec![],
    };
    let name = raw.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("Node body");
    feature::combine(&solid, &operation, &targets, Some(name))
}

struct Organic;

impl Guest for Organic {
    fn register() -> Registration {
        Registration {
            features: vec![FEATURE.to_string()],
            mesh_passes: vec![],
            exporters: vec![],
            shape_generators: vec![],
        }
    }

    fn run_feature(type_name: String) -> Result<(), String> {
        if type_name != FEATURE {
            return Err(format!("unknown feature type: {type_name}"));
        }
        let raw: Value = serde_json::from_str(&feature::definition()).map_err(|e| e.to_string())?;
        run(&raw).map_err(|e| format!("Node body: {e}"))
    }

    fn resolve_pass(pass: String, _body: &Shape, _spec: String) -> Result<Vec<Claimed>, String> {
        Err(format!("no mesh pass {pass:?} here"))
    }

    fn displace(pass: String, _face: &Shape, _spec: String, _tag: String, _options: DisplaceOptions) -> Result<Mesh, String> {
        Err(format!("no mesh pass {pass:?} here"))
    }

    fn write_export(exporter: String, _bodies: Vec<ExportBody>, _options: String) -> Result<String, String> {
        Err(format!("no exporter {exporter:?} here"))
    }

    fn generate_shape(generator: String, _params: String) -> Result<Shape, String> {
        Err(format!("no shape generator {generator:?} here"))
    }
}

export!(Organic);
