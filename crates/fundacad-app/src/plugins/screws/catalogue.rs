//! The standards catalogue, FundaCAD 1's catalogue.ts over the same JSON: families, their sizes and lengths, and the
//! spec one catalogue choice expands to, which the `fastener` shape generator builds.

#[cfg(test)]
mod tests;

use std::sync::OnceLock;

use serde_json::{json, Map, Value};

const METRIC: &str = include_str!("../../../../../plugins/FundaCAD.Screws/catalogue/metric.json");
const INCH: &str = include_str!("../../../../../plugins/FundaCAD.Screws/catalogue/inch.json");
const THREADS: &str = include_str!("../../../../../plugins/FundaCAD.Screws/catalogue/threads.json");

pub const CATEGORY_ORDER: [&str; 9] = [
    "Socket screws",
    "Machine screws",
    "Bolts",
    "Set screws",
    "Special screws",
    "Tapping and wood screws",
    "Nuts",
    "Washers",
    "Inserts",
];

pub const DRIVE_PREFIX: [(&str, &str); 3] = [("phillips", "PH"), ("pozidriv", "PZ"), ("torx", "T")];

struct Data {
    families: Vec<Value>,
    threads: Value,
}

fn data() -> &'static Data {
    static DATA: OnceLock<Data> = OnceLock::new();
    DATA.get_or_init(|| {
        let mut families: Vec<Value> = serde_json::from_str(METRIC).expect("metric.json reads");
        families.extend(serde_json::from_str::<Vec<Value>>(INCH).expect("inch.json reads"));
        Data { families, threads: serde_json::from_str(THREADS).expect("threads.json reads") }
    })
}

pub fn families() -> &'static [Value] {
    &data().families
}

pub fn family(id: &str) -> Option<&'static Value> {
    families().iter().find(|f| s(f, "id") == id)
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub fn family_id(f: &Value) -> &str {
    s(f, "id")
}

pub fn name(f: &Value) -> &str {
    s(f, "name")
}

pub fn standard(f: &Value) -> &str {
    s(f, "standard")
}

pub fn category(f: &Value) -> &str {
    s(f, "category")
}

pub fn kind(f: &Value) -> &str {
    f.get("fixed").map_or("", |x| s(x, "kind"))
}

fn table(f: &Value) -> &'static Value {
    &data().threads[s(f, "threads")]
}

pub fn units(f: &Value) -> &'static str {
    if table(f)["units"] == "in" {
        "in"
    } else {
        "mm"
    }
}

fn thread_size(f: &Value, size: &str) -> Option<&'static Value> {
    table(f).get("sizes")?.get(size)
}

pub fn sizes(f: &Value) -> Vec<&str> {
    f.get("sizes").and_then(Value::as_array).into_iter().flatten().map(|r| s(r, "size")).collect()
}

fn row<'a>(f: &'a Value, size: &str) -> Option<&'a Value> {
    f.get("sizes")?.as_array()?.iter().find(|r| s(r, "size") == size)
}

pub fn drives(f: &Value) -> Vec<String> {
    let listed: Vec<String> =
        f.get("drives").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    if !listed.is_empty() {
        return listed;
    }
    f.get("fixed").and_then(|x| x.get("drive.type")).and_then(Value::as_str).map(str::to_owned).into_iter().collect()
}

pub fn lengths(f: &Value, size: &str) -> Vec<f64> {
    let Some(r) = row(f, size) else { return Vec::new() };
    if let Some(list) = r.get("lengths").and_then(Value::as_array) {
        return list.iter().filter_map(Value::as_f64).collect();
    }
    let (Some(series), Some(range)) = (f.get("lengths").and_then(Value::as_str), r.get("L").and_then(Value::as_array))
    else {
        return Vec::new();
    };
    let (lo, hi) = (range[0].as_f64().unwrap_or(0.), range[1].as_f64().unwrap_or(0.));
    data().threads["lengthSeries"][series]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .filter(|v| *v >= lo - 1e-9 && *v <= hi + 1e-9)
        .collect()
}

