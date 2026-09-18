//! `golden-check --record`: a corpus document with no Python answer gets this
//! engine's, in the shape freeze_goldens.py wrote, once a person has checked it.

use std::io::Write;
use std::path::Path;

use base64::Engine as _;
use serde_json::{Map, Value};

use super::{fold_crlf, sha256_hex, Ctx};

/// Record the named corpus documents into the golden file and rewrite it.
pub fn record(
    ctx: &mut Ctx,
    golden_path: &Path,
    corpus_path: &Path,
    names: &[String],
) -> Result<(), String> {
    let kind = ctx.header()["kind"].as_str().unwrap_or("").to_owned();
    for name in names {
        let case = match kind.as_str() {
            "rebuild" => super::rebuild::record_case(ctx, name)?,
            "plugin-ops" => super::plugin_ops::record_case(ctx, name)?,
            "meshes" => super::meshes::record_case(ctx, name)?,
            "fillet" => super::evals::record_fillet(ctx, name)?,
            "selectors" => super::evals::record_selector(ctx, name)?,
            other => {
                return Err(format!(
                    "a golden of kind {other} is not recorded from a corpus"
                ))
            }
        };
        let replaced = ctx.golden["cases"]
            .as_object_mut()
            .ok_or("the golden has no cases")?
            .insert(name.clone(), case)
            .is_some();
        println!(
            "recorded {name} from this engine{}",
            if replaced {
                ", replacing its golden"
            } else {
                ""
            }
        );
    }
    match kind.as_str() {
        "fillet" => super::evals::refresh_fillet_summary(ctx),
        "selectors" => super::evals::refresh_selector_metrics(ctx),
        _ => {}
    }
    let bytes = std::fs::read(corpus_path)
        .map_err(|e| format!("cannot read {}: {e}", corpus_path.display()))?;
    let header = ctx.golden["golden"]
        .as_object_mut()
        .ok_or("the golden has no header")?;
    header.insert(
        "corpusSha256".into(),
        Value::String(sha256_hex(&fold_crlf(&bytes))),
    );
    let recorded = header
        .entry("rustRecorded")
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Value::Array(list) = recorded {
        for n in names {
            if !list.iter().any(|x| x == n.as_str()) {
                list.push(Value::String(n.clone()));
            }
        }
        list.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    }
    let mut out = python_dump(&ctx.golden);
    out.push('\n');
    let mut f = std::fs::File::create(golden_path)
        .map_err(|e| format!("cannot write {}: {e}", golden_path.display()))?;
    f.write_all(out.as_bytes()).map_err(|e| e.to_string())
}

/// Why a platform holds answers of its own: see `record_platform`.
const PLATFORM_REASON: &str = "the python answers were frozen on Windows, whose C math library rounds some sin, cos and pow results one ulp away from this platform's; where that ulp decides a tie (a Delaunay diagonal between cocircular points, a node the mesher places on one of two symmetric sides, a coordinate on a rounding boundary) this platform's answer differs from Windows' only by that tie, and is this engine's here, recorded after a human check";

/// `--record-platform`: this engine's answers for the named cases, kept under
/// `platformVariants.<os>` beside the python answers, which every other
/// platform is still held to.
pub fn record_platform(ctx: &mut Ctx, golden_path: &Path, names: &[String]) -> Result<(), String> {
    let kind = ctx.header()["kind"].as_str().unwrap_or("").to_owned();
    let os = std::env::consts::OS;
    for name in names {
        if ctx.cases().get(name).is_none() {
            return Err(format!("the golden has no answer for {name} to stand beside"));
        }
        let case = match kind.as_str() {
            "rebuild" => super::rebuild::record_case(ctx, name)?,
            "plugin-ops" => super::plugin_ops::record_case(ctx, name)?,
            "meshes" => super::meshes::record_case(ctx, name)?,
            other => return Err(format!("a golden of kind {other} holds no platform answers")),
        };
        let root = ctx.golden.as_object_mut().ok_or("the golden is not an object")?;
        let variants = root
            .entry("platformVariants")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or("platformVariants is not an object")?;
        let this = variants
            .entry(os)
            .or_insert_with(|| serde_json::json!({"reason": PLATFORM_REASON, "cases": {}}));
        this["cases"]
            .as_object_mut()
            .ok_or("platformVariants cases is not an object")?
            .insert(name.clone(), case);
        println!("recorded {name} for {os} from this engine, beside the python answer");
    }
    let mut out = python_dump(&ctx.golden);
    out.push('\n');
    let mut f = std::fs::File::create(golden_path)
        .map_err(|e| format!("cannot write {}: {e}", golden_path.display()))?;
    f.write_all(out.as_bytes()).map_err(|e| e.to_string())
}

