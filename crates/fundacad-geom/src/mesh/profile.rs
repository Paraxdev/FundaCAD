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

/// `(faces at or above, linear scale, angular)`: where one body of that many
/// faces starts meshing, a guess that spares the 89,776 face Aventador STEP a
/// 379 MiB full quality pass. `fit` corrects it from the real payload.
pub const VIEWPORT_FACE_TIERS: [(usize, f64, f64); 2] = [(50_000, 8.0, 0.5), (20_000, 4.0, 0.35)];

/// `(linear scale, angular, the most one step finer grows the payload)`,
/// coarsest last. On three slices of the Aventador STEP scale 4 to full grew
/// up to 6x, 8 to 4 up to 1.6x and 16 to 8 up to 1.3x (`probe_mesh.log`).
pub const VIEWPORT_FIT_RUNGS: [(f64, f64, f64); 3] = [(4.0, 0.35, 8.0), (8.0, 0.5, 2.0), (16.0, 0.6, 1.5)];

/// Wire bytes one body may take, the frame cap less room for its header.
pub const SINGLE_BODY_BUDGET: usize = fundacad_protocol::MAX_FRAME / 8 * 7;

/// Meshes one body of `faces` faces with `mesh(profile, clean)`, which answers
/// the payload and its wire size. It starts on the face tier, steps coarser
/// while the payload is past `budget` and finer while the step surely fits,
/// never finer than `reply`. When no rung fits it keeps the coarsest, so the
/// frame cap still names the body.
pub fn fit<T>(
    reply: ViewportProfile,
    faces: usize,
    budget: usize,
    stopped: &dyn Fn() -> bool,
    mut mesh: impl FnMut(ViewportProfile, bool) -> (T, usize),
) -> T {
    let mut rungs = vec![(reply, 1.0)];
    for &(size_scale, angular, grows) in &VIEWPORT_FIT_RUNGS {
        if size_scale > reply.size_scale {
            rungs.push((ViewportProfile { size_scale, angular: angular.max(reply.angular) }, grows));
        }
    }
    let guess = reply.for_faces(faces);
    let start = rungs.iter().position(|r| r.0 == guess).unwrap_or(0);
    let mut at = start;
    let mut made = mesh(rungs[at].0, false);
    while made.1 > budget && at + 1 < rungs.len() && !stopped() {
        at += 1;
        drop(made);
        made = mesh(rungs[at].0, true);
    }
    let climb = at == start;
    while climb && at > 0 && made.1 as f64 * rungs[at].1 <= budget as f64 && !stopped() {
        let finer = mesh(rungs[at - 1].0, true);
        if finer.1 > budget {
            break;
        }
        made = finer;
        at -= 1;
    }
    made.0
}

/// How one reply's bodies are meshed, the same for every body in it but one
/// past a face tier.
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

    /// The profile of one body of `faces` faces, never finer than the reply's.
    pub fn for_faces(self, faces: usize) -> ViewportProfile {
        match VIEWPORT_FACE_TIERS.iter().find(|t| faces >= t.0) {
            Some(&(_, size_scale, angular)) if size_scale > self.size_scale => {
                ViewportProfile { size_scale, angular: angular.max(self.angular) }
            }
            _ => self,
        }
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
