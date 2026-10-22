//! Whether a body is closed solids with faces pointing outward. A boolean, volume or section of
//! anything else comes back wrong without an error, so each analysis asks here first.

use std::borrow::Cow;

use opencascade::primitives::Shape;

use crate::kernel::{self, Skin};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Soundness {
    pub skin: Skin,
    /// Solids whose faces point into their material. Counted only when the
    /// skin is clean, a mixed one has no single direction to ask about.
    pub inward: usize,
}

pub fn of(shape: &Shape) -> Soundness {
    let skin = kernel::skin(shape);
    let mut s = Soundness { skin, inward: 0 };
    if s.fault().is_none() {
        s.inward = kernel::inward_solids(shape);
    }
    s
}

fn pick<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 {
        one
    } else {
        many
    }
}

impl Soundness {
    /// Why the body has no inside to judge, worded to follow its name. None
    /// for a body that is only inside out, which `material` turns over.
    pub fn fault(&self) -> Option<String> {
        let k = &self.skin;
        if k.solids == 0 {
            return Some("is a surface, not a solid, so it has no inside".into());
        }
        let (n, why) = if k.open_edges > 0 {
            let n = k.open_edges;
            (n, format!("is not a closed solid, # {} only one face, so it has no inside", pick(n, "bounds", "bound")))
        } else if k.crowded_edges > 0 {
            let n = k.crowded_edges;
            let shared = pick(n, "is", "are");
            (n, format!("is not one clean solid, # {shared} shared by more than two faces, so it has no single inside"))
        } else if k.flipped_edges > 0 {
            let why = "has faces that point the wrong way, at # the two faces disagree about which side is inside";
            (k.flipped_edges, why.to_owned())
        } else {
            return None;
        };
        Some(why.replace('#', &format!("{n} of its edges")))
    }

    pub fn inside_out(&self) -> bool {
        self.inward > 0 && self.fault().is_none()
    }

    /// The diagnostic code of what is wrong with a solid body. None for a
    /// sound one and for a surface, which is a state to model in, not a fault.
    pub fn code(&self) -> Option<&'static str> {
        let k = &self.skin;
        if k.solids == 0 {
            None
        } else if k.open_edges > 0 {
            Some("openShell")
        } else if k.crowded_edges > 0 {
            Some("nonManifold")
        } else if k.flipped_edges > 0 {
            Some("flippedFaces")
        } else {
            (self.inward > 0).then_some("insideOut")
        }
    }
}

/// What being inside out is, worded to follow the body's name.
pub const INSIDE_OUT: &str = "is inside out, its faces point into the material";

/// The body itself when sound, a copy turned outward when inside out is all that is wrong, else
/// why it cannot be judged, worded to follow the body's name.
pub fn material(shape: &Shape) -> Result<Cow<'_, Shape>, String> {
    let s = of(shape);
    if let Some(why) = s.fault() {
        return Err(why);
    }
    if s.inward == 0 {
        return Ok(Cow::Borrowed(shape));
    }
    match kernel::turned_outward(shape) {
        Ok(turned) if kernel::inward_solids(&turned) == 0 => Ok(Cow::Owned(turned)),
        _ => Err(format!("{INSIDE_OUT}, and it could not be turned over")),
    }
}