/// This platform's own answers in place of the python ones they stand beside.
pub fn apply_platform_variants(ctx: &mut Ctx) -> Vec<String> {
    let os = std::env::consts::OS;
    let own = ctx.golden["platformVariants"][os]["cases"].clone();
    let Some(own) = own.as_object() else {
        return Vec::new();
    };
    let Some(cases) = ctx.golden["cases"].as_object_mut() else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for (name, case) in own {
        if cases.contains_key(name) {
            cases.insert(name.clone(), case.clone());
            names.push(name.clone());
        }
    }
    names
}

/// `json.dump(v, sort_keys=True, indent=1, ensure_ascii=True)`, byte for byte,
/// so a recorded golden diffs only where it changed.
pub fn python_dump(v: &Value) -> String {
    let mut out = String::new();
    dump(v, 0, &mut out);
    out
}

fn dump(v: &Value, depth: usize, out: &mut String) {
    let pad = |d: usize| format!("\n{}", " ".repeat(d));
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&python_number(n)),
        Value::String(s) => out.push_str(&python_string(s)),
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&pad(depth + 1));
                dump(x, depth + 1, out);
            }
            out.push_str(&pad(depth));
            out.push(']');
        }
        Value::Object(m) if m.is_empty() => out.push_str("{}"),
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&pad(depth + 1));
                out.push_str(&python_string(k));
                out.push_str(": ");
                dump(&m[*k], depth + 1, out);
            }
            out.push_str(&pad(depth));
            out.push('}');
        }
    }
}

fn python_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || !c.is_ascii() => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{u:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Python's float repr: the shortest round trip digits, positional from 1e-4
/// up to 1e16, otherwise d.ddde[+-]XX.
fn python_number(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    let x = n.as_f64().unwrap_or(0.0);
    if x == 0.0 {
        return if x.is_sign_negative() {
            "-0.0".into()
        } else {
            "0.0".into()
        };
    }
    let sci = format!("{x:e}");
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if (-4..16).contains(&exp) {
        let s = format!("{x}");
        if s.contains('.') {
            s
        } else {
            format!("{s}.0")
        }
    } else {
        format!("{mant}e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

/// freeze_goldens.ivec.
pub fn ivec(values: &[i64]) -> String {
    let mut raw = Vec::new();
    let mut prev = 0i64;
    for &v in values {
        let d = v.wrapping_sub(prev);
        prev = v;
        let mut z = ((d << 1) ^ (d >> 63)) as u64;
        while z >= 0x80 {
            raw.push((z as u8 & 0x7F) | 0x80);
            z >>= 7;
        }
        raw.push(z as u8);
    }
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    let _ = enc.write_all(&raw);
    let packed = enc.finish().unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(packed)
}

/// freeze_goldens.quantised_columns: rows of three, rounded half to even.
pub fn quantised_columns(rows: &[[f64; 3]], quantum: f64) -> String {
    let n = rows.len();
    let mut flat = vec![0i64; 3 * n];
    for (i, r) in rows.iter().enumerate() {
        for k in 0..3 {
            flat[k * n + i] = (r[k] / quantum).round_ties_even() as i64;
        }
    }
    ivec(&flat)
}

/// freeze_goldens.sig: `digits` significant digits.
pub fn sig(x: f64, digits: usize) -> Value {
    if x == 0.0 || !x.is_finite() {
        return serde_json::json!(x);
    }
    let s = format!("{x:.*e}", digits - 1);
    serde_json::json!(s.parse::<f64>().unwrap_or(x))
}

/// freeze_goldens.fixed: `places` decimals.
pub fn fixed(x: f64, places: i32) -> Value {
    let s = format!("{x:.*}", places as usize);
    serde_json::json!(s.parse::<f64>().unwrap_or(x) + 0.0)
}

pub fn object(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_owned(), v);
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_print_as_python_repr() {
        let f = |x: f64| python_number(serde_json::Number::from_f64(x).as_ref().unwrap());
        assert_eq!(f(8000.0), "8000.0");
        assert_eq!(f(1e-5), "1e-05");
        assert_eq!(f(0.0001), "0.0001");
        assert_eq!(f(0.005), "0.005");
        assert_eq!(f(1e16), "1e+16");
        assert_eq!(f(-6.100000000000006), "-6.100000000000006");
        assert_eq!(f(1.5e-9), "1.5e-09");
    }

    #[test]
    fn ivec_round_trips() {
        let v = vec![0, 5, -3, 1 << 40, -(1 << 40), 7];
        assert_eq!(super::super::ivec(&Value::String(ivec(&v))).unwrap(), v);
    }
}
