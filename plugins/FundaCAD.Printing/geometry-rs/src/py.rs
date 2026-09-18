//! What the Python half's output depends on from Python itself: `format(v,
//! ".6g")`, `repr(float)`, `str()` of a JSON value, `int()`, truthiness,
//! `xml.sax.saxutils.quoteattr` and `json.dumps(indent=1)`.

use serde_json::Value;

fn strip_zeros(s: &str) -> String {
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s.to_owned()
    }
}

/// `format(v, f".{prec}g")`.
pub fn g(v: f64, prec: usize) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let p = prec.max(1);
    if v == 0.0 {
        return if v.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    let sci = format!("{v:.*e}", p - 1);
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if exp >= -4 && exp < p as i32 {
        let decimals = usize::try_from(p as i32 - 1 - exp).unwrap_or(0);
        strip_zeros(&format!("{v:.decimals$}"))
    } else {
        let sign = if exp < 0 { '-' } else { '+' };
        format!("{}e{sign}{:02}", strip_zeros(mantissa), exp.abs())
    }
}

/// `repr(float)`: the shortest round trip digits, positional from 1e-4 up to
/// 1e16 with a ".0" on a whole number, scientific outside that.
pub fn repr_float(v: f64) -> String {
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if v == 0.0 {
        return if v.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let sci = format!("{v:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if (-4..16).contains(&exp) {
        let s = format!("{v}");
        if s.contains('.') {
            s
        } else {
            format!("{s}.0")
        }
    } else {
        let sign = if exp < 0 { '-' } else { '+' };
        format!("{mantissa}e{sign}{:02}", exp.abs())
    }
}

fn repr_number(n: &serde_json::Number) -> String {
    if n.is_f64() {
        repr_float(n.as_f64().unwrap_or(0.0))
    } else {
        n.to_string()
    }
}

/// `repr(str)`.
pub fn repr_str(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
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
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

fn repr(v: &Value) -> String {
    match v {
        Value::String(s) => repr_str(s),
        other => str_of(other),
    }
}

/// `str(v)` of a value json.loads made.
pub fn str_of(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => repr_number(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", repr_str(k), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// `int(v)`, `None` where Python raises.
pub fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|x| x.is_finite()).map(|x| x.trunc() as i64)),
        Value::String(s) => {
            let t = s.trim();
            let (sign, digits) = match t.strip_prefix('-') {
                Some(r) => (-1, r),
                None => (1, t.strip_prefix('+').unwrap_or(t)),
            };
            let clean: String = digits.chars().filter(|&c| c != '_').collect();
            if clean.is_empty()
                || !clean.chars().all(|c| c.is_ascii_digit())
                || digits.starts_with('_')
                || digits.ends_with('_')
                || digits.contains("__")
            {
                return None;
            }
            clean.parse::<i64>().ok().map(|n| sign * n)
        }
        _ => None,
    }
}

/// `xml.sax.saxutils.quoteattr`.
pub fn quoteattr(s: &str) -> String {
    let mut d = s.replace('&', "&amp;").replace('>', "&gt;").replace('<', "&lt;");
    d = d.replace('\n', "&#10;").replace('\r', "&#13;").replace('\t', "&#9;");
    if d.contains('"') {
        if d.contains('\'') {
            format!("\"{}\"", d.replace('"', "&quot;"))
        } else {
            format!("'{d}'")
        }
    } else {
        format!("\"{d}\"")
    }
}

fn dump_str(s: &str, out: &mut String) {
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
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn dump(v: &Value, depth: usize, out: &mut String) {
    let pad = |n: usize, out: &mut String| {
        out.push('\n');
        out.push_str(&" ".repeat(n));
    };
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_f64() {
                let x = n.as_f64().unwrap_or(0.0);
                if x.is_nan() {
                    out.push_str("NaN");
                } else if x.is_infinite() {
                    out.push_str(if x > 0.0 { "Infinity" } else { "-Infinity" });
                } else {
                    out.push_str(&repr_float(x));
                }
            } else {
                out.push_str(&n.to_string());
            }
        }
        Value::String(s) => dump_str(s, out),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                pad(depth + 1, out);
                dump(x, depth + 1, out);
            }
            pad(depth, out);
            out.push(']');
        }
        Value::Object(o) => {
            if o.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                pad(depth + 1, out);
                dump_str(k, out);
                out.push_str(": ");
                dump(x, depth + 1, out);
            }
            pad(depth, out);
            out.push('}');
        }
    }
}

/// `json.dumps(v, indent=1)`.
pub fn dumps_indent1(v: &Value) -> String {
    let mut out = String::new();
    dump(v, 0, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_like_python() {
        assert_eq!(g(115.0, 6), "115");
        assert_eq!(g(-0.0, 6), "-0");
        assert_eq!(g(0.1 + 0.2, 6), "0.3");
        assert_eq!(g(1234567.0, 6), "1.23457e+06");
        assert_eq!(g(0.00001234, 6), "1.234e-05");
        assert_eq!(g(0.123, 2), "0.12");
        assert_eq!(repr_float(1e16), "1e+16");
        assert_eq!(repr_float(1e15), "1000000000000000.0");
        assert_eq!(repr_float(0.0001), "0.0001");
        assert_eq!(repr_float(0.00001), "1e-05");
        assert_eq!(repr_float(2.5), "2.5");
        assert_eq!(quoteattr("a\"b"), "'a\"b'");
        assert_eq!(quoteattr("a\"b'c<"), "\"a&quot;b'c&lt;\"");
        assert_eq!(int_of(&json!(" 2 ")), Some(2));
        assert_eq!(int_of(&json!(2.9)), Some(2));
        assert_eq!(int_of(&json!("x")), None);
        assert_eq!(str_of(&json!([1, "a", 2.0])), "[1, 'a', 2.0]");
        assert_eq!(
            dumps_indent1(&json!({"a": [1, "é"], "b": {}, "c": []})),
            "{\n \"a\": [\n  1,\n  \"\\u00e9\"\n ],\n \"b\": {},\n \"c\": []\n}"
        );
    }
}
