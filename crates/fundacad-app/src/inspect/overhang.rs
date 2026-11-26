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
