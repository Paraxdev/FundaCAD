//! What the Python half's messages and conversions depend on from Python:
//! `repr`, `str()`, truthiness, `float()` and `int()` of the values json.loads
//! made.

use serde_json::Value;

/// `repr(float)`.
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

/// `repr(v)`.
pub fn repr(v: &Value) -> String {
    match v {
        Value::String(s) => repr_str(s),
        other => str_of(other),
    }
}

/// `str(v)`.
pub fn str_of(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) if n.is_f64() => repr_float(n.as_f64().unwrap_or(0.0)),
        Value::Number(n) => n.to_string(),
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

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(_) => "float",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `float(v)`.
pub fn float(v: &Value) -> Result<f64, String> {
    match v {
        Value::Number(n) => Ok(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::String(s) => {
            let t = s.trim();
            let clean: String = t.chars().filter(|&c| c != '_').collect();
            let lower = clean.to_ascii_lowercase();
            let body = lower.trim_start_matches(['+', '-']);
            let neg = lower.starts_with('-');
            let special = match body {
                "inf" | "infinity" => Some(f64::INFINITY),
                "nan" => Some(f64::NAN),
                _ => None,
            };
            if let Some(x) = special {
                return Ok(if neg { -x } else { x });
            }
            let ok_chars = !clean.is_empty()
                && clean.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
            match clean.parse::<f64>() {
                Ok(x) if ok_chars => Ok(x),
                _ => Err(format!("could not convert string to float: {}", repr_str(s))),
            }
        }
        other => Err(format!(
            "float() argument must be a string or a real number, not '{}'",
            type_name(other)
        )),
    }
}

/// `int(v)`.
pub fn int(v: &Value) -> Result<i64, String> {
    match v {
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Ok(i),
            None => {
                let x = n.as_f64().unwrap_or(f64::NAN);
                if x.is_nan() {
                    Err("cannot convert float NaN to integer".into())
                } else if x.is_infinite() {
                    Err("cannot convert float infinity to integer".into())
                } else {
                    Ok(x.trunc() as i64)
                }
            }
        },
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
                return Err(format!("invalid literal for int() with base 10: {}", repr_str(s)));
            }
            clean
                .parse::<i64>()
                .map(|n| sign * n)
                .map_err(|_| format!("invalid literal for int() with base 10: {}", repr_str(s)))
        }
        other => Err(format!(
            "int() argument must be a string, a bytes-like object or a real number, not '{}'",
            type_name(other)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_like_python() {
        assert_eq!(float(&json!(" 2.5 ")).unwrap(), 2.5);
        assert!(float(&json!("x")).is_err());
        assert_eq!(int(&json!(3.9)).unwrap(), 3);
        assert_eq!(int(&json!("-4")).unwrap(), -4);
        assert_eq!(repr(&json!("gl'it")), "\"gl'it\"");
    }
}
