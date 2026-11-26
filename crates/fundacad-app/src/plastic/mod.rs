//! Plastic editing: a face pushed in the viewport edits the feature parameter behind it.

use fundacad_client::Doc;
use glam::Vec3;
use serde_json::Value;

const SNAP: f64 = 0.1;
const ALIGNED: f32 = 0.999;

/// A number in the document: a feature's own field, or the parameter it reads.
#[derive(Clone, Debug, PartialEq)]
pub enum Driver {
    Field {
        feature: String,
        field: String,
    },
    /// Every feature bound to the parameter follows.
    Param(String),
}

impl Driver {
    fn set(&self, doc: &mut Doc, value: f64) -> Result<(), String> {
        match self {
            Driver::Field { feature, field } => {
                let f = features_mut(doc)
                    .and_then(|fs| fs.iter_mut().find(|f| id(f) == Some(feature)))
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| format!("{feature} is gone"))?;
                f.insert(field.clone(), Value::from(value));
                Ok(())
            }
            Driver::Param(name) => fundacad_client::set_param(doc, name, value),
        }
    }
}

/// The move that places a primitive, shifted by half its growth so the opposite face stays put.
#[derive(Clone, Debug, PartialEq)]
pub struct Shift {
    pub driver: Driver,
    pub start: f64,
    /// Offset change per unit of the grip's value.
    pub per_value: f64,
}

/// What a pushed face edits.
#[derive(Clone, Debug, PartialEq)]
pub struct Grip {
    /// The feature that made the face.
    pub feature: String,
    pub driver: Driver,
    pub start: f64,
    /// Value change per mm the face moves outward. Negative for an extrude with a negative distance.
    pub rate: f64,
    pub shift: Option<Shift>,
    /// A point the face's opposite moves away from by as much as the face, for symmetric growth.
    pub mirror: Option<Vec3>,
}

impl Grip {
    /// The value after pushing the face `travel` mm outward, snapped, never crossing zero.
    pub fn value(&self, travel: f32) -> f64 {
        let sign = if self.start < 0.0 { -1.0 } else { 1.0 };
        let v = ((self.start + self.rate * travel as f64) / SNAP).round() * SNAP;
        if v * sign < SNAP {
            sign * SNAP
        } else {
            v
        }
    }

    /// How far the face has moved outward at `value`.
    pub fn travel(&self, value: f64) -> f32 {
        ((value - self.start) / self.rate) as f32
    }

    pub fn label(&self) -> String {
        match &self.driver {
            Driver::Field { feature, field } => format!("{feature} {field}"),
            Driver::Param(name) => name.clone(),
        }
    }

    pub fn apply(&self, doc: &mut Doc, value: f64) -> Result<(), String> {
        self.driver.set(doc, value)?;
        if let Some(s) = &self.shift {
            s.driver.set(doc, s.start + s.per_value * (value - self.start))?;
        }
        Ok(())
    }
}

/// The grip for a face of `owner` in `body` with outward `normal`, picked at `at`.
pub fn grip(doc: &Doc, owner: &str, body: &str, normal: Vec3, at: Vec3) -> Result<Grip, String> {
    let features = doc.get("features").and_then(Value::as_array).ok_or("the document has no features")?;
    let index = features.iter().position(|f| id(f) == Some(owner)).ok_or_else(|| format!("no feature {owner}"))?;
    let f = &features[index];
    match f.get("type").and_then(Value::as_str).unwrap_or("?") {
        "extrude" => extrude(doc, features, f, owner, normal, at),
        "box" => primitive(doc, &features[index..], owner, body, normal, at),
        "cylinder" => primitive(doc, &features[index..], owner, body, normal, at),
        kind => Err(format!("{kind} faces do not push yet")),
    }
}

