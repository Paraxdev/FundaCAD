//! Typed text as a feature value, as FeatureProperties' parseField reads a plain number, a fraction or a measurement.
//! Expressions belong to the parameters lane, so anything else is refused here.

use super::fields::Kind;

struct Unit {
    label: &'static str,
    kind: Kind,
    /// Millimetres or degrees per unit.
    factor: f64,
    aliases: &'static [&'static str],
}

const UNITS: &[Unit] = &[
    Unit {
        label: "mm",
        kind: Kind::Length,
        factor: 1.,
        aliases: &["mm", "millimeter", "millimeters", "millimetre", "millimetres"],
    },
    Unit {
        label: "cm",
        kind: Kind::Length,
        factor: 10.,
        aliases: &["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
    },
    Unit { label: "m", kind: Kind::Length, factor: 1000., aliases: &["m", "meter", "meters", "metre", "metres"] },
    Unit { label: "in", kind: Kind::Length, factor: 25.4, aliases: &["in", "inch", "inches", "\"", "″"] },
    Unit { label: "ft", kind: Kind::Length, factor: 304.8, aliases: &["ft", "foot", "feet", "'", "′"] },
    Unit {
        label: "µm",
        kind: Kind::Length,
        factor: 0.001,
        aliases: &["um", "µm", "micron", "microns", "micrometer", "micrometers"],
    },
    Unit { label: "thou", kind: Kind::Length, factor: 0.0254, aliases: &["thou", "mil", "mils"] },
    Unit { label: "°", kind: Kind::Angle, factor: 1., aliases: &["deg", "degree", "degrees", "°"] },
    Unit {
        label: "rad",
        kind: Kind::Angle,
        factor: 180. / std::f64::consts::PI,
        aliases: &["rad", "radian", "radians"],
    },
];

/// The unit a text ends in and the text before it, the longest spelling first so "mm" is not read as "m".
fn split_unit(t: &str) -> Option<(&str, &'static Unit)> {
    let lower = t.to_lowercase();
    let mut best: Option<(usize, &'static Unit)> = None;
    for u in UNITS {
        for a in u.aliases {
            if lower.ends_with(&a.to_lowercase()) && best.is_none_or(|(n, _)| a.len() > n) {
                best = Some((a.len(), u));
            }
        }
    }
    let (n, u) = best?;
    // The lowercase text has the same byte length for every spelling a unit has.
    let rest = t.get(..t.len().checked_sub(n)?)?;
    Some((rest.trim_end(), u))
}

fn plain(t: &str) -> Option<f64> {
    let ok = !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '+' | '-' | 'e' | 'E'));
    ok.then(|| t.parse::<f64>().ok()).flatten().filter(|v| v.is_finite())
}

/// "3/4" or "1 1/2", one value rather than arithmetic.
fn fraction(t: &str) -> Option<f64> {
    let (sign, t) = match t.strip_prefix('-') {
        Some(rest) => (-1., rest.trim_start()),
        None => (1., t.strip_prefix('+').unwrap_or(t).trim_start()),
    };
    let (whole, frac) = match t.rsplit_once(char::is_whitespace) {
        Some((w, f)) if !f.trim().is_empty() && f.contains('/') && !w.contains('/') => (w.trim(), f),
        _ => ("0", t),
    };
    let (num, den) = frac.split_once('/')?;
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let (num, den) = (num.trim(), den.trim());
    if !digits(whole) || !digits(num) || !digits(den) {
        return None;
    }
    let den: f64 = den.parse().ok().filter(|d: &f64| *d != 0.)?;
    Some(sign * (whole.parse::<f64>().ok()? + num.parse::<f64>().ok()? / den))
}

fn number(t: &str) -> Option<f64> {
    plain(t).or_else(|| fraction(t))
}

fn dim_words(kind: Kind) -> &'static str {
    match kind {
        Kind::Angle => "an angle",
        _ => "a length",
    }
}

/// The value in millimetres or degrees, or why the text is no value of this kind.
pub fn parse(kind: Kind, raw: &str) -> Result<f64, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("empty value".into());
    }
    if let Some(v) = number(t) {
        return Ok(v);
    }
    match split_unit(t).and_then(|(rest, u)| Some((number(rest)?, u))) {
        Some(_) if kind == Kind::Count => Err("this field is unitless, write a plain number".into()),
        Some((_, u)) if u.kind != kind => Err(format!("{} is not {}", u.label, dim_words(kind))),
        Some((v, u)) => Ok(v * u.factor),
        None => Err("not a number or a measurement".into()),
    }
}