/// The pitches a size comes in, coarse first.
pub fn pitches(f: &Value, size: &str) -> Vec<f64> {
    let Some(ts) = thread_size(f, size) else { return Vec::new() };
    if s(f, "threads") == "inch" {
        return ["unc", "unf"].iter().filter_map(|k| ts.get(*k)?.as_f64()).map(|tpi| 1. / tpi).collect();
    }
    let coarse = ts.get("coarse").and_then(Value::as_f64);
    let fine = ts.get("fine").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_f64);
    coarse.into_iter().chain(fine).collect()
}

const INCH_FRACTIONS: f64 = 32.;

/// `formatInch`: a whole and a fraction of 32nds in lowest terms, else the decimal.
pub fn format_inch(v: f64) -> String {
    let whole = (v + 1e-9).floor();
    let rest = v - whole;
    let num = (rest * INCH_FRACTIONS).round();
    if (rest * INCH_FRACTIONS - num).abs() > 1e-6 {
        return js_number((v * 1e4).round() / 1e4);
    }
    if num == 0. {
        return js_number(whole);
    }
    let (mut a, mut b) = (num as i64, INCH_FRACTIONS as i64);
    while a % 2 == 0 {
        a /= 2;
        b /= 2;
    }
    if whole > 0. {
        format!("{}-{a}/{b}", whole as i64)
    } else {
        format!("{a}/{b}")
    }
}

/// `String(n)` of a JavaScript number.
pub fn js_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

pub fn designation(f: &Value, size: &str, pitch: f64) -> String {
    let t = thread_size(f, size);
    if s(f, "threads") == "inch" {
        let tpi = (1. / pitch).round();
        let unf = t.and_then(|t| t.get("unf")).and_then(Value::as_f64) == Some(tpi);
        let unc = t.and_then(|t| t.get("unc")).and_then(Value::as_f64) == Some(tpi);
        return format!("{size}-{} {}", tpi as i64, if unf && !unc { "UNF" } else { "UNC" });
    }
    let coarse = t.and_then(|t| t.get("coarse")).and_then(Value::as_f64).unwrap_or(0.);
    if s(f, "threads") == "tapping" || t.is_none() || (pitch - coarse).abs() < 1e-9 {
        return size.to_owned();
    }
    format!("{size}x{}", js_number(pitch))
}

fn thread_length(rule: Option<&Value>, row: &Value, d: f64, pitch: f64, l: f64) -> f64 {
    let Some(rule) = rule else { return l };
    if rule.get("full").and_then(Value::as_bool) == Some(true) {
        return l;
    }
    if let Some(col) = rule.get("column").and_then(Value::as_str) {
        return row.get(col).and_then(Value::as_f64).unwrap_or(f64::NAN);
    }
    if rule.get("fullUpTo").and_then(Value::as_f64).is_some_and(|u| l <= u + 1e-9) {
        return l;
    }
    let steps = rule.get("steps").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_array);
    let Some(step) = steps.into_iter().find(|st| st[0].as_f64().is_none_or(|max| l <= max + 1e-9)) else { return l };
    let b = step[1].as_f64().unwrap_or(0.) * d + step[2].as_f64().unwrap_or(0.);
    let within = rule.get("fullWithin").and_then(Value::as_f64).unwrap_or(0.);
    if l - b <= within * pitch + 1e-9 {
        l
    } else {
        b
    }
}

/// A whole number as an integer and the rest as written, as JSON.stringify writes a JavaScript number.
pub fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

fn round6(v: f64) -> f64 {
    format!("{v:.6}").parse().unwrap_or(v)
}

