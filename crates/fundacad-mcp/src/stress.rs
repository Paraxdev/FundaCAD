//! `stress`: a linear static analysis of one body, read out for an agent.
//!
//! The engine's `stress` op does the meshing and the solve. What lives here is
//! checking the arguments before anything is sent, so a malformed load costs
//! no rebuild, the reading of the reply as a short report, and the boundary of
//! the volume mesh it hands back, coloured by von Mises stress for the picture.
//!
//! Faces are held by `fixed` and by `supports` (fixed, pinned on a round face,
//! or a slider held only across its face), and `gravity` adds the body's
//! weight from the material's density. A support or a load may name `spots`
//! in place of faces, each a point on the body with a radius, for a place that
//! has no face of its own.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::describe::g_format;
use crate::render::{stress_color, Drawable, Rgb, Vec3};

/// The keys a load takes. Anything else is a typo that would otherwise be
/// dropped on the way to the engine.
const LOAD_KEYS: [&str; 4] = ["faces", "spots", "force", "pressure"];
const MATERIAL_KEYS: [&str; 5] = ["E", "nu", "yield", "density", "name"];
const SUPPORT_KEYS: [&str; 3] = ["type", "faces", "spots"];
const SUPPORT_TYPES: [&str; 3] = ["fixed", "pinned", "slider"];
const SELECTOR_HINT: &str = "take each face's selector from `inspect` with detail:true and selectors:true";

/// What the tool sends the engine, less the document, and whether it draws.
pub struct Request {
    pub payload: Map<String, Value>,
    pub image: bool,
    /// What each support is called in the report, in the order of the
    /// reply's `reactions`: `fixed` first when given, then each of `supports`.
    pub supports: Vec<String>,
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// A face selector or a list of them, each checked to be an object.
fn selectors(v: Option<&Value>, what: &str) -> Result<(), String> {
    let hint = SELECTOR_HINT;
    let list: Vec<&Value> = match v {
        None | Some(Value::Null) => return Err(format!("`{what}` is missing, {hint}")),
        Some(Value::Array(a)) if a.is_empty() => return Err(format!("`{what}` names no faces, {hint}")),
        Some(Value::Array(a)) => a.iter().collect(),
        Some(one) => vec![one],
    };
    let listed = matches!(v, Some(Value::Array(_)));
    for (i, sel) in list.iter().enumerate() {
        if !sel.is_object() {
            let at = if listed { format!("{what}[{i}]") } else { what.to_string() };
            return Err(format!("`{at}` is not a face selector, got {sel}. A face index is not one, {hint}"));
        }
    }
    Ok(())
}

/// A spot or a list of them, each a point on the body and a radius. Whether
/// there is one, as a support or a load with spots may leave its faces out.
fn spots(v: Option<&Value>, what: &str) -> Result<bool, String> {
    let list: Vec<&Value> = match v {
        None | Some(Value::Null) => return Ok(false),
        Some(Value::Array(a)) => a.iter().collect(),
        Some(one) => vec![one],
    };
    for (i, spot) in list.iter().enumerate() {
        let at = spot.get("at").and_then(Value::as_array);
        let placed = at.is_some_and(|a| a.len() == 3 && a.iter().all(|x| finite(x).is_some()));
        let sized = spot.get("radius").and_then(finite).is_some_and(|r| r > 0.0);
        if !(placed && sized) {
            return Err(format!(
                "`{what}[{i}]` is {{at, radius}}, a point [x, y, z] on the body's surface and a radius in mm above 0, got {spot}"
            ));
        }
    }
    Ok(!list.is_empty())
}

/// The faces of a support or a load, which it may leave out when it has spots.
fn faces_or_spots(m: &Map<String, Value>, at: &str) -> Result<bool, String> {
    let spotted = spots(m.get("spots"), &format!("{at}.spots"))?;
    if !(spotted && m.get("faces").is_none_or(Value::is_null)) {
        selectors(m.get("faces"), &format!("{at}.faces"))?;
    }
    Ok(spotted)
}

fn load(v: &Value, at: &str) -> Result<(), String> {
    let Some(m) = v.as_object() else {
        return Err(format!("`{at}` is {{faces, force}} or {{faces, pressure}}, got {v}"));
    };
    if let Some(k) = m.keys().find(|k| !LOAD_KEYS.contains(&k.as_str())) {
        return Err(format!(
            "`{at}` takes no '{k}', a load takes faces or spots and one of force or pressure"
        ));
    }
    faces_or_spots(m, at)?;
    let force = m.get("force").filter(|f| !f.is_null());
    let pressure = m.get("pressure").filter(|p| !p.is_null());
    match (force, pressure) {
        (Some(_), Some(_)) => Err(format!("`{at}` has both a force and a pressure, give one")),
        (None, None) => Err(format!("`{at}` needs a force [x, y, z] in N or a pressure in MPa")),
        (Some(f), None) => {
            let ok = f.as_array().is_some_and(|a| a.len() == 3 && a.iter().all(|x| finite(x).is_some()));
            if ok {
                Ok(())
            } else {
                Err(format!("`{at}.force` is three numbers [x, y, z] in N, got {f}"))
            }
        }
        (None, Some(p)) => match finite(p) {
            Some(_) => Ok(()),
            None => Err(format!("`{at}.pressure` is a number in MPa, got {p}")),
        },
    }
}

/// One of `supports`, and its name for the report.
fn support(v: &Value, at: &str) -> Result<String, String> {
    let Some(m) = v.as_object() else {
        return Err(format!("`{at}` is {{type, faces}}, a type of fixed, pinned or slider and the faces it holds, got {v}"));
    };
    if let Some(k) = m.keys().find(|k| !SUPPORT_KEYS.contains(&k.as_str())) {
        return Err(format!("`{at}` takes no '{k}', a support takes type and faces or spots"));
    }
    let kind = match m.get("type") {
        None | Some(Value::Null) => "fixed".to_string(),
        Some(Value::String(t)) if SUPPORT_TYPES.contains(&t.trim().to_lowercase().as_str()) => t.trim().to_lowercase(),
        Some(other) => {
            return Err(format!(
                "`{at}.type` is fixed (held still), pinned (a round face, free to turn about its axis) or slider (held across the face only), got {other}"
            ))
        }
    };
    if faces_or_spots(m, at)? && kind != "fixed" {
        return Err(format!(
            "`{at}` is {kind} and has spots, a spot is held every way, so make it fixed or give it faces only"
        ));
    }
    Ok(format!("{at} ({kind})"))
}

/// `gravity` is true (9.81 m/s2 down -Z), false, or [gx, gy, gz] in m/s2. A vector of no
/// length pulls nowhere, so it is off, and a request with no load is refused as without it.
fn gravity(v: Option<&Value>) -> Result<bool, String> {
    match v {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::Array(a)) if a.len() == 3 && a.iter().all(|x| finite(x).is_some()) => {
            Ok(a.iter().filter_map(finite).any(|x| x.abs() >= 1e-9))
        }
        Some(other) => Err(format!(
            "`gravity` is true for 9.81 m/s2 along -Z, false, or [gx, gy, gz] in m/s2, got {other}"
        )),
    }
}

