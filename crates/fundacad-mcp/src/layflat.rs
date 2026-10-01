//! `export {layFlat}`: each part turned so a flat face is on the bed.
//!
//! Done to a copy of the document, with the `move` features a person would
//! add by hand: a turn that points the chosen face straight down, then a shift
//! that puts the part on z = 0 beside the one before it. The document the
//! agent is working on never sees them.

use serde_json::{json, Map, Value};

use crate::link::EngineLink;
use crate::model::{self, Doc};
use crate::server::{engine_bodies, find_body, no_such_body};

/// Space left between parts laid side by side, in mm.
const GAP: f64 = 5.0;

/// The intrinsic XYZ angles (degrees, `move`'s rx and ry with rz 0) that
/// turn the direction `n` to point straight down.
///
/// `move` turns by Rx(a) Ry(b) about the origin, which sends n to -Z when
/// n = (cos a sin b, -sin a, -cos a cos b).
pub fn face_down(n: [f64; 3]) -> (f64, f64) {
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    let [x, y, z] = if len > 0.0 { [n[0] / len, n[1] / len, n[2] / len] } else { [0.0, 0.0, -1.0] };
    let a = (-y).clamp(-1.0, 1.0).asin();
    let b = if a.cos() < 1e-9 { 0.0 } else { x.atan2(-z) };
    (round6(a.to_degrees()), round6(b.to_degrees()))
}

fn round6(v: f64) -> f64 {
    let r = (v * 1e6).round() / 1e6;
    if r == 0.0 { 0.0 } else { r }
}

fn vec3(v: Option<&Value>) -> Option<[f64; 3]> {
    let a = v?.as_array()?;
    Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?])
}

