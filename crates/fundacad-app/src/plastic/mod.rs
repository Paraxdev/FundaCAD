//! Plastic editing: a face pushed in the viewport edits the feature parameter behind it.

use fundacad_client::Doc;
use glam::Vec3;
use serde_json::Value;

const SNAP: f64 = 0.1;

#[derive(Clone, Debug, PartialEq)]
pub enum Driver {
    /// The feature's own `distance`.
    Field,
    /// The named parameter `distance` reads, so every feature bound to it follows.
    Param(String),
}

/// What a pushed face edits.
#[derive(Clone, Debug, PartialEq)]
pub struct Grip {
    pub feature: String,
    pub driver: Driver,
    pub start: f64,
    /// The sketch origin of a symmetric extrude, whose other cap moves the opposite way.
    pub mirror: Option<Vec3>,
}

impl Grip {
    /// The value after pushing the face `travel` mm outward, snapped, never crossing zero.
    pub fn value(&self, travel: f32) -> f64 {
        let sign = if self.start < 0.0 { -1.0 } else { 1.0 };
        let v = ((self.start + sign * travel as f64) / SNAP).round() * SNAP;
        if v * sign < SNAP {
            sign * SNAP
        } else {
            v
        }
    }

    pub fn label(&self) -> String {
        match &self.driver {
            Driver::Field => format!("{} distance", self.feature),
            Driver::Param(name) => name.clone(),
        }
    }

    pub fn apply(&self, doc: &mut Doc, value: f64) -> Result<(), String> {
        match &self.driver {
            Driver::Field => {
                let f = features_mut(doc)
                    .and_then(|fs| fs.iter_mut().find(|f| id(f) == Some(&self.feature)))
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| format!("{} is gone", self.feature))?;
                f.insert("distance".into(), Value::from(value));
                Ok(())
            }
            Driver::Param(name) => fundacad_client::set_param(doc, name, value),
        }
    }
}

/// The grip for a face of `owner` with outward `normal`, picked at `at`. Only the far cap of an extrude pushes.
pub fn grip(doc: &Doc, owner: &str, normal: Vec3, at: Vec3) -> Result<Grip, String> {
    let features = doc.get("features").and_then(Value::as_array).ok_or("the document has no features")?;
    let f = features.iter().find(|f| id(f) == Some(owner)).ok_or_else(|| format!("no feature {owner}"))?;
    let kind = f.get("type").and_then(Value::as_str).unwrap_or("?");
    if kind != "extrude" {
        return Err(format!("{kind} faces do not push yet"));
    }
    let operation = f.get("operation").and_then(Value::as_str).unwrap_or("new");
    if operation != "new" && operation != "join" {
        return Err(format!("faces of a {operation} extrude do not push yet"));
    }
    let text = |k: &str| f.get(k).and_then(Value::as_str);
    if text("startType").is_some_and(|t| t != "sketch") {
        return Err("an extrude with a moved start does not push yet".into());
    }
    if text("endType").is_some_and(|t| t != "distance") {
        return Err("an up to extrude does not push yet".into());
    }
    if f.get("taper").is_some_and(|t| !t.is_null() && t.as_f64() != Some(0.0)) {
        return Err("a tapered extrude does not push yet".into());
    }
    if f.get("twoSided").and_then(Value::as_bool) == Some(true) {
        return Err("a two sided extrude does not push yet".into());
    }
    let symmetric = f.get("symmetric").and_then(Value::as_bool) == Some(true);
    let (driver, start) = match f.get("distance") {
        Some(Value::Number(n)) => (Driver::Field, n.as_f64().unwrap_or(0.0)),
        Some(Value::String(name)) => {
            let v = doc.get("parameters").and_then(|p| p.get(name)).and_then(Value::as_f64);
            (Driver::Param(name.clone()), v.ok_or_else(|| format!("no parameter {name}"))?)
        }
        _ => return Err(format!("{owner} has no distance")),
    };
    let sketch = f.get("sketch").and_then(Value::as_str);
    let sketch = sketch.and_then(|s| features.iter().find(|f| id(f) == Some(s)));
    let plane = sketch.and_then(sketch_plane);
    if let Some((origin, axis)) = plane {
        if normal.dot(axis).abs() < 0.999 {
            return Err("a wall of an extrude does not push yet, push an end".into());
        }
        if !symmetric && (((at - origin).dot(axis)) as f64).abs() < start.abs() * 0.5 {
            return Err("this end sits on the sketch, push the far end".into());
        }
    }
    let mirror = match (symmetric, plane) {
        (false, _) => None,
        (true, Some((origin, _))) => Some(origin),
        (true, None) => return Err("a symmetric extrude on a face does not push yet".into()),
    };
    Ok(Grip { feature: owner.into(), driver, start, mirror })
}

