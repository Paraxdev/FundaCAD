//! FundaCAD 1's src/params/extras.ts and the plugin's view.ts over the document's JSON: controls, groups,
//! configurations and checks. The file keys stay FundaCAD 1's (`paramDefs[n].control`, `group`, `hidden`,
//! `paramExtras`), so a document builds and reads the same in either app.

#[cfg(test)]
mod tests;

use fundacad_client::Doc;
use fundacad_core::params::edit::{check_expr, defs_of, set_param_expr};
use serde_json::{json, Map, Value};

pub const KINDS: [&str; 4] = ["number", "slider", "toggle", "choice"];

#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub label: String,
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Control {
    Number { min: Option<f64>, max: Option<f64>, step: Option<f64> },
    Slider { min: f64, max: f64, step: Option<f64> },
    Toggle,
    Choice(Vec<Choice>),
}

fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// A whole number as an integer, so a value written back reads as FundaCAD 1 wrote it.
pub fn number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

impl Control {
    pub fn read(v: Option<&Value>) -> Option<Control> {
        let v = v?;
        Some(match v.get("kind")?.as_str()? {
            "number" => Control::Number { min: f(v, "min"), max: f(v, "max"), step: f(v, "step") },
            "slider" => Control::Slider { min: f(v, "min")?, max: f(v, "max")?, step: f(v, "step") },
            "toggle" => Control::Toggle,
            "choice" => Control::Choice(
                v.get("choices")?
                    .as_array()?
                    .iter()
                    .filter_map(|c| {
                        Some(Choice { label: c.get("label")?.as_str()?.to_owned(), value: c.get("value")?.as_f64()? })
                    })
                    .collect(),
            ),
            _ => return None,
        })
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Control::Number { .. } => "number",
            Control::Slider { .. } => "slider",
            Control::Toggle => "toggle",
            Control::Choice(_) => "choice",
        }
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), json!(self.kind()));
        let mut put = |k: &str, v: Option<f64>| {
            if let Some(v) = v {
                m.insert(k.into(), number(v));
            }
        };
        match self {
            Control::Number { min, max, step } => {
                put("min", *min);
                put("max", *max);
                put("step", *step);
            }
            Control::Slider { min, max, step } => {
                put("min", Some(*min));
                put("max", Some(*max));
                put("step", *step);
            }
            Control::Toggle => {}
            Control::Choice(cs) => {
                let list: Vec<Value> = cs.iter().map(|c| json!({"label": c.label, "value": number(c.value)})).collect();
                m.insert("choices".into(), Value::Array(list));
            }
        }
        Value::Object(m)
    }

    fn range(&self) -> (Option<f64>, Option<f64>, Option<f64>) {
        match self {
            Control::Number { min, max, step } => (*min, *max, *step),
            Control::Slider { min, max, step } => (Some(*min), Some(*max), *step),
            _ => (None, None, None),
        }
    }
}

/// Where a control keeps a value: inside min and max, on a step counted from min, 0 or 1 for a toggle, the nearest
/// listed value for a choice.
pub fn clamp_to_control(control: Option<&Control>, value: f64) -> f64 {
    let Some(c) = control else { return value };
    if !value.is_finite() {
        return value;
    }
    match c {
        Control::Toggle => f64::from(u8::from(value != 0.0)),
        Control::Choice(cs) => {
            let mut best = (value, f64::INFINITY);
            for ch in cs {
                let d = (ch.value - value).abs();
                if d < best.1 {
                    best = (ch.value, d);
                }
            }
            best.0
        }
        _ => {
            let (min, max, step) = c.range();
            let mut v = value;
            if let Some(step) = step.filter(|s| *s > 0.0) {
                let base = min.unwrap_or(0.0);
                v = base + ((v - base) / step).round() * step;
                // The step arithmetic drifts, toFixed(10) in FundaCAD 1.
                v = (v * 1e10).round() / 1e10;
            }
            if let Some(min) = min {
                v = v.max(min);
            }
            if let Some(max) = max {
                v = v.min(max);
            }
            v
        }
    }
}

