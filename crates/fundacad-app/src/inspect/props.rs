//! Properties, FundaCAD 1's bodyProperties and showProperties: volume, surface area, centre of mass and bounding box
//! of some bodies, summed off their meshes.

use glam::DVec3;

use super::{spell, spell_xyz, Row};
use crate::i18n::{t, tr};
use crate::viewport::scene::Body;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Props {
    pub volume: f64,
    pub area: f64,
    pub com: DVec3,
    pub min: DVec3,
    pub max: DVec3,
}

impl Props {
    pub fn size(&self) -> [f64; 3] {
        (self.max - self.min).to_array()
    }
}

/// None when the bodies have no triangles. The volume is signed tetrahedra from the origin, so a closed mesh with
/// outward normals gives its true volume wherever it sits.
pub fn of<'a>(bodies: impl IntoIterator<Item = &'a Body>) -> Option<Props> {
    let (mut volume, mut area, mut moment) = (0.0, 0.0, DVec3::ZERO);
    let (mut min, mut max) = (DVec3::splat(f64::INFINITY), DVec3::splat(f64::NEG_INFINITY));
    let mut any = false;
    for b in bodies {
        let at = |i: u32| {
            let i = i as usize * 3;
            DVec3::new(b.positions[i] as f64, b.positions[i + 1] as f64, b.positions[i + 2] as f64)
        };
        for t in b.indices.chunks_exact(3) {
            let (p, q, r) = (at(t[0]), at(t[1]), at(t[2]));
            any = true;
            let v = p.dot(q.cross(r)) / 6.0;
            volume += v;
            moment += (p + q + r) / 4.0 * v;
            area += (q - p).cross(r - p).length() / 2.0;
            for c in [p, q, r] {
                min = min.min(c);
                max = max.max(c);
            }
        }
    }
    let com = if volume.abs() > 1e-12 { moment / volume } else { (min + max) / 2.0 };
    any.then_some(Props { volume, area, com, min, max })
}

/// Why a body is not a sound solid, from the build's `fault`, or its mesh turned inside out.
pub fn fault(b: &Body) -> Option<String> {
    match b.fields.get("fault") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Null) | None => b.fields.get("insideOut").filter(|v| v.as_bool() == Some(true)).map(|_| "its faces point inward".into()),
        Some(other) => Some(other.to_string()),
    }
}

pub fn rows(p: &Props, solid: bool) -> Vec<Row> {
    let row = |k: &str, v: String| (k.to_string(), v);
    let mut out = Vec::new();
    if solid {
        out.push(row(&t("properties.volume"), format!("{} mm³", spell(p.volume))));
    }
    out.push(row(&t("properties.area"), format!("{} mm²", spell(p.area))));
    if solid {
        out.push(row(&t("properties.centerOfMass"), spell_xyz(p.com.to_array())));
    }
    let [w, d, h] = p.size().map(spell);
    out.push(row(&t("properties.boundingBox"), format!("{w} × {d} × {h} mm")));
    out
}

/// The card's title: the one body's name, how many are selected, or all of them.
pub fn title(selected: &[String]) -> String {
    match selected {
        [] => t("properties.allBodies"),
        [one] => one.clone(),
        many => tr!("properties.bodies", n = many.len()),
    }
}
