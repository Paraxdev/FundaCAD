//! The fastener library's geometry as a FundaCAD plugin component, the Rust
//! twin of geometry/*.py: one shape generator, `fastener`, and no feature
//! type. A fastener is generated once, when it is inserted, and stored in the
//! document as an `import` feature's blob, so nothing here is needed to open or
//! rebuild a document that has fasteners in it.

wit_bindgen::generate!({
    world: "plugin",
    path: "../../../crates/fundacad-geom/wit",
});

mod fastener;
mod shapes;
mod spec;
mod thread;

use serde_json::Value;

pub use fundacad::plugin::kernel;

pub const GENERATOR: &str = "fastener";

/// A checked spec part, read the way the Python half reads its dicts.
pub struct P(pub Value);

impl P {
    /// A sub-part, an empty one when absent.
    pub fn p(&self, key: &str) -> P {
        P(self.0.get(key).cloned().unwrap_or(Value::Null))
    }

    /// A sub-part only when it is present and truthy.
    pub fn opt(&self, key: &str) -> Option<P> {
        self.0.get(key).filter(|v| truthy(v)).cloned().map(P)
    }

    pub fn s(&self, key: &str) -> &str {
        self.0.get(key).and_then(Value::as_str).unwrap_or("")
    }

    /// `str(spec[key])`.
    pub fn text(&self, key: &str) -> String {
        self.0.get(key).map(py_str).unwrap_or_default()
    }

    /// A number, NaN when absent.
    pub fn f(&self, key: &str) -> f64 {
        self.0.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
    }

    pub fn f_or(&self, key: &str, default: f64) -> f64 {
        match self.0.get(key) {
            None => default,
            Some(v) => v.as_f64().unwrap_or(f64::NAN),
        }
    }

    /// `part.get(key)` when it is truthy, as a number.
    pub fn truthy_f(&self, key: &str) -> Option<f64> {
        self.0.get(key).filter(|v| truthy(v)).and_then(Value::as_f64)
    }

    pub fn b(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(truthy)
    }
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `repr(str)` for the names a message quotes.
pub fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

fn repr_float(v: f64) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let sci = format!("{v:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if v == 0.0 || (-4..16).contains(&exp) {
        let s = format!("{v}");
        if s.contains('.') || s.contains("inf") {
            s
        } else {
            format!("{s}.0")
        }
    } else {
        format!("{mantissa}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

/// `str(v)` of a value json.loads made.
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) if n.is_f64() => repr_float(n.as_f64().unwrap_or(0.0)),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(a) => format!(
            "[{}]",
            a.iter()
                .map(|x| match x {
                    Value::String(s) => py_repr(s),
                    other => py_str(other),
                })
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, x)| format!(
                    "{}: {}",
                    py_repr(k),
                    match x {
                        Value::String(s) => py_repr(s),
                        other => py_str(other),
                    }
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

struct Screws;

impl Guest for Screws {
    fn register() -> Registration {
        Registration {
            features: vec![],
            mesh_passes: vec![],
            exporters: vec![],
            shape_generators: vec![GENERATOR.to_string()],
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

    fn write_export(exporter: String, _bodies: Vec<ExportBody>, _options: String) -> Result<String, String> {
        Err(format!("no exporter {exporter:?} here"))
    }

    fn generate_shape(generator: String, params: String) -> Result<Shape, String> {
        if generator != GENERATOR {
            return Err(format!("no shape generator {generator:?} here"));
        }
        let params: Value = serde_json::from_str(&params).map_err(|e| e.to_string())?;
        fastener::build(&params)
    }
}

export!(Screws);