fn spell(v: f64) -> String {
    let s = format!("{v}");
    s.strip_suffix(".0").map(str::to_owned).unwrap_or(s)
}

/// Why a parameter's value sits outside its own control. A value typed as an expression can land there.
pub fn control_problem(def: &Value) -> Option<String> {
    let c = Control::read(def.get("control"))?;
    let value = def.get("value").and_then(Value::as_f64)?;
    let clamped = clamp_to_control(Some(&c), value);
    if (clamped - value).abs() <= 1e-9 * value.abs().max(1.0) {
        return None;
    }
    Some(match &c {
        Control::Toggle => "a toggle is 0 or 1".into(),
        Control::Choice(_) => "not one of the listed choices".into(),
        _ => {
            let (min, max, step) = c.range();
            match (min, max) {
                (Some(m), _) if value < m => format!("below the minimum of {}", spell(m)),
                (_, Some(m)) if value > m => format!("above the maximum of {}", spell(m)),
                _ => format!("not on a step of {}", step.map(spell).unwrap_or_default()),
            }
        }
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckResult {
    pub id: String,
    pub message: String,
    pub error_level: bool,
    pub ok: bool,
    /// Set when the rule could not be evaluated, which also counts as not ok.
    pub error: Option<String>,
}

fn extras<'a>(doc: &'a Doc, key: &str) -> impl Iterator<Item = &'a Map<String, Value>> {
    doc.get("paramExtras")
        .and_then(|x| x.get(key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

fn s<'a>(m: &'a Map<String, Value>, key: &str) -> &'a str {
    m.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub fn check_results(doc: &Doc) -> Vec<CheckResult> {
    extras(doc, "checks")
        .map(|c| {
            let (ok, error) = match check_expr(doc, None, s(c, "expr")) {
                Ok(v) if v.is_nan() => (false, Some("does not evaluate to a number".to_owned())),
                Ok(v) => (v != 0.0, None),
                Err(e) => (false, Some(e)),
            };
            CheckResult {
                id: s(c, "id").to_owned(),
                message: s(c, "message").to_owned(),
                error_level: s(c, "level") == "error",
                ok,
                error,
            }
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub name: String,
    pub value: f64,
    pub control: Control,
    /// Only a plain number is set through a control, an expression is left to the Parameters table.
    pub editable: bool,
    pub problem: Option<String>,
    pub unit: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub id: Option<String>,
    pub name: String,
    pub rows: Vec<Row>,
}

pub fn is_plain_number(expr: &str) -> bool {
    let t = expr.trim();
    !t.is_empty() && t.parse::<f64>().is_ok_and(f64::is_finite)
}

fn unit_label(def: &Value) -> &'static str {
    match def.get("unit").and_then(Value::as_str) {
        Some("mm") => "mm",
        Some("deg") => "\u{b0}",
        _ => "",
    }
}

/// The groups, each id once.
pub fn groups(doc: &Doc) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for g in extras(doc, "groups") {
        let id = s(g, "id").to_owned();
        if !out.iter().any(|(i, _)| *i == id) {
            out.push((id, s(g, "name").to_owned()));
        }
    }
    out
}

/// The user parameters not hidden, the ungrouped ones first, then each group in order.
pub fn tune_groups(doc: &Doc) -> Vec<Group> {
    let Some(defs) = defs_of(doc) else { return Vec::new() };
    let known = groups(doc);
    let rows_in = |id: Option<&str>| -> Vec<Row> {
        defs.iter()
            .filter(|(_, d)| d.get("target").is_none() && !d.get("hidden").and_then(Value::as_bool).unwrap_or(false))
            .filter(|(_, d)| {
                let g = d.get("group").and_then(Value::as_str);
                match id {
                    None => g.is_none_or(|g| !known.iter().any(|(k, _)| k == g)),
                    Some(id) => g == Some(id),
                }
            })
            .map(|(name, d)| Row {
                name: name.clone(),
                value: d.get("value").and_then(Value::as_f64).unwrap_or(0.0),
                control: Control::read(d.get("control")).unwrap_or(Control::Number { min: None, max: None, step: None }),
                editable: is_plain_number(d.get("expr").and_then(Value::as_str).unwrap_or_default()),
                problem: control_problem(d),
                unit: unit_label(d),
            })
            .collect()
    };
    let mut out = Vec::new();
    let loose = rows_in(None);
    if !loose.is_empty() {
        out.push(Group { id: None, name: String::new(), rows: loose });
    }
    for (id, name) in &known {
        let rows = rows_in(Some(id));
        if !rows.is_empty() {
            out.push(Group { id: Some(id.clone()), name: name.clone(), rows });
        }
    }
    out
}

/// What a control becomes when its kind is switched, keeping what carries over.
pub fn convert_control(from: Option<&Control>, kind: &str, value: f64) -> Option<Control> {
    let (min, max, step) = from.map(Control::range).unwrap_or_default();
    Some(match kind {
        "toggle" => Control::Toggle,
        "choice" => match from {
            Some(Control::Choice(cs)) => Control::Choice(cs.clone()),
            _ => Control::Choice(vec![Choice { label: spell(value), value }]),
        },
        "slider" => Control::Slider {
            min: min.unwrap_or(value.min(0.0)),
            max: max.unwrap_or((value * 2.0).max(1.0)),
            step,
        },
        "number" => Control::Number { min, max, step },
        _ => return None,
    })
}

fn def_mut<'a>(doc: &'a mut Doc, name: &str) -> Result<&'a mut Map<String, Value>, String> {
    doc.get_mut("paramDefs")
        .and_then(Value::as_object_mut)
        .and_then(|d| d.get_mut(name))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("there is no parameter {name:?}"))
}

