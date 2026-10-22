//! JSON text exactly as Python's default `json.dumps` writes it, so a reply compares byte for byte with the Python one:
//! `", "` and `": "` separators, `ensure_ascii` (non-ASCII and DEL as `\uXXXX`) and `repr` floats (`1e-05`, `1.0`).

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

/// `float.__repr__`: the shortest round-trip digits, positional when the decimal exponent is in [-4, 16), else
/// scientific with a signed exponent of at least two digits.
pub fn write_float(out: &mut String, f: f64) {
    if f.is_nan() {
        out.push_str("NaN");
        return;
    }
    if f.is_infinite() {
        out.push_str(if f > 0.0 { "Infinity" } else { "-Infinity" });
        return;
    }
    // `{:e}` has the shortest round-trip digit count but rounds a tie up where Python rounds it to even
    // (-137.79507446289062, an f32 widened), so the digits are redone with exact formatting at that precision.
    let shortest = format!("{f:e}");
    let n_digits = shortest.split('e').next().map_or(1, |m| m.bytes().filter(u8::is_ascii_digit).count());
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

/// `%g` with six significant digits, the way Python prints it.
pub fn g_format(v: f64) -> String {
    if v == 0.0 {
        // Negative zero keeps its sign, as `%g` prints it. It is what a normal
        // of (-1, -0, 0) reads as, and the two servers have to agree on it.
        return if v.is_sign_negative() { "-0" } else { "0" }.into();
    }
    if !v.is_finite() {
        return if v.is_nan() {
            "nan".into()
        } else if v > 0.0 {
            "inf".into()
        } else {
            "-inf".into()
        };
    }
    let exp = v.abs().log10().floor() as i32;
    if exp < -4 || exp >= 6 {
        let mantissa = trim_zeros(&format!("{:.5}", v / 10f64.powi(exp)));
        let sign = if exp < 0 { '-' } else { '+' };
        return format!("{mantissa}e{sign}{:02}", exp.abs());
    }
    trim_zeros(&format!("{:.*}", (5 - exp).max(0) as usize, v))
}

fn trim_zeros(s: &str) -> String {
    if !s.contains('.') {
        return s.to_string();
    }
    let t = s.trim_end_matches('0');
    t.strip_suffix('.').unwrap_or(t).to_string()
}
