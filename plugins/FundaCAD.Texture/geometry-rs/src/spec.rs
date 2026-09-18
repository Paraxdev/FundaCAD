//! texture.py `validate_texture_spec`, and the spec a mesh pass reads back.

use serde_json::{json, Map, Value};

use crate::height::Gray;
use crate::py;

pub const KINDS: [&str; 16] = [
    "knurl", "hex", "waves", "ribs", "voronoi", "noise", "image", "stripes", "grid", "dots", "brick",
    "basket", "carbon", "isogrid", "grip", "leather",
];

pub const PASS: &str = "texture";

/// `isinstance(v, (int, float))`, a bool counting as the int it is.
fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

/// The same, with `not isinstance(v, bool)` as well.
fn strict_number(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(_) => None,
        other => number(other),
    }
}

fn field<'a>(f: &'a Map<String, Value>, key: &str, default: &'a Value) -> &'a Value {
    f.get(key).unwrap_or(default)
}

fn member(v: &Value, set: &[&str]) -> bool {
    v.as_str().is_some_and(|s| set.contains(&s))
}

fn fl(v: &Value) -> Result<f64, String> {
    py::float(v)
}

/// The cleaned spec the feature stashes on its body, or the sentence a bad
/// value is refused with. `image_ok` checks that an image path opens.
pub fn validate(f: &Map<String, Value>, image_ok: &dyn Fn(&str) -> Result<(), String>) -> Result<Value, String> {
    let null = Value::Null;
    let kind = f.get("kind").unwrap_or(&null);
    if !member(kind, &KINDS) {
        return Err(format!("unknown texture kind: {}", py::repr(kind)));
    }
    let kind = kind.as_str().unwrap_or_default().to_string();
    let d_depth = json!(0.4);
    let depth = field(f, "depth", &d_depth);
    let depth_v = number(depth).filter(|&d| d > 0.0).ok_or("texture depth must be a positive number")?;
    let d_scale = json!(2.0);
    let scale_v = number(field(f, "scale", &d_scale))
        .filter(|&s| s > 0.0)
        .ok_or("texture scale must be a positive number")?;
    let d_dir = json!("out");
    let direction = field(f, "direction", &d_dir);
    if !member(direction, &["out", "in", "both"]) {
        return Err(format!("unknown texture direction: {}", py::repr(direction)));
    }
    let d_prof = json!("facet");
    let profile = field(f, "profile", &d_prof);
    if !member(profile, &["facet", "round"]) {
        return Err(format!(
            "unknown texture profile: {} (expected facet or round)",
            py::repr(profile)
        ));
    }
    let zero = json!(0.0);
    let inset = number(field(f, "boundaryInset", &zero))
        .filter(|&x| x >= 0.0)
        .ok_or("texture edge blend must be zero or a positive number")?;
    let grime = strict_number(field(f, "grime", &zero))
        .filter(|&x| x >= 0.0)
        .ok_or("texture grime must be zero or a positive number")?;
    let smooth = strict_number(field(f, "smooth", &zero))
        .filter(|&x| x >= 0.0)
        .ok_or("texture smooth must be zero or a positive number")?;
    let d_proj = json!("triplanar");
    let projection = field(f, "projection", &d_proj);
    if !member(projection, &["auto", "triplanar", "box"]) {
        return Err(format!(
            "unknown texture projection: {} (expected auto, triplanar or box)",
            py::repr(projection)
        ));
    }
    let half = json!(0.5);
    for seam in ["seamBlend", "seamBand"] {
        if strict_number(field(f, seam, &half)).filter(|&x| x >= 0.0).is_none() {
            return Err(format!("texture {seam} must be zero or a positive number"));
        }
    }
    let one = json!(1.0);
    let amplitude = strict_number(field(f, "amplitude", &one))
        .filter(|&x| x >= 0.0)
        .ok_or("texture amplitude must be zero or a positive number")?;
    for slope in ["slopeMin", "slopeMax"] {
        if strict_number(field(f, slope, &zero)).filter(|&x| x >= 0.0).is_none() {
            return Err(format!("texture {slope} must be zero or a positive number"));
        }
    }
    let target_edge = strict_number(field(f, "targetEdge", &zero))
        .filter(|&x| x >= 0.0)
        .ok_or("texture mesh detail (targetEdge) must be zero or a positive number")?;
    let izero = json!(0);
    let tri_budget = strict_number(field(f, "triBudget", &izero))
        .filter(|&x| x >= 0.0)
        .ok_or("texture triangle budget must be zero or a positive number")?;
    let image_path = f.get("imagePath");
    if kind == "image" {
        let path = image_path.filter(|p| py::truthy(p)).ok_or("image texture needs an image path")?;
        let text = path.as_str().map(str::to_owned).unwrap_or_else(|| py::str_of(path));
        image_ok(&text).map_err(|e| format!("can't read texture image {}: {e}", py::repr(path)))?;
    }

    let mut spec = Map::new();
    spec.insert("pass".into(), PASS.into());
    spec.insert("feature_id".into(), f.get("id").cloned().unwrap_or(Value::Null));
    spec.insert("kind".into(), kind.clone().into());
    spec.insert(
        "faces".into(),
        f.get("faces").filter(|v| py::truthy(v)).cloned().unwrap_or(json!({"by": "all"})),
    );
    spec.insert("body".into(), f.get("body").cloned().unwrap_or(Value::Null));
    spec.insert("depth".into(), json!(depth_v));
    spec.insert("scale".into(), json!(scale_v));
    spec.insert("angle".into(), json!(fl(field(f, "angle", &zero))?));
    spec.insert("offset".into(), json!(fl(field(f, "offset", &zero))?));
    spec.insert("sharpness".into(), json!(fl(field(f, "sharpness", &half))?));
    spec.insert("profile".into(), profile.clone());
    spec.insert("direction".into(), direction.clone());
    let seed = match f.get("seed").filter(|v| py::truthy(v)) {
        Some(v) => py::int(v)?,
        None => 0,
    };
    spec.insert("seed".into(), json!(seed));
    let octaves = match f.get("octaves").filter(|v| py::truthy(v)) {
        Some(v) => py::int(v)?,
        None => 3,
    };
    spec.insert("octaves".into(), json!(octaves.clamp(1, 6)));
    spec.insert("invert".into(), json!(f.get("invert").is_some_and(py::truthy)));
    spec.insert("boundaryInset".into(), json!(inset.max(0.0)));
    if kind == "image" {
        spec.insert("imagePath".into(), image_path.cloned().unwrap_or(Value::Null));
    }
    if let Some(slot) = f.get("colorSlot").and_then(strict_number) {
        if slot.trunc() >= 0.0 {
            spec.insert("colorSlot".into(), json!(slot.trunc() as i64));
        }
    }
    if grime > 0.0 {
        spec.insert("grime".into(), json!(grime.min(1.0)));
    }
    if smooth > 0.0 {
        spec.insert("smooth".into(), json!(smooth.min(1.0)));
    }
    let projection = projection.as_str().unwrap_or("triplanar");
    if projection != "triplanar" {
        spec.insert("projection".into(), projection.into());
    }
    if projection == "triplanar" {
        let b = fl(field(f, "seamBlend", &half))?;
        if (b - 0.5).abs() > 1e-9 {
            spec.insert("seamBlend".into(), json!(b.clamp(0.0, 1.0)));
        }
    }
    if projection == "box" {
        let b = fl(field(f, "seamBand", &half))?;
        if (b - 0.5).abs() > 1e-9 {
            spec.insert("seamBand".into(), json!(b.clamp(0.0, 1.0)));
        }
    }
    if (amplitude - 1.0).abs() > 1e-9 {
        spec.insert("amplitude".into(), json!(amplitude.clamp(0.0, 1.0)));
    }
    let slope_min = fl(field(f, "slopeMin", &zero))?.clamp(0.0, 180.0);
    let d180 = json!(180.0);
    let slope_max = fl(field(f, "slopeMax", &d180))?.clamp(0.0, 180.0);
    if slope_min > 1e-9 {
        spec.insert("slopeMin".into(), json!(slope_min));
    }
    if slope_max < 180.0 - 1e-9 {
        spec.insert("slopeMax".into(), json!(slope_max));
    }
    if target_edge > 0.0 {
        spec.insert("targetEdge".into(), json!(target_edge));
    }
    if tri_budget > 0.0 {
        spec.insert("triBudget".into(), json!(tri_budget.trunc() as i64));
    }
    Ok(Value::Object(spec))
}

