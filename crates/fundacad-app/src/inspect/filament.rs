//! The print estimate under Properties, FundaCAD 1's filamentEstimate.ts: the shell (area times wall) is solid, the
//! rest is charged at the infill fraction. An estimate, not a toolpath.

#[cfg(test)]
mod tests;

pub struct Material {
    pub id: &'static str,
    pub label: &'static str,
    /// g/cm3
    pub density: f64,
}

pub const MATERIALS: &[Material] = &[
    Material { id: "pla", label: "PLA", density: 1.24 },
    Material { id: "petg", label: "PETG", density: 1.27 },
    Material { id: "abs", label: "ABS", density: 1.04 },
    Material { id: "asa", label: "ASA", density: 1.07 },
    Material { id: "tpu", label: "TPU", density: 1.21 },
    Material { id: "nylon", label: "Nylon", density: 1.14 },
];

pub const CUSTOM: &str = "custom";
pub const DIAMETERS: [f64; 2] = [1.75, 2.85];

#[derive(Clone, Debug, PartialEq)]
pub struct Prefs {
    pub material: String,
    pub custom_density: f64,
    pub infill_pct: f64,
    pub wall_mm: f64,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { material: "pla".into(), custom_density: 1.24, infill_pct: 20.0, wall_mm: 0.8 }
    }
}

pub fn density_for(p: &Prefs) -> f64 {
    if p.material == CUSTOM {
        return p.custom_density;
    }
    MATERIALS.iter().find(|m| m.id == p.material).unwrap_or(&MATERIALS[0]).density
}

/// mm3 of plastic. The shell is capped at the whole volume so a thin part never gets a shell larger than itself.
pub fn effective_volume(volume: f64, area: f64, infill_pct: f64, wall_mm: f64) -> f64 {
    let volume = volume.max(0.0);
    if infill_pct >= 100.0 {
        return volume;
    }
    let shell = (area.max(0.0) * wall_mm.max(0.0)).min(volume);
    shell + (volume - shell) * infill_pct.clamp(0.0, 100.0) / 100.0
}

pub fn length_mm(volume: f64, diameter: f64) -> f64 {
    let r = diameter / 2.0;
    let section = std::f64::consts::PI * r * r;
    if section > 0.0 {
        volume / section
    } else {
        0.0
    }
}

/// Mass in grams and, per spool diameter, the filament length in metres.
pub fn estimate(volume: f64, area: f64, p: &Prefs) -> (f64, [f64; 2]) {
    let v = effective_volume(volume, area, p.infill_pct, p.wall_mm);
    let mass = v / 1000.0 * density_for(p);
    (mass, DIAMETERS.map(|d| length_mm(v, d) / 1000.0))
}

pub fn rows(volume: f64, area: f64, p: &Prefs) -> Vec<super::Row> {
    let (mass, metres) = estimate(volume, area, p);
    let s = super::spell;
    vec![
        (crate::i18n::t("properties.mass"), format!("{} g", s(mass))),
        (crate::i18n::tr!("inspect.filament", diameter = "1.75"), format!("{} m", s(metres[0]))),
        (crate::i18n::tr!("inspect.filament", diameter = "2.85"), format!("{} m", s(metres[1]))),
    ]
}
