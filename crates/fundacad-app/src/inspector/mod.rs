//! The rows of one feature, FeatureProperties.vue's model: what the build said of it, what it is applied to, its
//! choices, switches and numbers, and the document edit behind each. A sketch's numbers are its dimensions, file rows come only from plugins.

mod fields;
mod hole;
mod options;
mod parse;
mod targets;

use serde_json::{Map, Value};

pub use fields::{num_fields, value_problem, Kind, Rule};
pub use options::Choice;
pub use parse::parse;

use crate::document::Target;
use crate::viewport::FeatureIssue;

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    /// What the last build said of the feature, the note its History step carries.
    Note {
        text: String,
        warning: bool,
    },
    /// The features a pattern repeats, by name. Which ones is chosen by pointing before Pattern starts.
    Repeats {
        names: String,
    },
    /// What the feature is applied to, counted.
    Target {
        label: &'static str,
        text: String,
        empty: bool,
    },
    Choice(ChoiceRow),
    Toggle {
        field: &'static str,
        label: &'static str,
        on: bool,
    },
    Number(NumRow),
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChoiceRow {
    pub field: &'static str,
    pub label: &'static str,
    pub options: Vec<Choice>,
    pub current: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NumRow {
    pub field: String,
    pub label: String,
    pub kind: Kind,
    pub rule: Rule,
    /// None while the feature leaves the field out and nothing stands in for it.
    pub value: Option<f64>,
    /// A bound expression, shown in place of the number and read only.
    pub expr: Option<String>,
    /// Where an edit goes, None while the value is bound to an expression.
    pub target: Option<Target>,
}

type Feature = Map<String, Value>;

fn features(doc: &Map<String, Value>) -> Vec<&Feature> {
    doc.get("features").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).collect()
}

fn id_of(f: &Feature) -> &str {
    f.get("id").and_then(Value::as_str).unwrap_or_default()
}

fn type_of(f: &Feature) -> &str {
    f.get("type").and_then(Value::as_str).unwrap_or_default()
}

/// The parameter that drives `features[id].key`, by name.
fn binding<'a>(doc: &'a Map<String, Value>, id: &str, key: &str) -> Option<(&'a String, &'a Value)> {
    doc.get("paramDefs")?.as_object()?.iter().find(|(_, d)| {
        let t = d.get("target");
        let s = |k: &str| t.and_then(|t| t.get(k)).and_then(Value::as_str);
        s("kind") == Some("feature") && s("feature") == Some(id) && s("field") == Some(key)
    })
}

fn is_plain_number(expr: &str) -> bool {
    expr.trim().parse::<f64>().is_ok_and(f64::is_finite)
}

/// The rows FeatureProperties shows for `id`, in its order. Empty when the document has no such feature.
pub fn rows(doc: &Map<String, Value>, id: &str, issues: &[FeatureIssue]) -> Vec<Row> {
    let all = features(doc);
    let Some(f) = all.iter().copied().find(|f| id_of(f) == id) else { return Vec::new() };
    let ty = type_of(f);
    let mut out = Vec::new();
    if let Some(i) = issues.iter().find(|i| i.feature_id == id && !i.message.is_empty()) {
        out.push(Row::Note { text: i.message.clone(), warning: i.warning });
    }
    let repeats: Vec<String> = f
        .get("features")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|r| match all.iter().find(|x| id_of(x) == r) {
            Some(src) => {
                let own = src.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty());
                own.map_or_else(|| crate::document::meta(src).1, str::to_string)
            }
            None => r.to_string(),
        })
        .collect();
    if !repeats.is_empty() {
        out.push(Row::Repeats { names: repeats.join(", ") });
    }
    for t in targets::targets_for(ty, f) {
        let entries = targets::read_target(f, &t);
        out.push(Row::Target { label: t.label, text: targets::describe(&t, &entries), empty: entries.is_empty() });
    }
    for c in options::choice_fields(ty).iter().filter(|c| options::field_applies(ty, c.field, f)) {
        let (options, current) = match (ty, c.field) {
            ("patternCircular", "axis") => options::pattern_axis_choice(f, &all),
            ("mechanism", "drive") => options::mechanism_drive_choice(f),
            _ => options::datum_choice_row(ty, f, c.field, &all).unwrap_or_else(|| {
                (
                    c.options.iter().map(|&(v, l)| Choice { value: v.into(), label: l.into() }).collect(),
                    options::choice_value(ty, f, c),
                )
            }),
        };
        out.push(Row::Choice(ChoiceRow { field: c.field, label: c.label, options, current }));
    }
    for t in options::toggle_fields(ty).iter().filter(|t| options::field_applies(ty, t.field, f)) {
        out.push(Row::Toggle { field: t.field, label: t.label, on: options::toggle_value(f, t) });
    }
    for n in num_fields(ty, f).into_iter().filter(|n| options::field_applies(ty, &n.key, f)) {
        out.push(Row::Number(num_row(doc, f, ty, n)));
    }
    out
}