fn id_of(b: &Value) -> String {
    b.get("id").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The face each body goes down on: the one asked for, else its largest
/// flat face. None for a body with no flat face at all.
fn pick_face(body: &Value, asked: Option<i64>) -> Result<Option<(i64, [f64; 3], f64)>, String> {
    let faces = body.get("faces").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let as_pick = |f: &Value| -> Option<(i64, [f64; 3], f64)> {
        Some((f.get("i")?.as_i64()?, vec3(f.get("normal"))?, f.get("area")?.as_f64()?))
    };
    if let Some(i) = asked {
        let Some(f) = faces.iter().find(|f| f.get("i").and_then(Value::as_i64) == Some(i)) else {
            return Err(format!("{} has no face {i}, `inspect` lists its faces", id_of(body)));
        };
        if f.get("surface").and_then(Value::as_str) != Some("plane") {
            return Err(format!(
                "face {i} of {} is not flat, a part can only sit on a flat face",
                id_of(body)
            ));
        }
        return Ok(as_pick(f));
    }
    Ok(faces
        .iter()
        .filter(|f| f.get("surface").and_then(Value::as_str) == Some("plane"))
        .filter_map(as_pick)
        .max_by(|a, b| a.2.total_cmp(&b.2)))
}

fn add_move(doc: &mut Doc, id: &str, turn: (f64, f64), shift: [f64; 3]) -> Result<(), String> {
    let mut m = Map::new();
    m.insert("type".into(), json!("move"));
    m.insert("rx".into(), json!(turn.0));
    m.insert("ry".into(), json!(turn.1));
    m.insert("rz".into(), json!(0));
    m.insert("dx".into(), json!(shift[0]));
    m.insert("dy".into(), json!(shift[1]));
    m.insert("dz".into(), json!(shift[2]));
    m.insert("bodies".into(), json!([id]));
    model::add_feature(doc, &Value::Object(m), None)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Turn and place the bodies in `doc` for printing. `how` is `true` or
/// {body: face index}; `only` is the one body being exported, if it is one;
/// `apart` is a separate export, where each part goes at the origin rather
/// than beside the last. Returns a line saying what went down on what.
pub async fn lay_flat(
    link: &EngineLink,
    doc: &mut Doc,
    built: &[Value],
    how: &Value,
    only: Option<&str>,
    apart: bool,
) -> Result<String, String> {
    let mut asked: Vec<(String, i64)> = Vec::new();
    match how {
        Value::Bool(true) => {}
        Value::Object(map) => {
            for (k, v) in map {
                let Some(id) = find_body(built, k) else {
                    return Err(no_such_body(k, built));
                };
                let Some(i) = v.as_i64() else {
                    return Err(format!("layFlat's {k} is a face index from `inspect`, got {v}"));
                };
                asked.push((id, i));
            }
        }
        other => return Err(format!("layFlat is true or {{body: face index}}, got {other}")),
    }
    let ids: Vec<String> = match only {
        Some(id) => vec![id.to_string()],
        None => built.iter().map(id_of).filter(|i| !i.is_empty()).collect(),
    };
    let detailed = engine_bodies(link, doc, Some(&ids)).await?;

    let mut turns: Vec<(String, (f64, f64))> = Vec::new();
    let mut notes = Vec::new();
    let mut unflat = Vec::new();
    for id in &ids {
        let Some(body) = detailed.iter().find(|b| &id_of(b) == id) else { continue };
        let wanted = asked.iter().find(|(b, _)| b == id).map(|(_, i)| *i);
        match pick_face(body, wanted)? {
            Some((i, n, _)) => {
                turns.push((id.clone(), face_down(n)));
                notes.push(format!("{id} on F{i}"));
            }
            None => {
                turns.push((id.clone(), (0.0, 0.0)));
                unflat.push(id.clone());
            }
        }
    }

    // Turned first on a copy, to learn where each part ends up: the shift
    // that sets it on the bed depends on its box after the turn.
    let mut turned = doc.clone();
    for (id, turn) in &turns {
        add_move(&mut turned, id, *turn, [0.0; 3])?;
    }
    let after = engine_bodies(link, &turned, None).await?;
    let mut x = 0.0;
    for (id, turn) in &turns {
        let Some(b) = after.iter().find(|b| &id_of(b) == id) else { continue };
        let bbox = b.get("bbox");
        let (Some(lo), Some(hi)) = (vec3(bbox.and_then(|v| v.get("min"))), vec3(bbox.and_then(|v| v.get("max")))) else {
            continue;
        };
        let at = if apart { 0.0 } else { x };
        add_move(doc, id, *turn, [round6(at - lo[0]), round6(-lo[1]), round6(-lo[2])])?;
        x += hi[0] - lo[0] + GAP;
    }

    let mut line = format!("Laid flat: {}.", notes.join(", "));
    if notes.is_empty() {
        line = String::from("Laid flat: none of the bodies has a flat face.");
    } else if !unflat.is_empty() {
        line.push_str(&format!(
            " No flat face on {}, set on the bed as modelled.",
            unflat.join(", ")
        ));
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::face_down;

    /// The turn applied to n, written out the way OCCT's intrinsic XYZ
    /// composes it, has to come out pointing down.
    fn turned(n: [f64; 3], (a, b): (f64, f64)) -> [f64; 3] {
        let (a, b) = (a.to_radians(), b.to_radians());
        // Ry(b) first, then Rx(a): R = Rx(a) * Ry(b).
        let y = [n[0] * b.cos() + n[2] * b.sin(), n[1], -n[0] * b.sin() + n[2] * b.cos()];
        [y[0], y[1] * a.cos() - y[2] * a.sin(), y[1] * a.sin() + y[2] * a.cos()]
    }

    #[test]
    fn every_direction_ends_up_pointing_down() {
        let s = 0.5_f64.sqrt();
        for n in [
            [0.0, 0.0, -1.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [-1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0],
            [s, s, 0.0],
            [0.3, -0.4, 0.866],
        ] {
            let r = turned(n, face_down(n));
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            assert!((r[0] / len).abs() < 1e-6 && (r[1] / len).abs() < 1e-6 && (r[2] / len + 1.0).abs() < 1e-6, "{n:?} -> {r:?}");
        }
    }
}