/// Only the far cap of an extrude pushes, or either cap of a symmetric one.
fn extrude(doc: &Doc, features: &[Value], f: &Value, owner: &str, normal: Vec3, at: Vec3) -> Result<Grip, String> {
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
    let (driver, start) = number(doc, owner, "distance", f.get("distance"))?;
    let sketch = f.get("sketch").and_then(Value::as_str);
    let sketch = sketch.and_then(|s| features.iter().find(|f| id(f) == Some(s)));
    let plane = sketch.and_then(sketch_plane);
    if let Some((origin, axis)) = plane {
        if normal.dot(axis).abs() < ALIGNED {
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
    let rate = if start < 0.0 { -1.0 } else { 1.0 };
    Ok(Grip { feature: owner.into(), driver, start, rate, shift: None, mirror })
}

/// A box or cylinder centred on the origin. The face grows the size along its axis, and the move right after the
/// primitive shifts by half of it so the opposite face stays. With no move the primitive grows from its centre.
fn primitive(doc: &Doc, from: &[Value], owner: &str, body: &str, normal: Vec3, at: Vec3) -> Result<Grip, String> {
    let f = &from[0];
    let cylinder = f.get("type").and_then(Value::as_str) == Some("cylinder");
    let (k, axis) = [Vec3::X, Vec3::Y, Vec3::Z]
        .into_iter()
        .enumerate()
        .find(|(_, a)| normal.dot(*a).abs() >= ALIGNED)
        .ok_or("this face is not square to the axes, a rotated primitive does not push yet")?;
    let field = match (cylinder, k) {
        (true, 2) => "height",
        (true, _) => return Err("the side of a cylinder does not push yet, push an end".into()),
        (false, 0) => "length",
        (false, 1) => "width",
        (false, _) => "height",
    };
    let (driver, start) = number(doc, owner, field, f.get(field))?;
    if start <= 0.0 {
        return Err(format!("{owner} has no {field}"));
    }
    let applies = |m: &Value| match m.get("bodies").and_then(Value::as_array) {
        None => true,
        Some(b) => b.iter().any(|b| b.as_str() == Some(body)),
    };
    let moves = || from[1..].iter().filter(|m| m.get("type").and_then(Value::as_str) == Some("move"));
    if moves().any(|m| applies(m) && rotates(doc, m)) {
        return Err(format!("{owner} is rotated by a move, a rotated primitive does not push yet"));
    }
    let placing = from.get(1).filter(|m| m.get("type").and_then(Value::as_str) == Some("move"));
    let shift = match placing {
        None => None,
        Some(m) => {
            let only_this =
                m.get("bodies").and_then(Value::as_array).is_none_or(|b| b.len() == 1 && b[0].as_str() == Some(body));
            if !only_this {
                return Err(format!("the move after {owner} places other bodies too"));
            }
            let move_id = id(m).unwrap_or("?");
            let offset = ["dx", "dy", "dz"][k];
            let (driver, start) = number(doc, move_id, offset, m.get(offset).or(Some(&Value::from(0))))?;
            if let Driver::Param(name) = &driver {
                if uses(doc, name) > 1 {
                    return Err(format!("{name} places {owner} and other features too"));
                }
            }
            let per_value = 0.5 * normal.dot(axis).signum() as f64;
            Some(Shift { driver, start, per_value })
        }
    };
    let (rate, mirror) = match shift {
        Some(_) => (1.0, None),
        None => (2.0, Some(at - normal * (start as f32 * 0.5))),
    };
    Ok(Grip { feature: owner.into(), driver, start, rate, shift, mirror })
}

/// A field read as a literal or through a parameter.
fn number(doc: &Doc, feature: &str, field: &str, v: Option<&Value>) -> Result<(Driver, f64), String> {
    match v {
        Some(Value::Number(n)) => {
            let driver = Driver::Field { feature: feature.into(), field: field.into() };
            Ok((driver, n.as_f64().unwrap_or(0.0)))
        }
        Some(Value::String(name)) => {
            let v = doc.get("parameters").and_then(|p| p.get(name)).and_then(Value::as_f64);
            Ok((Driver::Param(name.clone()), v.ok_or_else(|| format!("no parameter {name}"))?))
        }
        _ => Err(format!("{feature} has no {field}")),
    }
}

fn rotates(doc: &Doc, m: &Value) -> bool {
    ["rx", "ry", "rz"].iter().any(|k| match m.get(*k) {
        None | Some(Value::Null) => false,
        Some(v) => number(doc, "", k, Some(v)).map_or(true, |(_, a)| a != 0.0),
    })
}

/// How many feature fields read the parameter `name`.
fn uses(doc: &Doc, name: &str) -> usize {
    fn count(v: &Value, name: &str) -> usize {
        match v {
            Value::String(s) => usize::from(s == name),
            Value::Array(a) => a.iter().map(|v| count(v, name)).sum(),
            Value::Object(o) => o.iter().filter(|(k, _)| *k != "id").map(|(_, v)| count(v, name)).sum(),
            _ => 0,
        }
    }
    doc.get("features").map_or(0, |f| count(f, name))
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

    fn field(feature: &str, field: &str) -> Driver {
        Driver::Field { feature: feature.into(), field: field.into() }
    }

    fn boxed(features: Value) -> Doc {
        let v = json!({"parameters": {"w": 6, "lift": 4, "x": 1}, "features": features});
        v.as_object().unwrap().clone()
    }

    #[test]
    fn the_far_cap_grips_the_distance() {
        let d = doc(json!(12));
        let g = grip(&d, "ex1", "body1", Vec3::Z, Vec3::new(1.0, 1.0, 12.0)).unwrap();
        let want = Grip {
            feature: "ex1".into(),
            driver: field("ex1", "distance"),
            start: 12.0,
            rate: 1.0,
            shift: None,
            mirror: None,
        };
        assert_eq!(g, want);
        assert!(grip(&d, "ex1", "body1", -Vec3::Z, Vec3::new(1.0, 1.0, 0.0)).is_err());
        assert!(grip(&d, "ex1", "body1", Vec3::X, Vec3::new(5.0, 1.0, 6.0)).is_err());
        assert!(grip(&d, "f1", "body1", Vec3::Z, Vec3::ZERO).is_err());
    }

    #[test]
    fn a_symmetric_extrude_grips_either_end() {
        let mut d = doc(json!(12));
        d["features"][1]["symmetric"] = json!(true);
        let g = grip(&d, "ex1", "body1", -Vec3::Z, Vec3::new(1.0, 1.0, -12.0)).unwrap();
        assert_eq!(g.mirror, Some(Vec3::ZERO));
        d["features"][1]["taper"] = json!(5);
        assert!(grip(&d, "ex1", "body1", Vec3::Z, Vec3::new(1.0, 1.0, 12.0)).is_err());
    }

    #[test]
    fn a_cut_does_not_grip() {
        let mut d = doc(json!(12));
        d["features"][1]["operation"] = json!("cut");
        assert!(grip(&d, "ex1", "body1", Vec3::Z, Vec3::new(1.0, 1.0, 12.0)).is_err());
    }

    #[test]
    fn a_bound_distance_grips_its_parameter() {
        let d = doc(json!("h"));
        let g = grip(&d, "ex1", "body1", Vec3::Z, Vec3::new(0.0, 0.0, 12.0)).unwrap();
        assert_eq!(g.driver, Driver::Param("h".into()));
        assert_eq!(g.start, 12.0);
    }

    #[test]
    fn values_snap_and_stop_short_of_zero() {
        let g = grip(&doc(json!(12)), "ex1", "body1", Vec3::Z, Vec3::new(0.0, 0.0, 12.0)).unwrap();
        assert_eq!(g.value(3.04), 15.0);
        assert_eq!(g.value(-40.0), 0.1);
        let down = grip(&doc(json!(-12)), "ex1", "body1", -Vec3::Z, Vec3::new(0.0, 0.0, -12.0)).unwrap();
        assert_eq!(down.value(2.0), -14.0);
        assert_eq!(down.travel(-14.0), 2.0);
    }

    #[test]
    fn apply_writes_the_field() {
        let mut d = doc(json!(12));
        let g = grip(&d, "ex1", "body1", Vec3::Z, Vec3::new(0.0, 0.0, 12.0)).unwrap();
        g.apply(&mut d, 20.5).unwrap();
        assert_eq!(d["features"][1]["distance"], json!(20.5));
    }

    #[test]
    fn a_placed_box_face_grows_and_shifts_its_move() {
        let mut d = boxed(json!([
            {"id": "b", "type": "box", "length": 10, "width": "w", "height": 2},
            {"id": "m", "type": "move", "dx": 5, "dy": 0, "dz": "lift", "rx": 0, "ry": 0, "rz": 0}
        ]));
        let g = grip(&d, "b", "body1", -Vec3::X, Vec3::new(0.0, 0.0, 4.0)).unwrap();
        assert_eq!((g.driver.clone(), g.start, g.rate, g.mirror), (field("b", "length"), 10.0, 1.0, None));
        assert_eq!(g.shift, Some(Shift { driver: field("m", "dx"), start: 5.0, per_value: -0.5 }));
        g.apply(&mut d, 14.0).unwrap();
        assert_eq!((d["features"][0]["length"].clone(), d["features"][1]["dx"].clone()), (json!(14.0), json!(3.0)));

        let up = grip(&d, "b", "body1", Vec3::Z, Vec3::new(3.0, 0.0, 5.0)).unwrap();
        assert_eq!(up.shift.as_ref().map(|s| (&s.driver, s.per_value)), Some((&Driver::Param("lift".into()), 0.5)));
        up.apply(&mut d, 4.0).unwrap();
        assert_eq!(d["parameters"]["lift"].as_f64(), Some(5.0));

        let side = grip(&d, "b", "body1", Vec3::Y, Vec3::new(3.0, 3.0, 5.0)).unwrap();
        assert_eq!(side.driver, Driver::Param("w".into()));
        assert_eq!(side.shift.map(|s| s.driver), Some(field("m", "dy")));
    }

    #[test]
    fn an_unplaced_box_grows_from_its_centre() {
        let d = boxed(json!([{"id": "b", "type": "box", "length": 10, "width": 6, "height": 2}]));
        let g = grip(&d, "b", "body1", Vec3::X, Vec3::new(5.0, 1.0, 0.0)).unwrap();
        assert_eq!((g.rate, g.shift.clone(), g.mirror), (2.0, None, Some(Vec3::new(0.0, 1.0, 0.0))));
        assert_eq!(g.value(1.0), 12.0);
        assert_eq!(g.travel(12.0), 1.0);
    }

    #[test]
    fn a_cylinder_pushes_its_ends_only() {
        let d = boxed(json!([
            {"id": "c", "type": "cylinder", "radius": 2, "height": 8},
            {"id": "m", "type": "move", "dx": 0, "dy": 0, "dz": 4, "rx": 0, "ry": 0, "rz": 0}
        ]));
        let g = grip(&d, "c", "body1", -Vec3::Z, Vec3::ZERO).unwrap();
        assert_eq!(g.driver, field("c", "height"));
        assert_eq!(g.shift.map(|s| (s.driver, s.per_value)), Some((field("m", "dz"), -0.5)));
        assert!(grip(&d, "c", "body1", Vec3::X, Vec3::new(2.0, 0.0, 4.0)).is_err());
    }

    #[test]
    fn rotated_or_shared_placement_does_not_grip() {
        let features = |m: Value| {
            boxed(json!([
                {"id": "b", "type": "box", "length": 10, "width": 6, "height": 2},
                m,
                {"id": "other", "type": "move", "dx": "x", "dy": 0, "dz": 0, "bodies": ["body2"]}
            ]))
        };
        let at = Vec3::new(5.0, 0.0, 0.0);
        let rotated = features(json!({"id": "m", "type": "move", "dx": 1, "rz": 90}));
        assert!(grip(&rotated, "b", "body1", Vec3::X, at).is_err());
        let both = features(json!({"id": "m", "type": "move", "dx": 1, "bodies": ["body1", "body2"]}));
        assert!(grip(&both, "b", "body1", Vec3::X, at).is_err());
        let shared = features(json!({"id": "m", "type": "move", "dx": "x"}));
        assert!(grip(&shared, "b", "body1", Vec3::X, at).is_err());
        let own = features(json!({"id": "m", "type": "move", "dx": 1, "bodies": ["body1"]}));
        assert!(grip(&own, "b", "body1", Vec3::X, at).is_ok());
        assert!(grip(&own, "b", "body1", Vec3::new(1.0, 1.0, 0.0).normalize(), at).is_err());
    }
}
