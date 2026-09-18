//! Loft and sweep, the Python engine's `builder.py` `_handle_loft` and `_handle_sweep`.

use fundacad_core::schema::{Loft, Sweep};

use super::{combine, sketch};
use crate::builder::{Ctx, FResult, Fail};
use crate::kernel;

pub fn loft(ctx: &mut Ctx, f: &Loft) -> FResult {
    let mut sections = Vec::new();
    match f.profiles.as_ref().filter(|p| !p.is_empty()) {
        Some(profiles) => {
            for pr in profiles {
                let entry = ctx
                    .sketches
                    .get(&pr.sketch)
                    .filter(|e| !e.faces.is_empty())
                    .ok_or_else(|| Fail::msg("a loft profile's sketch has no closed area"))?;
                let p = [pr.region[0].get(), pr.region[1].get(), pr.region[2].get()];
                let face = sketch::region_face(ctx, entry, p)
                    .ok_or_else(|| Fail::msg("no profile found under a selected loft area"))?;
                sections.push(face);
            }
        }
        None => {
            for sid in f.sketches.iter().flatten() {
                if let Some(s) = &sketch::require(ctx, sid, "loft")?.sketch {
                    sections.push(s.clone());
                }
            }
        }
    }
    if sections.len() < 2 {
        return Err(Fail::msg("loft needs at least two profiles"));
    }
    let solid = kernel::loft(&sections).map_err(|e| {
        Fail::msg(format!(
            "Loft failed to blend these profiles, they may be coincident, identical, or too dissimilar to connect. [{}]",
            e.0
        ))
    })?;
    combine(
        ctx,
        &f.id,
        solid,
        f.operation.as_ref(),
        f.targets.as_deref(),
        None,
        None,
    )
}

pub fn sweep(ctx: &mut Ctx, f: &Sweep) -> FResult {
    let Some(profile) = sketch::require(ctx, &f.profile, "sweep")?.sketch.clone() else {
        return Err(Fail::msg("sweep profile has no closed section"));
    };
    let Some(path) = sketch::require(ctx, &f.path, "sweep")?.wire.clone() else {
        return Err(Fail::msg("sweep path sketch has no curve to follow"));
    };
    let solid = kernel::sweep(&profile, &path)?;
    combine(
        ctx,
        &f.id,
        solid,
        Some(&f.operation),
        f.targets.as_deref(),
        None,
        None,
    )
}