/// Origin and unit normal of a sketch drawn on a world plane or a given one. None for a datum or a face.
fn sketch_plane(sketch: &Value) -> Option<(Vec3, Vec3)> {
    if sketch.get("face").is_some() || sketch.get("planeId").is_some() {
        return None;
    }
    match sketch.get("plane")? {
        Value::String(s) => match s.as_str() {
            "XY" => Some((Vec3::ZERO, Vec3::Z)),
            "XZ" => Some((Vec3::ZERO, Vec3::Y)),
            "YZ" => Some((Vec3::ZERO, Vec3::X)),
            _ => None,
        },
        plane => {
            let v = |k: &str| {
                let a = plane.get(k)?.as_array()?;
                let n = |i: usize| a.get(i).and_then(Value::as_f64).map(|x| x as f32);
                Some(Vec3::new(n(0)?, n(1)?, n(2)?))
            };
            Some((v("origin")?, v("normal")?.try_normalize()?))
        }
    }
}

fn id(f: &Value) -> Option<&str> {
    f.get("id").and_then(Value::as_str)
}

fn features_mut(doc: &mut Doc) -> Option<&mut Vec<Value>> {
    doc.get_mut("features").and_then(Value::as_array_mut)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn doc(distance: Value) -> Doc {
        let v = json!({
            "parameters": {"h": 12},
            "features": [
                {"id": "sk1", "type": "sketch", "plane": "XY", "entities": []},
                {"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": distance, "operation": "new"},
                {"id": "f1", "type": "fillet", "radius": 1}
            ]
        });
        v.as_object().unwrap().clone()
    }

    #[test]
    fn the_far_cap_grips_the_distance() {
        let d = doc(json!(12));
        let g = grip(&d, "ex1", Vec3::Z, Vec3::new(1.0, 1.0, 12.0)).unwrap();
        assert_eq!(g, Grip { feature: "ex1".into(), driver: Driver::Field, start: 12.0, mirror: None });
        assert!(grip(&d, "ex1", -Vec3::Z, Vec3::new(1.0, 1.0, 0.0)).is_err());
        assert!(grip(&d, "ex1", Vec3::X, Vec3::new(5.0, 1.0, 6.0)).is_err());
        assert!(grip(&d, "f1", Vec3::Z, Vec3::ZERO).is_err());
    }

    #[test]
    fn a_symmetric_extrude_grips_either_end() {
        let mut d = doc(json!(12));
        d["features"][1]["symmetric"] = json!(true);
        let g = grip(&d, "ex1", -Vec3::Z, Vec3::new(1.0, 1.0, -12.0)).unwrap();
        assert_eq!(g.mirror, Some(Vec3::ZERO));
        d["features"][1]["taper"] = json!(5);
        assert!(grip(&d, "ex1", Vec3::Z, Vec3::new(1.0, 1.0, 12.0)).is_err());
    }

    #[test]
    fn a_cut_does_not_grip() {
        let mut d = doc(json!(12));
        d["features"][1]["operation"] = json!("cut");
        assert!(grip(&d, "ex1", Vec3::Z, Vec3::new(1.0, 1.0, 12.0)).is_err());
    }

    #[test]
    fn a_bound_distance_grips_its_parameter() {
        let d = doc(json!("h"));
        let g = grip(&d, "ex1", Vec3::Z, Vec3::new(0.0, 0.0, 12.0)).unwrap();
        assert_eq!(g.driver, Driver::Param("h".into()));
        assert_eq!(g.start, 12.0);
    }

    #[test]
    fn values_snap_and_stop_short_of_zero() {
        let g = Grip { feature: "ex1".into(), driver: Driver::Field, start: 12.0, mirror: None };
        assert_eq!(g.value(3.04), 15.0);
        assert_eq!(g.value(-40.0), 0.1);
        let down = Grip { start: -12.0, ..g };
        assert_eq!(down.value(2.0), -14.0);
    }

    #[test]
    fn apply_writes_the_field() {
        let mut d = doc(json!(12));
        let g = grip(&d, "ex1", Vec3::Z, Vec3::new(0.0, 0.0, 12.0)).unwrap();
        g.apply(&mut d, 20.5).unwrap();
        assert_eq!(d["features"][1]["distance"], json!(20.5));
    }
}