fn material(v: &Value) -> Result<(), String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Ok(()),
        Value::Object(m) => {
            if let Some(k) = m.keys().find(|k| !MATERIAL_KEYS.contains(&k.as_str())) {
                return Err(format!(
                    "`material` takes no '{k}', a material of your own is {{E, nu, yield, density, name}}"
                ));
            }
            match m.get("E").and_then(finite) {
                Some(e) if e > 0.0 => {}
                _ => return Err("`material.E` is Young's modulus in MPa, a number above 0, e.g. 3500 for PLA".into()),
            }
            match m.get("nu").and_then(finite) {
                Some(nu) if nu > -1.0 && nu < 0.5 => {}
                _ => return Err("`material.nu` is Poisson's ratio, a number between -1 and 0.5, e.g. 0.36 for PLA".into()),
            }
            match m.get("yield") {
                None | Some(Value::Null) => {}
                Some(y) if finite(y).is_some_and(|y| y > 0.0) => {}
                Some(y) => return Err(format!("`material.yield` is a strength in MPa above 0, got {y}")),
            }
            match m.get("density") {
                None | Some(Value::Null) => {}
                Some(d) if finite(d).is_some_and(|d| d > 0.0) => {}
                Some(d) => {
                    return Err(format!("`material.density` is in g/cm3 above 0, e.g. 1.24 for PLA, got {d}"))
                }
            }
            match m.get("name") {
                None | Some(Value::Null | Value::String(_)) => Ok(()),
                Some(n) => Err(format!("`material.name` is text, got {n}")),
            }
        }
        other => Err(format!(
            "`material` is a preset name such as \"PLA\" or {{E, nu, yield}} in MPa, got {other}"
        )),
    }
}

