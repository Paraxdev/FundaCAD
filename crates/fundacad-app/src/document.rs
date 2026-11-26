//! What the shell shows of a document: its history and its parameters. `Document::from_funda` reads it from the
//! session's .funda document, `Document::sample` is the bracket the Vue workspace capture shows when no file is open.

use gpui::SharedString;
use serde_json::{Map, Value};

/// Stays Ok for every step read from a file until the viewport exposes the build's `featureErrors`.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Health {
    #[default]
    Ok,
    Warning,
    Error,
}

/// Where an edited value goes in the .funda document.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// A number in a feature, `features[id].key`.
    Field { feature: String, key: String },
    /// A named parameter, set through the table so everything bound to it follows.
    Def(String),
}

impl Target {
    pub fn key(&self) -> String {
        match self {
            Target::Field { feature, key } => format!("f:{feature}:{key}"),
            Target::Def(name) => format!("p:{name}"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Param {
    pub label: SharedString,
    pub value: f64,
    pub unit: &'static str,
    /// Set when the value is bound to an expression, shown in place of the number.
    pub expr: Option<SharedString>,
    /// Where an edit goes, None while the value is bound to an expression.
    pub target: Option<Target>,
}

#[derive(Clone, Debug)]
pub struct Feature {
    pub id: String,
    /// The forge icon of the feature type.
    pub glyph: &'static str,
    pub name: SharedString,
    pub health: Health,
    pub suppressed: bool,
    pub params: Vec<Param>,
}

#[derive(Clone, Debug, Default)]
pub struct Document {
    pub name: SharedString,
    pub dirty: bool,
    pub features: Vec<Feature>,
    /// Features at and past this index are rolled back.
    pub marker: usize,
    /// The document's named parameters, the ones no feature field owns.
    #[allow(dead_code)]
    pub named: Vec<Param>,
}

impl Document {
    /// An opened file until the engine link reads its history: its name and nothing else.
    pub fn named(name: SharedString) -> Self {
        Self { name, ..Default::default() }
    }

    pub fn can_step_back(&self) -> bool {
        self.marker > 0
    }

    pub fn can_step_forward(&self) -> bool {
        self.marker < self.features.len()
    }

    pub fn set_marker(&mut self, at: usize) {
        self.marker = at.min(self.features.len());
    }

    pub fn sample() -> Self {
        let mm = |label: &str, value: f64| Param {
            label: label.to_string().into(),
            value,
            unit: "mm",
            expr: None,
            target: None,
        };
        let sketch = |id: &str, params| Feature {
            id: id.into(),
            glyph: "sketch",
            name: "Sketch".into(),
            health: Health::Ok,
            suppressed: false,
            params,
        };
        let extrude = |id: &str, params| Feature {
            id: id.into(),
            glyph: "extrude",
            name: "Extrude".into(),
            health: Health::Ok,
            suppressed: false,
            params,
        };
        Self {
            name: "Untitled".into(),
            dirty: true,
            features: vec![
                sketch("s1", vec![]),
                extrude("e1", vec![mm("Distance", 10.)]),
                sketch("s2", vec![]),
                extrude(
                    "e2",
                    vec![Param {
                        label: "Distance".into(),
                        value: 40.,
                        unit: "mm",
                        expr: Some("height".into()),
                        target: None,
                    }],
                ),
            ],
            marker: 4,
            named: vec![],
        }
    }
}

fn unit_of(def_unit: &str) -> &'static str {
    match def_unit {
        "mm" => "mm",
        "deg" => "°",
        _ => "",
    }
}

/// The forge icon and the English name of a feature type, as featureMeta in src/ui/featureMeta.ts.
pub(crate) fn meta(f: &Map<String, Value>) -> (&'static str, String) {
    let ty = f.get("type").and_then(Value::as_str).unwrap_or("");
    let (glyph, label) = match ty {
        "sketch" => ("sketch", "Sketch"),
        "extrude" if f.get("thin") == Some(&Value::Bool(true)) => ("extrude", "Thin extrude"),
        "extrude" => ("extrude", "Extrude"),
        "fillet" => ("fillet", "Fillet"),
        "chamfer" => ("chamfer", "Chamfer"),
        "press-pull" => ("presspull", "Press/Pull"),
        "deleteFace" => ("deleteFace", "Delete Face"),
        "mirror" => ("mirror", "Mirror"),
        "revolve" => ("revolve", "Revolve"),
        "loft" => ("loft", "Loft"),
        "sweep" => ("sweep", "Sweep"),
        "datumPlane" => ("datumPlane", "Datum Plane"),
        "datumPoint" => ("datumPoint", "Datum Point"),
        "datumAxis" => ("datumAxis", "Datum Axis"),
        "import" => ("import", "Import"),
        "split" => ("split", "Split Body"),
        "separate" => ("split", "Separate"),
        "imprint" => ("imprint", "Divide Face"),
        "boolean" => match f.get("operation").and_then(Value::as_str) {
            Some("union") => ("booleanUnion", "Union"),
            Some("subtract") => ("booleanSubtract", "Subtract"),
            Some("intersect") => ("booleanIntersect", "Intersect"),
            _ => ("booleanUnion", "Boolean"),
        },
        "box" => ("box", "Box"),
        "cylinder" => ("cylinder", "Cylinder"),
        "cone" => ("cone", "Cone"),
        "sphere" => ("sphere", "Sphere"),
        "torus" => ("torus", "Torus"),
        "shell" => ("shell", "Shell"),
        "offsetFace" => ("offsetFace", "Offset Face"),
        "thicken" => ("thicken", "Thicken"),
        "draft" => ("draft", "Draft"),
        "hole" => ("hole", "Hole"),
        "thread" => ("thread", "Thread"),
        "textOnFace" => ("text", "Text on Face"),
        "patternRect" => ("patternRect", "Rect Pattern"),
        "patternLinear" => ("patternLinear", "Linear Pattern"),
        "patternCircular" => ("patternCircular", "Circular Pattern"),
        "simplifyMesh" => ("simplifyMesh", "Simplify Mesh"),
        "cleanUp" => ("cleanUp", "Clean Up"),
        "scale" => ("scale", "Scale"),
        "move" => ("move", "Move"),
        "duplicate" => ("copy", "Duplicate"),
        "joint" => ("assembly", "Joint"),
        "mechanism" => ("mechanism", "Mechanism"),
        "removeBody" => ("removeBody", "Remove Body"),
        other => ("dot", other),
    };
    (glyph, label.to_string())
}

fn is_plain_number(expr: &str) -> bool {
    expr.trim().parse::<f64>().is_ok_and(f64::is_finite)
}

/// The number in a field's text, a trailing unit allowed, None when it is not one.
pub fn parse_value(text: &str) -> Option<f64> {
    let t = text.trim();
    let t = ["mm", "deg", "°"].iter().find_map(|u| t.strip_suffix(u)).unwrap_or(t);
    t.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

pub(crate) fn number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// Writes an edited value into the document: a named parameter through the table, a feature field in place.
pub fn apply(doc: &mut Map<String, Value>, target: &Target, value: f64) -> Result<(), String> {
    if !value.is_finite() {
        return Err(format!("{value} is not a finite number"));
    }
    match target {
        Target::Def(name) => fundacad_client::set_param(doc, name, value),
        Target::Field { feature, key } => {
            let field = doc
                .get_mut("features")
                .and_then(Value::as_array_mut)
                .and_then(|fs| fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(feature)))
                .and_then(Value::as_object_mut)
                .and_then(|f| f.get_mut(key))
                .ok_or_else(|| format!("the document has no {key} on {feature}"))?;
            *field = number(value);
            Ok(())
        }
    }
}

impl Document {
    /// The shell's view of a .funda document.
    pub fn from_funda(name: SharedString, doc: &Map<String, Value>) -> Self {
        let defs = doc.get("paramDefs").and_then(Value::as_object);
        let features: Vec<&Map<String, Value>> =
            doc.get("features").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).collect();
        let suppressed: Vec<&str> =
            doc.get("suppressed").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        let bound = |id: &str, key: &str| {
            defs?.iter().find(|(_, d)| {
                let t = d.get("target");
                t.and_then(|t| t.get("kind")).and_then(Value::as_str) == Some("feature")
                    && t.and_then(|t| t.get("feature")).and_then(Value::as_str) == Some(id)
                    && t.and_then(|t| t.get("field")).and_then(Value::as_str) == Some(key)
            })
        };
        let table_value = |n: &str| doc.get("parameters").and_then(|p| p.get(n)).and_then(Value::as_f64).unwrap_or(0.);

        let mut steps = Vec::new();
        for f in &features {
            let id = f.get("id").and_then(Value::as_str).unwrap_or("");
            let (glyph, label) = meta(f);
            let own = f.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty());
            let mut params = Vec::new();
            for n in crate::inspector::num_fields(f.get("type").and_then(Value::as_str).unwrap_or(""), f) {
                let (key, label, kind) = (n.key.as_str(), n.label.as_str(), n.kind);
                let Some(raw) = f.get(key) else { continue };
                let param = |value, expr: Option<&str>, target| Param {
                    label: label.to_string().into(),
                    value,
                    unit: kind.unit(),
                    expr: expr.map(|e| e.to_string().into()),
                    target,
                };
                let own_target = || Target::Field { feature: id.to_string(), key: key.to_string() };
                params.push(match (bound(id, key), raw) {
                    (Some((n, d)), _) => {
                        let expr = d.get("expr").and_then(Value::as_str).unwrap_or("");
                        let value = d.get("value").and_then(Value::as_f64).unwrap_or(0.);
                        if is_plain_number(expr) {
                            param(value, None, Some(Target::Def(n.clone())))
                        } else {
                            param(value, Some(expr), None)
                        }
                    }
                    (None, Value::Number(n)) => param(n.as_f64().unwrap_or(0.), None, Some(own_target())),
                    (None, Value::String(name)) => param(table_value(name), Some(name), None),
                    _ => continue,
                });
            }
            steps.push(Feature {
                id: id.to_string(),
                glyph,
                name: own.map_or(label, str::to_string).into(),
                health: Health::Ok,
                suppressed: suppressed.contains(&id),
                params,
            });
        }

        let marker = doc.get("rollback").and_then(Value::as_u64).map_or(steps.len(), |m| (m as usize).min(steps.len()));

        let named = defs
            .into_iter()
            .flatten()
            .filter(|(_, d)| d.get("target").is_none() && d.get("hidden") != Some(&Value::Bool(true)))
            .map(|(n, d)| {
                let expr = d.get("expr").and_then(Value::as_str).unwrap_or("");
                let literal = is_plain_number(expr);
                Param {
                    label: n.clone().into(),
                    value: d.get("value").and_then(Value::as_f64).unwrap_or(0.),
                    unit: unit_of(d.get("unit").and_then(Value::as_str).unwrap_or("")),
                    expr: (!literal).then(|| expr.to_string().into()),
                    target: literal.then(|| Target::Def(n.clone())),
                }
            })
            .collect();

        Self { name, dirty: false, marker, features: steps, named }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map, Value};

    use super::{apply, parse_value, Document, Target};

    fn funda() -> Map<String, Value> {
        json!({
            "version": 10,
            "parameters": {"w": 10, "h": 20, "d1": 6},
            "paramDefs": {
                "w": {"expr": "10", "value": 10, "unit": "mm"},
                "h": {"expr": "w * 2", "value": 20, "unit": "mm"},
                "d1": {"expr": "6", "value": 6, "unit": "mm",
                       "target": {"kind": "feature", "feature": "pad", "field": "distance"}},
            },
            "features": [
                {"id": "base", "type": "sketch", "name": "Outline"},
                {"id": "pad", "type": "extrude", "name": "", "distance": 6, "taper": 2.5},
                {"id": "bore", "type": "boolean", "operation": "subtract"},
                {"id": "top", "type": "extrude", "distance": "h"},
                {"id": "gone", "type": "fillet", "radius": 1},
            ],
            "suppressed": ["gone"],
            "rollback": 4,
            "sketchVisibility": {"base": true},
            "bodyIds": {"pad:0": "body1", "bore:0": "body2"},
            "bodyNames": {"body1": "Plate"},
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_funda_document_reads_as_the_shells_history() {
        let d = Document::from_funda("plate".into(), &funda());
        let names: Vec<_> = d.features.iter().map(|f| (f.glyph, f.name.to_string())).collect();
        assert_eq!(
            names,
            [
                ("sketch", "Outline".to_string()),
                ("extrude", "Extrude".to_string()),
                ("booleanSubtract", "Subtract".to_string()),
                ("extrude", "Extrude".to_string()),
                ("fillet", "Fillet".to_string()),
            ]
        );
        assert_eq!(d.marker, 4);
        assert!(d.features[4].suppressed && !d.features[3].suppressed);
        assert!(!d.dirty);
    }

    #[test]
    fn a_feature_shows_its_numbers_with_their_binding() {
        let d = Document::from_funda("plate".into(), &funda());
        let pad = &d.features[1].params;
        assert_eq!((pad[0].label.to_string(), pad[0].value, pad[0].unit), ("Distance".to_string(), 6., "mm"));
        assert_eq!(pad[0].target, Some(Target::Def("d1".into())), "a literal driver is edited through its parameter");
        assert_eq!((pad[1].label.to_string(), pad[1].value, pad[1].unit), ("Taper".to_string(), 2.5, "°"));
        assert_eq!(pad[1].target, Some(Target::Field { feature: "pad".into(), key: "taper".into() }));
        let top = &d.features[3].params[0];
        assert_eq!((top.value, top.expr.as_deref()), (20., Some("h")));
        assert!(top.target.is_none());
    }

    #[test]
    fn the_named_parameters_come_from_the_document() {
        let d = Document::from_funda("plate".into(), &funda());
        let named: Vec<_> = d.named.iter().map(|p| (p.label.to_string(), p.value, p.expr.as_deref())).collect();
        assert_eq!(named, [("w".to_string(), 10., None), ("h".to_string(), 20., Some("w * 2"))]);
    }

    #[test]
    fn a_document_without_a_marker_plays_to_the_end() {
        let mut f = funda();
        f.remove("rollback");
        assert_eq!(Document::from_funda("p".into(), &f).marker, 5);
        f.insert("rollback".into(), json!(2));
        assert_eq!(Document::from_funda("p".into(), &f).marker, 2);
        f.insert("rollback".into(), Value::Null);
        assert_eq!(Document::from_funda("p".into(), &f).marker, 5);
    }

    #[test]
    fn typed_text_is_a_number_or_nothing() {
        assert_eq!(parse_value(" 12.5 "), Some(12.5));
        assert_eq!(parse_value("8mm"), Some(8.));
        assert_eq!(parse_value("45 °"), Some(45.));
        assert_eq!(parse_value("-3"), Some(-3.));
        assert_eq!(parse_value(""), None);
        assert_eq!(parse_value("w * 2"), None);
        assert_eq!(parse_value("inf"), None);
        assert_eq!(parse_value("NaN"), None);
    }

    #[test]
    fn an_edit_reaches_the_field_or_the_parameter_that_drives_it() {
        let mut f = funda();
        apply(&mut f, &Target::Field { feature: "pad".into(), key: "taper".into() }, 5.).unwrap();
        assert_eq!(f["features"][1]["taper"], json!(5));
        apply(&mut f, &Target::Def("w".into()), 12.5).unwrap();
        assert_eq!(f["parameters"]["w"], json!(12.5));
        assert_eq!(f["parameters"]["h"], json!(25));
        apply(&mut f, &Target::Def("d1".into()), 9.).unwrap();
        assert_eq!(f["features"][1]["distance"], json!(9), "the bound field follows its parameter");
        assert!(apply(&mut f, &Target::Field { feature: "nope".into(), key: "x".into() }, 1.).is_err());
        assert!(apply(&mut f, &Target::Def("w".into()), f64::NAN).is_err());
        let read = Document::from_funda("p".into(), &f);
        assert_eq!(read.features[1].params[0].value, 9.);
    }

    #[test]
    fn the_marker_stays_within_the_history() {
        let mut d = Document::sample();
        let n = d.features.len();
        assert!(d.can_step_back() && !d.can_step_forward());
        d.set_marker(n + 5);
        assert_eq!(d.marker, n);
        d.set_marker(0);
        assert!(!d.can_step_back() && d.can_step_forward());
        let empty = Document::named("bracket".into());
        assert!(!empty.can_step_back() && !empty.can_step_forward());
    }
}
