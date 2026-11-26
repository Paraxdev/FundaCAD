//! Overhang shading, FundaCAD 1's draft analysis: which faces need support for a build direction and threshold.

use glam::Vec3;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tint {
    Overhang,
    Wall,
    Top,
}

impl Tint {
    pub fn rgb(self) -> u32 {
        match self {
            Tint::Overhang => 0xe24a3b,
            Tint::Wall => 0x4aa3e2,
            Tint::Top => 0x49c46a,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Tint::Overhang => "Needs support",
            Tint::Wall => "Prints as is",
            Tint::Top => "Faces up",
        }
    }
}

pub const DIRECTIONS: [&str; 6] = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];

pub fn direction(name: &str) -> Vec3 {
    match name {
        "-Z" => Vec3::NEG_Z,
        "+X" => Vec3::X,
        "-X" => Vec3::NEG_X,
        "+Y" => Vec3::Y,
        "-Y" => Vec3::NEG_Y,
        _ => Vec3::Z,
    }
}

/// A downward face overhangs when its angle from straight down is below `threshold` degrees.
pub fn classify(normal: Vec3, build: Vec3, threshold: f32) -> Tint {
    let c = normal.normalize_or_zero().dot(build);
    if c >= -0.02 {
        return if c > 0.02 { Tint::Top } else { Tint::Wall };
    }
    let beta = (-c).min(1.0).acos().to_degrees();
    if beta < threshold {
        Tint::Overhang
    } else {
        Tint::Wall
    }
}

/// Area in mm² that needs support, prints as is and faces up, over the triangles of `bodies`.
pub fn areas<'a>(bodies: impl IntoIterator<Item = &'a crate::viewport::scene::SceneBody>, build: Vec3, threshold: f32) -> [f64; 3] {
    let mut out = [0.0; 3];
    for b in bodies {
        for t in b.indices.chunks_exact(3) {
            let [p, q, r] = [t[0], t[1], t[2]].map(|i| b.vertices[i as usize]);
            let area = (q.position() - p.position()).cross(r.position() - p.position()).length() as f64 / 2.0;
            let slot = match classify(p.normal() + q.normal() + r.normal(), build, threshold) {
                Tint::Overhang => 0,
                Tint::Wall => 1,
                Tint::Top => 2,
            };
            out[slot] += area;
        }
    }
    out
}

pub fn rows(areas: [f64; 3]) -> Vec<super::Row> {
    [Tint::Overhang, Tint::Wall, Tint::Top].iter().zip(areas).map(|(t, a)| (t.label().into(), format!("{} mm²", super::spell(a)))).collect()
}