/// The arguments, checked and turned into the engine's request. Everything
/// the engine would refuse for its shape alone is refused here, before a
/// rebuild; what needs the model (a selector that picks nothing, a material
/// name) is left to the engine, which names it.
pub fn request_of(args: &Map<String, Value>) -> Result<Request, String> {
    let body = match args.get("body") {
        Some(Value::String(b)) if !b.trim().is_empty() => b.clone(),
        None | Some(Value::Null) => {
            return Err("`body` is missing, name the body to analyse by id or name, as `build` lists it".into())
        }
        Some(other) => return Err(format!("`body` is a body id or name, got {other}")),
    };
    let supports: Vec<Value> = match args.get("supports") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(one) => vec![one.clone()],
    };
    let mut names = Vec::new();
    // `fixed` may be left out, or empty, when `supports` holds the body.
    let fixed = args.get("fixed").filter(|f| !f.is_null() && !(f.as_array().is_some_and(Vec::is_empty) && !supports.is_empty()));
    match fixed {
        None if supports.is_empty() => {
            return Err(format!(
                "`fixed` is missing, hold at least one face with `fixed` (held still) or `supports` (fixed, pinned or slider), {SELECTOR_HINT}"
            ))
        }
        None => {}
        Some(f) => {
            selectors(Some(f), "fixed")?;
            names.push("fixed".to_string());
        }
    }
    for (i, s) in supports.iter().enumerate() {
        names.push(support(s, &format!("supports[{i}]"))?);
    }
    let pulled = gravity(args.get("gravity"))?;
    let loads = match args.get("loads") {
        None | Some(Value::Null) if pulled => Vec::new(),
        None | Some(Value::Null) => {
            return Err(
                "`loads` is missing, give at least one {faces, force} or {faces, pressure}, or turn `gravity` on".into(),
            )
        }
        Some(Value::Array(a)) if a.is_empty() && !pulled => {
            return Err(
                "`loads` is empty, give at least one {faces, force} or {faces, pressure}, or turn `gravity` on".into(),
            )
        }
        Some(Value::Array(a)) => a.clone(),
        Some(one) => vec![one.clone()],
    };
    for (i, l) in loads.iter().enumerate() {
        load(l, &format!("loads[{i}]"))?;
    }
    // A null force or pressure reads as absent here, and the engine would take
    // a null it is sent as given, so it is dropped on the way.
    let loads: Vec<Value> = loads
        .into_iter()
        .map(|l| match l {
            Value::Object(m) => Value::Object(m.into_iter().filter(|(_, v)| !v.is_null()).collect()),
            other => other,
        })
        .collect();
    let mut payload = Map::new();
    payload.insert("body".into(), json!(body));
    if let Some(f) = fixed {
        payload.insert("fixed".into(), f.clone());
    }
    if !supports.is_empty() {
        payload.insert("supports".into(), Value::Array(supports));
    }
    if pulled {
        payload.insert("gravity".into(), args.get("gravity").cloned().unwrap_or(json!(true)));
    }
    payload.insert("loads".into(), Value::Array(loads));
    if let Some(m) = args.get("material").filter(|m| !m.is_null()) {
        material(m)?;
        if pulled && m.is_object() && m.get("density").is_none_or(Value::is_null) {
            return Err(
                "`gravity` needs the material's density in g/cm3, add `density` to `material`, e.g. 1.24 for PLA".into(),
            );
        }
        payload.insert("material".into(), m.clone());
    }
    if let Some(v) = args.get("size").filter(|v| !v.is_null()) {
        match finite(v) {
            Some(s) if s > 0.0 => {
                payload.insert("size".into(), json!(s));
            }
            _ => return Err(format!("`size` is an element size in mm above 0, got {v}")),
        }
    }
    if let Some(v) = args.get("maxElements").filter(|v| !v.is_null()) {
        match finite(v) {
            Some(n) if n >= 1.0 && n.fract() == 0.0 => {
                payload.insert("maxElements".into(), json!(n as u64));
            }
            _ => return Err(format!("`maxElements` is a whole number of elements above 0, got {v}")),
        }
    }
    let image = match args.get("image") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(other) => return Err(format!("`image` is true or false, got {other}")),
    };
    Ok(Request {
        payload,
        image,
        supports: names,
    })
}

