//! Section View and Isolate, FundaCAD 1's sectionMath.ts and isolate: a plane that keeps one side of the model, and
//! the bodies a view keeps.

use std::sync::Arc;

use glam::Vec3;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Section {
    pub normal: Vec3,
    pub offset: f32,
    pub flip: bool,
}

impl Section {
    /// A cut across `axis` (0 X, 1 Y, 2 Z) through `centre`.
    pub fn along(axis: usize, centre: Vec3) -> Self {
        let normal = Vec3::AXES[axis.min(2)];
        Self { normal, offset: centre.dot(normal), flip: false }
    }

    pub fn on_face(point: Vec3, normal: Vec3) -> Option<Self> {
        let normal = normal.try_normalize()?;
        Some(Self { normal, offset: point.dot(normal), flip: false })
    }

    /// The plane as the shader takes it: the points p with n.p <= w are kept.
    pub fn plane(&self) -> [f32; 4] {
        let s = if self.flip { -1.0 } else { 1.0 };
        let n = self.normal * s;
        [n.x, n.y, n.z, self.offset * s]
    }

    pub fn keeps(&self, p: Vec3) -> bool {
        let [x, y, z, w] = self.plane();
        Vec3::new(x, y, z).dot(p) <= w + 1e-4
    }

    pub fn axis(&self) -> &'static str {
        match Vec3::AXES.iter().position(|a| a.abs_diff_eq(self.normal, 1e-6)) {
            Some(0) => "X",
            Some(1) => "Y",
            Some(2) => "Z",
            _ => "Face",
        }
    }
}

/// A round step for nudging a plane through a model of `radius`: 1, 2 or 5 times a power of ten, near a tenth of it.
pub fn step(radius: f32) -> f32 {
    let r = (radius / 10.0).max(1e-3);
    let p = 10f32.powf(r.log10().floor());
    [1.0, 2.0, 5.0, 10.0].into_iter().map(|m| m * p).find(|s| *s >= r * 0.75).unwrap_or(10.0 * p)
}

/// The bodies Isolate keeps. Every body when it keeps none of them, so a stale list never empties the view.
pub fn isolated<B: AsRef<str>>(bodies: Vec<Arc<crate::viewport::scene::Body>>, keep: Option<&[B]>) -> Vec<Arc<crate::viewport::scene::Body>> {
    let Some(keep) = keep else { return bodies };
    let kept: Vec<_> = bodies.iter().filter(|b| keep.iter().any(|k| k.as_ref() == b.id)).cloned().collect();
    if kept.is_empty() {
        bodies
    } else {
        kept
    }
}
