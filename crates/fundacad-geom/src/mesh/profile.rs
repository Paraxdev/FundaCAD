//! Viewport tolerances. OCCT's relative deflection sizes the mesh per feature, so a 1 mm fillet meshes
//! finer than its face. The numbers were measured, re-measure before changing one.

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
            return ViewportProfile { size_scale: scale, angular };
        }
    }
    ViewportProfile { size_scale: 1.0, angular: VIEWPORT_ANG_TOL }
}

/// Relative mode sizes per feature itself, so there is no bounding box term.
pub fn effective_tolerance(requested: f64, size_scale: f64) -> f64 {
    let scale = (requested / DEFAULT_TOLERANCE) * size_scale;
    DEFAULT_RELATIVE_DEFLECTION * scale
}