/// Four significant figures, enough to compare and short enough to read.
fn sig(v: f64) -> String {
    if v == 0.0 || !v.is_finite() {
        return g_format(v);
    }
    let k = 10f64.powi(3 - v.abs().log10().floor() as i32);
    g_format((v * k).round() / k)
}

fn mm(v: f64) -> String {
    g_format((v * 1000.0).round() / 1000.0)
}

fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

fn triple(v: Option<&Value>, fmt: fn(f64) -> String) -> String {
    let xs: Vec<String> = v
        .and_then(Value::as_array)
        // Plus zero, so a component rounded to -0 reads as 0.
        .map(|a| a.iter().map(|x| fmt(x.as_f64().unwrap_or(0.0) + 0.0)).collect())
        .unwrap_or_default();
    format!("({})", xs.join(", "))
}

/// `body3 "Spring"`, or the id alone when the name says nothing more.
fn who(r: &Value) -> String {
    let id = r.get("body").and_then(Value::as_str).unwrap_or("?");
    match r.get("name").and_then(Value::as_str) {
        Some(n) if !n.is_empty() && n != id => format!("{id} \"{n}\""),
        _ => id.to_string(),
    }
}

/// The engine's reply as a few lines: what was analysed, the peaks and where,
/// the safety factor, the balance of load and reaction (the weight among the
/// loads, and each support's share when there is more than one), the mesh,
/// and the engine's warnings word for word. `supports` names the supports in
/// the order of the reply's `reactions`.
pub fn report(r: &Value, supports: &[String]) -> String {
    let empty = json!({});
    let mat = r.get("material").unwrap_or(&empty);
    let name = mat.get("name").and_then(Value::as_str).unwrap_or("?");
    let yield_part = f(mat, "yield").map_or(String::new(), |y| format!(", yield {} MPa", sig(y)));
    let mut out = vec![format!(
        "Stress in {}, {name} (E {} MPa, nu {}{yield_part}):",
        who(r),
        sig(f(mat, "E").unwrap_or(0.0)),
        sig(f(mat, "nu").unwrap_or(0.0)),
    )];

    let peak = r.get("maxVonMises").unwrap_or(&empty);
    let on = match peak.get("face").and_then(Value::as_u64) {
        Some(face) => format!("on face {face}"),
        None => "inside the body".into(),
    };
    out.push(format!(
        "peak von Mises {} MPa at {} {on}",
        sig(f(peak, "value").unwrap_or(0.0)),
        triple(peak.get("at"), mm)
    ));

    let disp = r.get("maxDisplacement").unwrap_or(&empty);
    out.push(format!(
        "largest deflection {} mm at {}, moving by {}",
        sig(f(disp, "value").unwrap_or(0.0)),
        triple(disp.get("at"), mm),
        triple(disp.get("vector"), sig)
    ));

    out.push(match f(r, "safetyFactor") {
        Some(sf) if sf < 1.0 => format!(
            "safety factor {} against yield, BELOW 1: the peak is above the yield strength, so the part yields under this load",
            sig(sf)
        ),
        Some(sf) => format!("safety factor {} against yield (yield / peak von Mises)", sig(sf)),
        None if f(mat, "yield").is_none() => "no safety factor, the material has no yield strength".into(),
        None => "no safety factor, nothing is stressed".into(),
    });

    let at = if supports.len() == 1 && supports[0] == "fixed" { "the fixed faces" } else { "the supports" };
    out.push(format!(
        "applied {} N, reaction at {at} {} N",
        triple(r.get("applied"), sig),
        triple(r.get("reaction"), sig)
    ));
    if let Some(w) = r.get("weight").filter(|w| w.is_array()) {
        out.push(format!("weight {} N from gravity, part of the applied load", triple(Some(w), sig)));
    }
    let shares = r.get("reactions").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    if shares.len() > 1 {
        out.push("reaction at each support:".into());
        for (i, share) in shares.iter().enumerate() {
            let name = supports.get(i).cloned().unwrap_or_else(|| format!("support {i}"));
            out.push(format!("- {name}: {} N", triple(Some(share), sig)));
        }
    }

    let mesh = r.get("mesh").unwrap_or(&empty);
    let count = |k: &str| mesh.get(k).and_then(Value::as_u64).unwrap_or(0);
    let mut line = format!(
        "mesh: {} quadratic tetrahedra, {} nodes, element size {} mm",
        count("elements"),
        count("nodes"),
        sig(f(mesh, "size").unwrap_or(0.0))
    );
    if let Some(d) = f(mesh, "minDihedral") {
        line.push_str(&format!(", smallest dihedral angle {} deg", g_format(d)));
    }
    out.push(line);

    let warnings: Vec<&str> = r
        .get("warnings")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !warnings.is_empty() {
        out.push("warnings:".into());
        out.extend(warnings.iter().map(|w| format!("- {w}")));
    }
    out.join("\n")
}