fn num_row(doc: &Map<String, Value>, f: &Feature, ty: &str, n: fields::NumField) -> NumRow {
    let id = id_of(f);
    let label = options::field_label(ty, &n.key, f).map_or(n.label, str::to_string);
    let own = Target::Field { feature: id.to_string(), key: n.key.clone() };
    let cur = fields::read_field(f, &n.key);
    let (value, expr, target) = match (binding(doc, id, &n.key), cur) {
        (Some((name, d)), _) => {
            let expr = d.get("expr").and_then(Value::as_str).unwrap_or_default();
            let value = d.get("value").and_then(Value::as_f64);
            if is_plain_number(expr) {
                (value, None, Some(Target::Def(name.clone())))
            } else {
                (value, Some(expr.to_string()), None)
            }
        }
        (None, Some(Value::Number(v))) => (v.as_f64(), None, Some(own)),
        // A field holding a parameter's name, as files from before the table were written.
        (None, Some(Value::String(name))) => {
            let v = doc.get("parameters").and_then(|p| p.get(name)).and_then(Value::as_f64);
            (Some(v.unwrap_or(0.)), Some(name.clone()), None)
        }
        (None, _) => (fields::absent_value(ty, &n.key), None, Some(own)),
    };
    NumRow { rule: fields::value_rule(ty, &n.key), field: n.key, label, kind: n.kind, value, expr, target }
}

fn feature_mut<'a>(doc: &'a mut Map<String, Value>, id: &str) -> Result<&'a mut Feature, String> {
    doc.get_mut("features")
        .and_then(Value::as_array_mut)
        .and_then(|fs| fs.iter_mut().find(|f| f.get("id").and_then(Value::as_str) == Some(id)))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("the document has no feature {id}"))
}

/// The patch `setOption` writes for a choice or a switch, None when the choice changes nothing.
pub fn option_patch(doc: &Map<String, Value>, id: &str, field: &str, value: &Value) -> Option<options::Patch> {
    if options::datum_choice_is_no_op(field, value) {
        return None;
    }
    let f = features(doc).into_iter().find(|f| id_of(f) == id)?;
    let ty = type_of(f);
    let s = value.as_str().unwrap_or_default();
    let mut patch: options::Patch = vec![(field.to_string(), Some(value.clone()))];
    if ty == "patternCircular" && field == "axis" {
        patch = options::pattern_axis_patch(s)?;
    }
    if ty == "mechanism" && field == "drive" {
        patch = options::mechanism_drive_patch(s);
    }
    if ty == "hole" {
        patch = hole::choice_patch(f, field, value, |k| binding(doc, id, k).is_some());
    }
    let no_distance2 = f.get("distance2").is_none_or(Value::is_null);
    if ty == "chamfer" && field == "chamferType" && s == "twoDistance" && no_distance2 {
        patch.push(("distance2".into(), f.get("distance").cloned()));
    }
    if ty == "extrude" && field == "thin" {
        patch = options::thin_toggle_patch(f, value == &Value::Bool(true));
    }
    Some(patch)
}

/// A choice or a switch written onto the feature: no expression path and no unit.
pub fn set_option(doc: &mut Map<String, Value>, id: &str, field: &str, value: &Value) -> Result<(), String> {
    let Some(patch) = option_patch(doc, id, field, value) else { return Ok(()) };
    let f = feature_mut(doc, id)?;
    for (k, v) in patch {
        match v {
            Some(v) => f.insert(k, v),
            None => f.remove(&k),
        };
    }
    options::canonical_mirror_plane(f);
    Ok(())
}

/// A number written where its row points: a parameter through the table, a feature field rounded to what it holds,
/// and left out again when it is the value an absent field means.
pub fn set_number(doc: &mut Map<String, Value>, target: &Target, value: f64) -> Result<(), String> {
    let Target::Field { feature, key } = target else {
        crate::document::apply(doc, target, value)?;
        crate::sketch::solve::resolve_sketches(doc);
        return Ok(());
    };
    if !value.is_finite() {
        return Err(format!("{value} is not a finite number"));
    }
    let f = feature_mut(doc, feature)?;
    let ty = type_of(f).to_string();
    if !num_fields(&ty, f).iter().any(|n| &n.key == key) {
        return Err(format!("{key} is no number of {feature}"));
    }
    let v = fields::coerce(key, value);
    let left_out = fields::absent_value(&ty, key) == Some(v);
    let next = (!left_out).then(|| crate::document::number(v));
    if fields::read_field(f, key) == next.as_ref() {
        return Ok(());
    }
    if !fields::write_field(f, key, next) {
        return Err(format!("the document has no {key} on {feature}"));
    }
    if ty == "sketch" {
        crate::sketch::solve::resolve_feature(doc, feature, Some(key));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
