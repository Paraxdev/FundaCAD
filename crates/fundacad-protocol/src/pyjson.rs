//! JSON text exactly as Python's `json.dumps` writes it with default arguments.
//!
//! Replaces the implicit dependency of `sidecar/wire.py` on the stdlib encoder.
//! The defaults differ from serde_json in three visible ways: `", "` and `": "`
//! separators, `ensure_ascii` (every non-ASCII character and DEL as `\uXXXX`),
//! and floats in `repr` form (`1e-05`, `1e+16`, `1.0`). Matching them is what
//! lets a Rust reply be compared byte for byte against the Python one.

use serde_json::{Map, Number, Value};
use std::fmt::Write as _;

pub fn to_string(v: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, v);
    out
}

pub fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => write_str(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => write_map(out, map),
    }
}

pub fn write_map(out: &mut String, map: &Map<String, Value>) {
    out.push('{');
    for (i, (k, v)) in map.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        write_str(out, k);
        out.push_str(": ");
        write_value(out, v);
    }
    out.push('}');
}

fn write_number(out: &mut String, n: &Number) {
    if let Some(u) = n.as_u64() {
        let _ = write!(out, "{u}");
    } else if let Some(i) = n.as_i64() {
        let _ = write!(out, "{i}");
    } else if let Some(f) = n.as_f64() {
        write_float(out, f);
    }
}

/// `float.__repr__`: the shortest digits that round-trip, in positional form
/// when the decimal exponent is in [-4, 16), otherwise scientific with a signed,
/// at least two digit exponent.
pub fn write_float(out: &mut String, f: f64) {
    if f.is_nan() {
        out.push_str("NaN");
        return;
    }
    if f.is_infinite() {
        out.push_str(if f > 0.0 { "Infinity" } else { "-Infinity" });
        return;
    }
    // Rust's `{:e}` gives the shortest round-trip digit COUNT, but when two
    // candidates of that length are equally close it rounds the tie up where
    // Python rounds it to even (-137.79507446289062, an f32 widened). Exact
    // formatting at that precision rounds ties to even, so it is redone that way.
    let shortest = format!("{f:e}");
    let n_digits = shortest
        .split('e')
        .next()
        .map_or(1, |m| m.bytes().filter(u8::is_ascii_digit).count());
    let sci = format!("{f:.prec$e}", prec = n_digits.saturating_sub(1));
    let (neg, body) = match sci.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, sci.as_str()),
    };
    let (mant, exp) = body.split_once('e').unwrap_or((body, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let mut digits: String = mant.chars().filter(|c| *c != '.').collect();
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    if neg {
        out.push('-');
    }
    if !(-4..16).contains(&exp) {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let _ = write!(out, "e{}{:02}", if exp < 0 { '-' } else { '+' }, exp.abs());
    } else if exp >= 0 {
        let int_len = exp as usize + 1;
        if digits.len() <= int_len {
            out.push_str(&digits);
            out.extend(std::iter::repeat('0').take(int_len - digits.len()));
            out.push_str(".0");
        } else {
            out.push_str(&digits[..int_len]);
            out.push('.');
            out.push_str(&digits[int_len..]);
        }
    } else {
        out.push_str("0.");
        out.extend(std::iter::repeat('0').take((-exp - 1) as usize));
        out.push_str(&digits);
    }
}

pub fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            _ => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{:04x}", unit);
                }
            }
        }
    }
    out.push('"');
}

/// Python truthiness of a JSON value, for the `res.get("resync")` style checks.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(m)) => !m.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn f(x: f64) -> String {
        let mut s = String::new();
        write_float(&mut s, x);
        s
    }

    #[test]
    fn floats_match_python_repr() {
        assert_eq!(f(0.0), "0.0");
        assert_eq!(f(-0.0), "-0.0");
        assert_eq!(f(1.0), "1.0");
        assert_eq!(f(0.1), "0.1");
        assert_eq!(f(0.0001), "0.0001");
        assert_eq!(f(0.00001), "1e-05");
        assert_eq!(f(1.5e-7), "1.5e-07");
        assert_eq!(f(1e16), "1e+16");
        assert_eq!(f(1234567890123456.0), "1234567890123456.0");
        assert_eq!(f(1.25e300), "1.25e+300");
        assert_eq!(f(-123.456), "-123.456");
        assert_eq!(f(100.0), "100.0");
        assert_eq!(f(f64::INFINITY), "Infinity");
    }

    #[test]
    fn strings_are_ascii_escaped() {
        let mut s = String::new();
        write_str(&mut s, "a\"b\\c\n\u{1}\u{7f}\u{e9}\u{201c}\u{1f600}");
        let bs = char::from(92u8);
        let want = format!(
            "\"a{bs}\"b{bs}{bs}c{bs}n{bs}u0001{bs}u007f{bs}u00e9{bs}u201c{bs}ud83d{bs}ude00\""
        );
        assert_eq!(s, want);
    }

    #[test]
    fn containers_use_python_separators() {
        let v = json!({"id": "x", "ok": true, "a": [1, -2, 2.5], "e": {}, "l": [], "n": null});
        assert_eq!(
            to_string(&v),
            r#"{"id": "x", "ok": true, "a": [1, -2, 2.5], "e": {}, "l": [], "n": null}"#
        );
    }

    #[test]
    fn truthiness() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!(1))));
        assert!(truthy(Some(&json!(true))));
    }
}