/// The boundary of the volume mesh, coloured by von Mises stress, to draw.
pub struct Surface {
    pub id: String,
    pub positions: Vec<f64>,
    pub indices: Vec<usize>,
    pub face_ids: Vec<f64>,
    pub colors: Vec<Rgb>,
    /// The edges between faces, which the surface has no B-rep edges for.
    pub edges: Vec<Vec<Vec3>>,
    /// The stress at the blue and the red end of the scale, in MPa.
    pub low: f64,
    pub high: f64,
}

fn numbers(v: Option<&Value>) -> Vec<f64> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect())
        .unwrap_or_default()
}

/// The reply's `surface`, or None when it has nothing to draw. The scale runs
/// from the least to the most stress on the surface.
pub fn surface_of(r: &Value) -> Option<Surface> {
    let s = r.get("surface")?;
    let positions = numbers(s.get("positions"));
    let vertices = positions.len() / 3;
    let indices: Vec<usize> = numbers(s.get("indices")).into_iter().map(|i| i as usize).collect();
    let face_ids = numbers(s.get("faceIds"));
    let values = numbers(s.get("vonMises"));
    if vertices == 0 || indices.len() < 3 || values.len() != vertices || indices.iter().any(|&i| i >= vertices) {
        return None;
    }
    let low = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let high = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let span = high - low;
    let colors = values
        .iter()
        .map(|&v| stress_color(if span > 0.0 { (v - low) / span } else { 0.0 }))
        .collect();

    // An edge whose two triangles lie on different faces is a face boundary.
    // Walked in triangle order, so the same reply draws the same lines.
    let point = |i: usize| -> Vec3 { [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]] };
    let mut seen: HashMap<(usize, usize), f64> = HashMap::new();
    let mut edges = Vec::new();
    for (t, tri) in indices.chunks_exact(3).enumerate() {
        let face = face_ids.get(t).copied().unwrap_or(-1.0);
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            let key = (a.min(b), a.max(b));
            match seen.get(&key) {
                Some(&other) if other != face => edges.push(vec![point(a), point(b)]),
                Some(_) => {}
                None => {
                    seen.insert(key, face);
                }
            }
        }
    }
    Some(Surface {
        id: r.get("body").and_then(Value::as_str).unwrap_or_default().to_string(),
        positions,
        indices,
        face_ids,
        colors,
        edges,
        low,
        high,
    })
}

impl Surface {
    /// What the picture shows, for the caption: the image has no text.
    pub fn scale(&self) -> String {
        format!(
            "Coloured by von Mises stress, blue {} MPa to red {} MPa, the bar at the right is the scale.",
            sig(self.low),
            sig(self.high)
        )
    }
}

