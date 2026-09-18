//! Python's `format(v, "g")`, which the handlers' messages quote values with.

pub fn py_g(v: f64) -> String {
    py_g_prec(v, 6)
}

/// Python's `format(v, ".{prec}g")`.
pub fn py_g_prec(v: f64, prec: usize) -> String {
    let prec = prec.max(1);
    if v.is_nan() {
        return "nan".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if v == 0.0 {
        return if v.is_sign_negative() {
            "-0".into()
        } else {
            "0".into()
        };
    }
    let sig = prec - 1;
    let sci = format!("{v:.sig$e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    if (-4..prec as i32).contains(&exp) {
        let decimals = usize::try_from(sig as i32 - exp).unwrap_or(0);
        strip_zeros(&format!("{v:.decimals$}"))
    } else {
        let sign = if exp < 0 { '-' } else { '+' };
        format!("{}e{sign}{:02}", strip_zeros(mantissa), exp.abs())
    }
}

fn strip_zeros(s: &str) -> String {
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{py_g, py_g_prec};

    #[test]
    fn matches_python_general_format() {
        for (v, want) in [
            (0.0, "0"),
            (95.0, "95"),
            (-2.5, "-2.5"),
            (-0.0001, "-0.0001"),
            (0.00001, "1e-05"),
            (1234567.0, "1.23457e+06"),
            (123456.0, "123456"),
            (0.1 + 0.2, "0.3"),
            (1e22, "1e+22"),
            (999999.5, "1e+06"),
        ] {
            assert_eq!(py_g(v), want, "{v}");
        }
    }

    #[test]
    fn matches_python_four_significant_digits() {
        for (v, want) in [
            (1.38, "1.38"),
            (2.0, "2"),
            (12345.0, "1.234e+04"),
            (9999.5, "1e+04"),
            (0.123456, "0.1235"),
        ] {
            assert_eq!(py_g_prec(v, 4), want, "{v}");
        }
    }
}