fn set_path(spec: &mut Map<String, Value>, path: &str, v: Value) {
    let mut parts: Vec<&str> = path.split('.').collect();
    let last = parts.pop().unwrap_or_default();
    let mut at = spec;
    for p in parts {
        let next = at.entry(p).or_insert_with(|| json!({}));
        if !next.is_object() {
            *next = json!({});
        }
        at = next.as_object_mut().expect("made above");
    }
    at.insert(last.to_owned(), v);
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ItemChoice {
    pub family: String,
    pub size: String,
    pub length: Option<f64>,
    pub drive: Option<String>,
    pub pitch: Option<f64>,
    pub modelled: bool,
    pub left: bool,
}

/// The spec a catalogue choice stands for, key for key as FundaCAD 1 wrote it into `generatedBy.spec`.
pub fn expand(c: &ItemChoice) -> Result<Value, String> {
    let f = family(&c.family).ok_or_else(|| format!("unknown family {}", c.family))?;
    let r = row(f, &c.size).ok_or_else(|| format!("{} has no size {}", standard(f), c.size))?;
    let ts = thread_size(f, &c.size).ok_or_else(|| format!("no thread table entry for {}", c.size))?;
    let kind = kind(f);
    let units = units(f);
    let mut spec = Map::new();
    spec.insert("kind".into(), json!(kind));
    spec.insert("units".into(), json!(units));
    spec.insert("name".into(), json!(""));
    spec.insert("standard".into(), json!(standard(f)));
    for (path, v) in f.get("fixed").and_then(Value::as_object).into_iter().flatten() {
        set_path(&mut spec, path, v.clone());
    }
    for (col, path) in f.get("columns").and_then(Value::as_object).into_iter().flatten() {
        if let (Some(v), Some(path)) = (r.get(col), path.as_str()) {
            set_path(&mut spec, path, v.clone());
        }
    }
    let drives = drives(f);
    let drive = c.drive.clone().filter(|d| drives.contains(d)).or_else(|| drives.first().cloned());
    if let Some(d) = &drive {
        set_path(&mut spec, "drive.type", json!(d));
    }
    let pitches = pitches(f, &c.size);
    let first = *pitches.first().ok_or_else(|| format!("{} has no pitch", c.size))?;
    let pitch = c.pitch.filter(|p| pitches.iter().any(|x| (x - p).abs() < 1e-9)).unwrap_or(first);
    let d = ts.get("d").and_then(Value::as_f64).unwrap_or(0.);
    let threads = s(f, "threads");
    let mut thread = Map::new();
    thread.insert("type".into(), json!(if threads == "inch" { "unified" } else { threads }));
    thread.insert("diameter".into(), ts["d"].clone());
    thread.insert("pitch".into(), num(round6(pitch)));
    thread.insert("hand".into(), json!(if c.left { "left" } else { "right" }));
    thread.insert("modelled".into(), json!(c.modelled));
    thread.insert("designation".into(), json!(designation(f, &c.size, pitch)));
    // Held in its place, the thread length is only known once the length is.
    spec.insert("thread".into(), Value::Null);

    let ls = lengths(f, &c.size);
    let length = (!ls.is_empty())
        .then(|| c.length.filter(|l| ls.iter().any(|x| (x - l).abs() < 1e-9)).unwrap_or(ls[0]));
    if let Some(l) = length {
        match f.get("lengthPath").and_then(Value::as_str) {
            Some(path) => set_path(&mut spec, path, num(l)),
            None => {
                spec.insert("length".into(), num(l));
            }
        }
    }
    if let (true, Some(l)) = (kind == "screw" || kind == "shoulderScrew", length) {
        let mut b = thread_length(f.get("threadLength"), r, d, pitch, l);
        let head = spec.get("head");
        if kind == "screw" && head.is_some_and(|h| h["type"] == "countersunk") {
            b = b.min(l - head.and_then(|h| h["height"].as_f64()).unwrap_or(0.));
        }
        if kind == "screw" {
            b = b.min(l);
        }
        thread.insert("length".into(), num(round6(b)));
    }
    let size_text = thread["designation"].as_str().unwrap_or_default().to_owned();
    spec.insert("thread".into(), Value::Object(thread));
    let len_text = match length {
        Some(l) if units == "in" => format!(" x {}", format_inch(l)),
        Some(l) => format!("x{}", js_number(l)),
        None => String::new(),
    };
    let many = f.get("drives").and_then(Value::as_array).is_some_and(|d| d.len() > 1);
    let drive_text = match &drive {
        Some(d) if many => {
            format!(" {}", DRIVE_PREFIX.iter().find(|(k, _)| k == d).map_or(d.as_str(), |(_, p)| p))
        }
        _ => String::new(),
    };
    let prefix = f.get("prefix").and_then(Value::as_str).unwrap_or(standard(f));
    spec.insert("name".into(), json!(format!("{prefix} {size_text}{len_text}{drive_text}")));
    if let Some(label) = r.get("label") {
        let info = spec.entry("info").or_insert_with(|| json!({}));
        if let Some(info) = info.as_object_mut() {
            info.insert("size".into(), label.clone());
        }
    }
    Ok(Value::Object(spec))
}
