//! Python's float and JSON text, so the writers produce the Python engine's bytes:
//! `format(x, ".6e")`, `format(x, ".6g")`, `repr(float)` and `json.dumps`
//! with its default `ensure_ascii`.

use std::fmt::Write;

fn non_finite(x: f64) -> Option<&'static str> {
    if x.is_nan() {
        Some("nan")
    } else if x == f64::INFINITY {
        Some("inf")
    } else if x == f64::NEG_INFINITY {
        Some("-inf")
    } else {
        None
    }
}

/// Splits Rust's `{:.N e}` text into mantissa and exponent.
fn sci(x: f64, precision: usize) -> (String, i32) {
    let s = format!("{x:.precision$e}");
    let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
    (m.to_string(), e.parse().unwrap_or(0))
}

fn exponent(out: &mut String, e: i32) {
    let _ = write!(out, "e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs());
}

/// `format(x, ".6e")`.
pub fn e6(x: f64) -> String {
    if let Some(s) = non_finite(x) {
        return s.into();
    }
    let (mut m, e) = sci(x, 6);
    exponent(&mut m, e);
    m
}

fn strip_zeros(s: &mut String) {
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
}

/// `format(x, ".6g")`.
pub fn g6(x: f64) -> String {
    if let Some(s) = non_finite(x) {
        return s.into();
    }
    let p = 6;
    let (mut m, e) = sci(x, p - 1);
    if (-4..p as i32).contains(&e) {
        let decimals = (p as i32 - 1 - e) as usize;
        let mut s = format!("{x:.decimals$}");
        strip_zeros(&mut s);
        s
    } else {
        strip_zeros(&mut m);
        exponent(&mut m, e);
        m
    }
}

/// `repr(x)` for a float, the shortest text that reads back to `x`.
pub fn repr(x: f64) -> String {
    if let Some(s) = non_finite(x) {
        return match s {
            "nan" => "NaN".into(),
            "inf" => "Infinity".into(),
            _ => "-Infinity".into(),
        };
    }
    let s = format!("{x:e}");
    let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
    let e: i32 = e.parse().unwrap_or(0);
    let (sign, m) = m.strip_prefix('-').map_or(("", m), |r| ("-", r));
    let digits: String = m.chars().filter(|c| *c != '.').collect();
    let n = digits.len() as i32;
    let mut out = String::from(sign);
    if (-4..16).contains(&e) {
        if e >= 0 {
            let int_len = (e + 1) as usize;
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
            out.extend(std::iter::repeat('0').take((-e - 1) as usize));
            out.push_str(&digits);
        }
    } else {
        out.push_str(&digits[..1]);
        if n > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        exponent(&mut out, e);
    }
    out
}

/// `round(x, 6)`.
pub fn round6(x: f64) -> f64 {
    format!("{x:.6}").parse().unwrap_or(x)
}

/// `json.dumps(s)`, ASCII only.
pub fn json_str(out: &mut String, s: &str) {
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
            c if (' '..='~').contains(&c) => out.push(c),
            c => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    let _ = write!(out, "\\u{unit:04x}");
                }
            }
        }
    }
    out.push('"');
}

/// A JSON value written the way `json.dumps(v, separators=(",", ":"))` writes it.
#[derive(Debug, Clone)]
pub enum Json {
    Int(i64),
    Float(f64),
    Str(String),
    Bool(bool),
    Arr(Vec<Json>),
    Obj(Vec<(&'static str, Json)>),
}

impl Json {
    pub fn write(&self, out: &mut String) {
        match self {
            Json::Int(i) => {
                let _ = write!(out, "{i}");
            }
            Json::Float(f) => out.push_str(&repr(*f)),
            Json::Str(s) => json_str(out, s),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Arr(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    json_str(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// `f"{n:,}"`.
pub fn thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_print_as_python_prints_them() {
        for (x, e, g, r) in [
            (0.0, "0.000000e+00", "0", "0.0"),
            (-0.0, "-0.000000e+00", "-0", "-0.0"),
            (10.0, "1.000000e+01", "10", "10.0"),
            (-5.000000001, "-5.000000e+00", "-5", "-5.000000001"),
            (1234567.0, "1.234567e+06", "1.23457e+06", "1234567.0"),
            (0.00001, "1.000000e-05", "1e-05", "1e-05"),
            (0.0001234567, "1.234567e-04", "0.000123457", "0.0001234567"),
            (1e16, "1.000000e+16", "1e+16", "1e+16"),
            (123456.5, "1.234565e+05", "123456", "123456.5"),
            (0.1 + 0.2, "3.000000e-01", "0.3", "0.30000000000000004"),
            (999999.5, "9.999995e+05", "1e+06", "999999.5"),
        ] {
            assert_eq!(e6(x), e, "{x} e");
            assert_eq!(g6(x), g, "{x} g");
            assert_eq!(repr(x), r, "{x} repr");
        }
        assert_eq!(thousands(10_000_001), "10,000,001");
        assert_eq!(thousands(999), "999");
        let mut s = String::new();
        json_str(&mut s, "a\"\u{e9}\u{1F600}\u{1}");
        assert_eq!(s, "\"a\\\"\\u00e9\\ud83d\\ude00\\u0001\"");
    }
}
