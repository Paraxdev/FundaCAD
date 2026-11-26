//! The Inspect family's sums, ported from FundaCAD 1's TypeScript: Measure, Properties, the print estimate, Overhang
//! and Bed Fit. They read the tessellation the view draws, so curved geometry is close, not exact.

pub mod bedfit;
pub mod filament;
pub mod measure;
pub mod overhang;
pub mod props;

#[cfg(test)]
mod tests;

/// One readout line, a name and its value.
pub type Row = (String, String);

/// A number as the readouts print it, three decimals at most and no trailing zeros, FundaCAD 1's spellRounded.
pub fn spell(v: f64) -> String {
    if !v.is_finite() {
        return "?".into();
    }
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0" } else { s }.to_string()
}

pub fn spell_xyz(v: [f64; 3]) -> String {
    v.map(spell).join(", ")
}