impl Drawable for Surface {
    fn body_id(&self) -> Option<&str> {
        Some(&self.id)
    }
    fn positions(&self) -> Vec<f64> {
        self.positions.clone()
    }
    fn indices(&self) -> Vec<usize> {
        self.indices.clone()
    }
    fn face_ids(&self) -> Vec<f64> {
        self.face_ids.clone()
    }
    fn polylines(&self) -> Vec<Vec<Vec3>> {
        self.edges.clone()
    }
    fn vertex_colors(&self) -> Option<Vec<Rgb>> {
        Some(self.colors.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    fn face(dir: [f64; 3]) -> Value {
        json!({"kind": "face", "by": "normal", "dir": dir})
    }

    #[test]
    fn a_well_formed_request_passes_through_and_draws_by_default() {
        let r = request_of(&args(json!({
            "body": "body1",
            "fixed": face([-1.0, 0.0, 0.0]),
            "loads": {"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -100]},
            "material": {"E": 2300, "nu": 0.35, "yield": 40, "name": "my PETG"},
            "size": 2.5,
            "maxElements": 20000,
        })))
        .expect("a good request");
        assert!(r.image);
        assert_eq!(r.payload["loads"].as_array().map(Vec::len), Some(1));
        assert_eq!(r.payload["maxElements"], json!(20000));
        assert!(r.payload.get("document").is_none());
    }

    #[test]
    fn a_null_force_or_pressure_is_left_out_of_the_request() {
        let r = request_of(&args(json!({
            "body": "body1",
            "fixed": face([-1.0, 0.0, 0.0]),
            "loads": [
                {"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1], "pressure": null},
                {"faces": [face([0.0, 0.0, 1.0])], "force": null, "pressure": 1},
            ],
        })))
        .expect("nulls read as absent");
        let loads = r.payload["loads"].as_array().expect("loads");
        assert!(loads[0].get("pressure").is_none(), "{}", loads[0]);
        assert_eq!(loads[0]["force"], json!([0, 0, -1]));
        assert!(loads[1].get("force").is_none(), "{}", loads[1]);
        assert_eq!(loads[1]["pressure"], json!(1));
    }

    #[test]
    fn malformed_arguments_are_named() {
        let base = || {
            json!({"body": "body1", "fixed": [face([-1.0, 0.0, 0.0])],
                   "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1]}]})
        };
        let refused = |patch: Value| {
            let mut a = base();
            for (k, v) in patch.as_object().expect("an object") {
                a[k] = v.clone();
            }
            request_of(&args(a)).err().expect("refused")
        };
        assert!(refused(json!({"body": null})).contains("`body` is missing"));
        assert!(refused(json!({"fixed": []})).contains("`fixed` names no faces"));
        assert!(refused(json!({"fixed": [3]})).contains("`fixed[0]` is not a face selector"));
        assert!(refused(json!({"loads": []})).contains("`loads` is empty"));
        let both = refused(json!({"loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, 1], "pressure": 1}]}));
        assert!(both.contains("both a force and a pressure"), "{both}");
        assert!(refused(json!({"loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 1]}]}))
            .contains("`loads[0].force` is three numbers"));
        assert!(refused(json!({"loads": [{"faces": [face([1.0, 0.0, 0.0])], "push": 1}]}))
            .contains("takes no 'push'"));
        assert!(refused(json!({"material": {"E": 2300}})).contains("`material.nu`"));
        assert!(refused(json!({"material": 7})).contains("`material` is a preset name"));
        assert!(refused(json!({"size": 0})).contains("`size`"));
        assert!(refused(json!({"maxElements": 1.5})).contains("`maxElements`"));
        assert!(refused(json!({"image": "yes"})).contains("`image`"));
    }

    #[test]
    fn the_report_names_the_peaks_the_balance_and_the_warnings() {
        let r = json!({
            "body": "body1", "name": "Bar",
            "material": {"name": "PLA", "E": 3500.0, "nu": 0.36, "yield": 50.0},
            "mesh": {"nodes": 1200, "elements": 600, "size": 2.5, "minDihedral": 11.2},
            "maxVonMises": {"value": 61.23456, "at": [0.0, 5.0, 5.0], "face": 0},
            "maxDisplacement": {"value": 0.84, "at": [100.0, 5.0, -5.0], "vector": [0.0, 0.01, -0.84]},
            "safetyFactor": 0.8165,
            "applied": [0.0, 0.0, -100.0], "reaction": [0.0, 0.0, 100.0],
            "warnings": ["printed parts are weaker across their layers"],
        });
        let text = report(&r, &["fixed".to_string()]);
        assert!(text.starts_with("Stress in body1 \"Bar\", PLA (E 3500 MPa, nu 0.36, yield 50 MPa):"), "{text}");
        assert!(text.contains("peak von Mises 61.23 MPa at (0, 5, 5) on face 0"), "{text}");
        assert!(text.contains("largest deflection 0.84 mm at (100, 5, -5)"), "{text}");
        assert!(text.contains("safety factor 0.8165 against yield, BELOW 1"), "{text}");
        assert!(text.contains("applied (0, 0, -100) N, reaction at the fixed faces (0, 0, 100) N"), "{text}");
        assert!(text.contains("mesh: 600 quadratic tetrahedra, 1200 nodes, element size 2.5 mm"), "{text}");
        assert!(text.ends_with("warnings:\n- printed parts are weaker across their layers"), "{text}");
    }

    #[test]
    fn supports_and_gravity_pass_through_named_in_order() {
        let r = request_of(&args(json!({
            "body": "body1",
            "fixed": face([-1.0, 0.0, 0.0]),
            "supports": [
                {"type": "pinned", "faces": [face([0.0, 1.0, 0.0])]},
                {"faces": face([0.0, 0.0, -1.0])},
            ],
            "gravity": [0, 0, -9.81],
            "material": {"E": 2300, "nu": 0.35, "density": 1.27},
        })))
        .expect("a good request");
        assert_eq!(r.supports, vec!["fixed", "supports[0] (pinned)", "supports[1] (fixed)"]);
        assert_eq!(r.payload["gravity"], json!([0, 0, -9.81]));
        assert_eq!(r.payload["supports"].as_array().map(Vec::len), Some(2));
        assert_eq!(r.payload["loads"], json!([]));
        // Supports alone hold the body, and an empty `fixed` beside them is dropped.
        let r = request_of(&args(json!({
            "body": "body1", "fixed": [],
            "supports": {"type": "Slider", "faces": face([0.0, 0.0, -1.0])},
            "loads": [{"faces": face([0.0, 0.0, 1.0]), "pressure": 0.1}],
            "gravity": false,
        })))
        .expect("supports alone");
        assert!(r.payload.get("fixed").is_none() && r.payload.get("gravity").is_none());
        assert_eq!(r.supports, vec!["supports[0] (slider)"]);
    }

    #[test]
    fn spots_stand_in_for_faces_and_are_checked() {
        let spot = json!({"at": [95, 0, 5], "radius": 4});
        let r = request_of(&args(json!({
            "body": "body1",
            "supports": [{"spots": [{"at": [0, 0, 0], "radius": 3}]}],
            "loads": {"spots": spot, "force": [0, 0, -5], "faces": null},
        })))
        .expect("spots alone");
        assert_eq!(r.supports, vec!["supports[0] (fixed)"]);
        assert_eq!(r.payload["loads"], json!([{"spots": spot, "force": [0, 0, -5]}]));

        let refused = |patch: Value| {
            let mut a = json!({"body": "body1", "fixed": face([-1.0, 0.0, 0.0]),
                               "loads": [{"spots": [spot], "force": [0, 0, -1]}]});
            for (k, v) in patch.as_object().expect("an object") {
                a[k] = v.clone();
            }
            request_of(&args(a)).err().expect("refused")
        };
        assert!(refused(json!({"loads": [{"spots": [{"at": [0, 0], "radius": 2}], "force": [0, 0, -1]}]}))
            .contains("`loads[0].spots[0]` is {at, radius}"));
        assert!(refused(json!({"loads": [{"spots": [{"at": [0, 0, 0], "radius": 0}], "force": [0, 0, -1]}]}))
            .contains("a radius in mm above 0"));
        assert!(refused(json!({"loads": [{"spots": [], "force": [0, 0, -1]}]})).contains("`loads[0].faces` is missing"));
        let slider = refused(json!({"supports": [{"type": "slider", "spots": [spot]}]}));
        assert!(slider.contains("`supports[0]` is slider and has spots"), "{slider}");
    }

    #[test]
    fn malformed_supports_and_gravity_are_named() {
        let base = || json!({"body": "body1", "supports": [{"type": "slider", "faces": face([0.0, 0.0, -1.0])}],
                             "loads": [{"faces": [face([1.0, 0.0, 0.0])], "force": [0, 0, -1]}]});
        let refused = |patch: Value| {
            let mut a = base();
            for (k, v) in patch.as_object().expect("an object") {
                a[k] = v.clone();
            }
            request_of(&args(a)).err().expect("refused")
        };
        let none = refused(json!({"supports": null}));
        assert!(none.contains("`fixed` is missing, hold at least one face with `fixed`") && none.contains("`supports`"), "{none}");
        assert!(refused(json!({"supports": [{"type": "glued", "faces": face([0.0, 0.0, 1.0])}]}))
            .contains("`supports[0].type` is fixed (held still), pinned"));
        assert!(refused(json!({"supports": [{"type": "slider"}]})).contains("`supports[0].faces` is missing"));
        assert!(refused(json!({"supports": [{"faces": face([0.0, 0.0, 1.0]), "axis": [0, 0, 1]}]}))
            .contains("`supports[0]` takes no 'axis'"));
        assert!(refused(json!({"supports": [7]})).contains("`supports[0]` is {type, faces}"));
        assert!(refused(json!({"gravity": "down"})).contains("`gravity` is true for 9.81 m/s2 along -Z"));
        assert!(refused(json!({"gravity": [0, -9.81]})).contains("`gravity`"));
        let dense = refused(json!({"gravity": true, "material": {"E": 2000, "nu": 0.3}}));
        assert!(dense.contains("`gravity` needs the material's density in g/cm3"), "{dense}");
        assert!(refused(json!({"material": {"E": 2000, "nu": 0.3, "density": 0}})).contains("`material.density`"));
        let no_load = refused(json!({"loads": []}));
        assert!(no_load.contains("or turn `gravity` on"), "{no_load}");
        // With gravity on the loads may be left out.
        let mut a = base();
        a.as_object_mut().unwrap().remove("loads");
        a["gravity"] = json!(true);
        assert!(request_of(&args(a.clone())).is_ok());
        // A vector of no length pulls nowhere: it is no gravity, so no load is refused, and
        // beside a load it is not sent on.
        a["gravity"] = json!([0, 0, 0]);
        let none = request_of(&args(a)).err().expect("refused");
        assert!(none.contains("`loads` is missing"), "{none}");
        let mut a = base();
        a["gravity"] = json!([0.0, -0.0, 0.0]);
        assert!(request_of(&args(a)).expect("a load").payload.get("gravity").is_none());
    }

    #[test]
    fn the_report_names_the_weight_and_each_supports_reaction() {
        let r = json!({
            "body": "body1",
            "material": {"name": "PLA", "E": 3500.0, "nu": 0.36, "yield": 50.0, "density": 1.24},
            "maxVonMises": {"value": 1.0, "at": [0.0, 0.0, 0.0], "face": 0},
            "applied": [0.0, 0.0, -100.121644], "weight": [0.0, 0.0, -0.121644],
            "reaction": [0.0, 0.0, 100.121644],
            "reactions": [[0.0, 0.0, 60.0], [0.0, 0.0, 40.121644]],
        });
        let names = ["fixed".to_string(), "supports[0] (slider)".to_string()];
        let text = report(&r, &names);
        assert!(text.contains("applied (0, 0, -100.1) N, reaction at the supports (0, 0, 100.1) N"), "{text}");
        assert!(text.contains("\nweight (0, 0, -0.1216) N from gravity, part of the applied load\n"), "{text}");
        assert!(
            text.contains("reaction at each support:\n- fixed: (0, 0, 60) N\n- supports[0] (slider): (0, 0, 40.12) N"),
            "{text}"
        );
        // One support and no gravity read as before.
        let one = json!({"applied": [0.0, 0.0, -1.0], "reaction": [0.0, 0.0, 1.0], "weight": null,
                         "reactions": [[0.0, 0.0, 1.0]]});
        let text = report(&one, &["supports[0] (pinned)".to_string()]);
        assert!(text.contains("reaction at the supports (0, 0, 1) N"), "{text}");
        assert!(!text.contains("weight") && !text.contains("each support"), "{text}");
    }

    #[test]
    fn the_surface_is_coloured_from_low_to_high_and_outlines_its_faces() {
        // Two triangles of a square on different faces, sharing the diagonal.
        let r = json!({"body": "body1", "surface": {
            "positions": [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
            "indices": [0, 1, 2, 0, 2, 3],
            "faceIds": [0, 1],
            "vonMises": [0.0, 5.0, 10.0, 5.0],
        }});
        let s = surface_of(&r).expect("a surface");
        assert_eq!(s.colors[0], stress_color(0.0));
        assert_eq!(s.colors[2], stress_color(1.0));
        assert_eq!(s.edges.len(), 1);
        assert_eq!((s.low, s.high), (0.0, 10.0));
        assert!(s.scale().contains("blue 0 MPa to red 10 MPa"), "{}", s.scale());
    }
}