/// A stashed spec as displacement reads it, `spec.get(key, default)` each.
#[derive(Clone)]
pub struct Spec {
    pub kind: String,
    pub depth: f64,
    pub scale: f64,
    pub angle: f64,
    pub offset: f64,
    pub sharpness: f64,
    pub profile: String,
    pub direction: String,
    pub seed: i64,
    pub octaves: i64,
    pub invert: bool,
    pub boundary_inset: f64,
    pub grime: f64,
    pub smooth: f64,
    pub projection: String,
    pub seam_blend: f64,
    pub seam_band: f64,
    pub amplitude: f64,
    pub slope_min: f64,
    pub slope_max: f64,
    pub target_edge: f64,
    pub tri_budget: i64,
    pub image_path: Option<String>,
    pub image: Option<std::rc::Rc<Gray>>,
}

fn num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).map_or(default, |x| py::float(x).unwrap_or(f64::NAN))
}

fn text(v: &Value, key: &str, default: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or(default).to_string()
}

impl Spec {
    pub fn read(v: &Value) -> Spec {
        Spec {
            kind: text(v, "kind", ""),
            depth: num(v, "depth", 0.4),
            scale: num(v, "scale", 2.0),
            angle: num(v, "angle", 0.0),
            offset: num(v, "offset", 0.0),
            sharpness: num(v, "sharpness", 0.5),
            profile: text(v, "profile", "facet"),
            direction: text(v, "direction", "out"),
            seed: v.get("seed").map_or(0, |s| py::int(s).unwrap_or(0)),
            octaves: v.get("octaves").map_or(3, |s| py::int(s).unwrap_or(3)),
            invert: v.get("invert").is_some_and(py::truthy),
            boundary_inset: num(v, "boundaryInset", 0.0),
            grime: num(v, "grime", 0.0),
            smooth: num(v, "smooth", 0.0),
            projection: text(v, "projection", "triplanar"),
            seam_blend: num(v, "seamBlend", 0.5),
            seam_band: num(v, "seamBand", 0.5),
            amplitude: num(v, "amplitude", 1.0),
            slope_min: num(v, "slopeMin", 0.0),
            slope_max: num(v, "slopeMax", 180.0),
            target_edge: num(v, "targetEdge", 0.0),
            tri_budget: v.get("triBudget").map_or(0, |s| py::int(s).unwrap_or(0)),
            image_path: v.get("imagePath").and_then(Value::as_str).map(str::to_owned),
            image: None,
        }
    }

    /// `_is_facet`: hard surface unless the profile is "round".
    pub fn facet(&self) -> bool {
        self.profile != "round"
    }
}