/// The value through its control, written as the parameter's expression, which recomputes what reads it.
pub fn set_value(doc: &mut Doc, name: &str, value: f64) -> Result<(), String> {
    let control = Control::read(def_mut(doc, name)?.get("control"));
    let v = clamp_to_control(control.as_ref(), value);
    set_param_expr(doc, name, &spell(v)).map(|_| ())
}

/// None takes the control away, so the parameter shows as a plain number again.
pub fn set_control(doc: &mut Doc, name: &str, control: Option<&Control>) -> Result<(), String> {
    let def = def_mut(doc, name)?;
    match control {
        Some(c) => def.insert("control".into(), c.to_json()),
        None => def.remove("control"),
    };
    Ok(())
}

pub fn set_group(doc: &mut Doc, name: &str, group: Option<&str>) -> Result<(), String> {
    let def = def_mut(doc, name)?;
    match group {
        Some(g) => def.insert("group".into(), json!(g)),
        None => def.remove("group"),
    };
    Ok(())
}

pub fn set_hidden(doc: &mut Doc, name: &str, hidden: bool) -> Result<(), String> {
    let def = def_mut(doc, name)?;
    if hidden {
        def.insert("hidden".into(), json!(true));
    } else {
        def.remove("hidden");
    }
    Ok(())
}

pub fn next_id(prefix: &str, used: &[String]) -> String {
    (1..).map(|n| format!("{prefix}{n}")).find(|c| !used.contains(c)).expect("an unused id")
}

fn extras_mut<'a>(doc: &'a mut Doc, key: &str) -> &'a mut Vec<Value> {
    let x = doc.entry("paramExtras").or_insert_with(|| json!({}));
    if !x.is_object() {
        *x = json!({});
    }
    let list = x.as_object_mut().expect("made above").entry(key).or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    list.as_array_mut().expect("made above")
}

fn ids(doc: &Doc, key: &str) -> Vec<String> {
    extras(doc, key).map(|m| s(m, "id").to_owned()).collect()
}

pub fn add_group(doc: &mut Doc, name: &str) -> String {
    let id = next_id("g", &ids(doc, "groups"));
    extras_mut(doc, "groups").push(json!({"id": id, "name": name}));
    id
}

