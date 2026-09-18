//! Viewport tolerances, replaces the tolerance half of the Python engine's `viewport_mesh.py`
//! (`_viewport_profile`, `_effective_tolerance`).
//!
//! The viewport meshes with OCCT's relative deflection, a fraction of each
//! feature's own size, so a 1 mm fillet gets a finer mesh than the face it sits
//! on. The numbers were measured in the Python engine; re-measure before changing one.

/// The wire default tolerance, what the size scaling is relative to.
pub const DEFAULT_TOLERANCE: f64 = 0.1;

/// Relative linear deflection at the wire default.
pub const DEFAULT_RELATIVE_DEFLECTION: f64 = 0.002;

/// Angular deflection at shipping quality, radians. 0.18 sits just past the
/// point where a 1 mm fillet stops banding.
pub const VIEWPORT_ANG_TOL: f64 = 0.18;

/// Triangle budget of one displaced face in the viewport, for mesh passes.
pub const VIEWPORT_DENSITY_CAP: usize = 80_000;

/// `(bodies at or above, linear scale, angular)`: a large document is meshed
/// coarser so its reply fits the frame cap.
pub const VIEWPORT_SIZE_TIERS: [(usize, f64, f64); 2] = [(2200, 4.0, 0.35), (1200, 2.0, 0.26)];

/// How one reply's bodies are meshed, the same for every body in it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewportProfile {
    /// Multiplies the linear deflection; 1.0 is shipping quality.
    pub size_scale: f64,
    pub angular: f64,
}

impl Default for ViewportProfile {
    fn default() -> Self {
        viewport_profile(0)
    }
}

impl ViewportProfile {
    /// True surface normals and the seam weld ride only the full quality
    /// payload; the coarse tiers exist to fit the frame cap.
    pub fn display_normals(&self) -> bool {
        self.size_scale == 1.0
    }
}

pub fn viewport_profile(n_bodies: usize) -> ViewportProfile {
    for (threshold, scale, angular) in VIEWPORT_SIZE_TIERS {
        if n_bodies >= threshold {
            return ViewportProfile {
                size_scale: scale,
                angular,
            };
        }
    }
    ViewportProfile {
        size_scale: 1.0,
        angular: VIEWPORT_ANG_TOL,
    }
}

/// The relative deflection BRepMesh gets for a requested wire tolerance.
/// Relative mode sizes per feature itself, so no bounding box term. The
/// Python engine's absolute mode is switched off there and not ported.
pub fn effective_tolerance(requested: f64, size_scale: f64) -> f64 {
    let scale = (requested / DEFAULT_TOLERANCE) * size_scale;
    DEFAULT_RELATIVE_DEFLECTION * scale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers_follow_the_body_count() {
        assert_eq!(viewport_profile(1).size_scale, 1.0);
        assert_eq!(viewport_profile(1).angular, 0.18);
        assert_eq!(viewport_profile(1199).size_scale, 1.0);
        assert_eq!(viewport_profile(1200).size_scale, 2.0);
        assert_eq!(viewport_profile(1200).angular, 0.26);
        assert_eq!(viewport_profile(2200).size_scale, 4.0);
        assert_eq!(viewport_profile(5000).angular, 0.35);
        assert!(viewport_profile(1).display_normals());
        assert!(!viewport_profile(1200).display_normals());
    }

    #[test]
    fn effective_tolerance_scales_the_default() {
        assert_eq!(effective_tolerance(0.1, 1.0), 0.002);
        assert!((effective_tolerance(0.05, 1.0) - 0.001).abs() < 1e-15);
        assert!((effective_tolerance(0.1, 4.0) - 0.008).abs() < 1e-15);
    }
}
