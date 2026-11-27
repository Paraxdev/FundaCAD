//! The display unit, FundaCAD 1's ui/units.ts: lengths are millimetres inside and shown in the unit picked here.

#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};

use crate::settings;

const KEY: &str = "unit";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    #[default]
    Mm,
    Cm,
    In,
}

impl Unit {
    pub const ALL: [Unit; 3] = [Unit::Mm, Unit::Cm, Unit::In];

    pub fn id(self) -> &'static str {
        match self {
            Unit::Mm => "mm",
            Unit::Cm => "cm",
            Unit::In => "in",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Unit::Mm => "Millimeter",
            Unit::Cm => "Centimeter",
            Unit::In => "Inch",
        }
    }

    fn factor(self) -> f64 {
        match self {
            Unit::Mm => 1.,
            Unit::Cm => 10.,
            Unit::In => 25.4,
        }
    }
}

pub fn unit() -> Unit {
    settings::read(KEY).unwrap_or_default()
}

pub fn set_unit(u: Unit) {
    settings::write(KEY, &u);
}

/// FundaCAD 1's roundForDisplay: a thousandth when that is exact, else two decimals, more below one.
pub fn display_round(v: f64) -> f64 {
    if !v.is_finite() {
        return v;
    }
    let chosen = (v * 1e3).round() / 1e3;
    if (v - chosen).abs() <= 1e-9 * v.abs().max(1.) {
        return chosen;
    }
    let a = v.abs();
    if a >= 1. {
        return (v * 100.).round() / 100.;
    }
    let dp = (2. + (-a.log10()).ceil()).min(6.);
    let f = 10f64.powf(dp);
    (v * f).round() / f
}

/// A length in millimetres as `40 mm`, `4 cm` or `1.57 in`.
pub fn fmt_length(mm: f64, u: Unit) -> String {
    format!("{} {}", display_round(mm / u.factor()), u.id())
}