pub fn add_check(doc: &mut Doc, expr: &str, message: &str, error_level: bool) -> String {
    let id = next_id("k", &ids(doc, "checks"));
    let level = if error_level { "error" } else { "warning" };
    extras_mut(doc, "checks").push(json!({"id": id, "expr": expr, "message": message, "level": level}));
    id
}

/// The user parameters as they are now, as a configuration. Model parameters belong to one feature, a variant of the
/// design is a choice of its named inputs.
pub fn capture_configuration(doc: &Doc, id: &str, name: &str) -> Value {
    let mut values = Map::new();
    for (n, d) in defs_of(doc).into_iter().flatten() {
        if d.get("target").is_none() {
            values.insert(n.clone(), d.get("expr").cloned().unwrap_or(json!("")));
        }
    }
    json!({"id": id, "name": name, "values": values})
}

pub fn add_configuration(doc: &mut Doc, name: &str) -> String {
    let id = next_id("c", &ids(doc, "configurations"));
    let cfg = capture_configuration(doc, &id, name);
    extras_mut(doc, "configurations").push(cfg);
    if let Some(x) = doc.get_mut("paramExtras").and_then(Value::as_object_mut) {
        x.insert("activeConfiguration".into(), json!(id));
    }
    id
}

pub fn remove_extra(doc: &mut Doc, key: &str, id: &str) {
    extras_mut(doc, key).retain(|v| v.get("id").and_then(Value::as_str) != Some(id));
    if key == "groups" {
        for d in doc.get_mut("paramDefs").and_then(Value::as_object_mut).into_iter().flat_map(|d| d.values_mut()) {
            if let Some(d) = d.as_object_mut().filter(|d| d.get("group").and_then(Value::as_str) == Some(id)) {
                d.remove("group");
            }
        }
    }
    if key == "configurations" && active_configuration(doc).as_deref() == Some(id) {
        if let Some(x) = doc.get_mut("paramExtras").and_then(Value::as_object_mut) {
            x.remove("activeConfiguration");
        }
    }
}

pub fn configurations(doc: &Doc) -> Vec<(String, String)> {
    extras(doc, "configurations").map(|c| (s(c, "id").to_owned(), s(c, "name").to_owned())).collect()
}

pub fn active_configuration(doc: &Doc) -> Option<String> {
    doc.get("paramExtras")?.get("activeConfiguration")?.as_str().map(str::to_owned)
}

/// A configuration applied one value at a time, so a value may read one set before it. Nothing changes when a value
/// does not fit, the error names the first that does not.
pub fn apply_configuration(doc: &mut Doc, id: &str) -> Result<(), String> {
    let cfg = extras(doc, "configurations").find(|c| s(c, "id") == id).cloned().ok_or("no such configuration")?;
    let name = s(&cfg, "name").to_owned();
    let mut draft = doc.clone();
    for (param, expr) in cfg.get("values").and_then(Value::as_object).into_iter().flatten() {
        let expr = expr.as_str().unwrap_or_default();
        if defs_of(&draft).is_none_or(|d| !d.contains_key(param)) {
            return Err(format!("{name}: there is no parameter \"{param}\" any more"));
        }
        check_expr(&draft, Some(param), expr).map_err(|e| format!("{name}: {param} = {expr}: {e}"))?;
        set_param_expr(&mut draft, param, expr).map_err(|e| format!("{name}: {param} = {expr}: {e}"))?;
    }
    draft
        .entry("paramExtras")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("paramExtras is not an object")?
        .insert("activeConfiguration".into(), json!(id));
    *doc = draft;
    Ok(())
}

/// Parameter names whose expression differs from what the configuration sets.
pub fn configuration_drift(doc: &Doc, id: &str) -> Vec<String> {
    let Some(cfg) = extras(doc, "configurations").find(|c| s(c, "id") == id) else { return Vec::new() };
    let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let defs = defs_of(doc);
    cfg.get("values")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(n, e)| {
            let now = defs.and_then(|d| d.get(*n)).and_then(|d| d.get("expr")).and_then(Value::as_str);
            now.map(squash) != e.as_str().map(squash)
        })
        .map(|(n, _)| n.clone())
        .collect()
}
