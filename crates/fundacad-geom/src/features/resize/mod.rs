//! A cylinder, cone, sphere or torus face resized about its own axis or
//! centre, the faces around it keeping their own surfaces and trimmed or
//! extended to meet it. Faces running smoothly into it that the new size
//! would leave behind either follow it, when they close into one loop along
//! its axis, or the resize is refused.

mod band;
mod cells;
mod check;
mod memo;
mod neighbours;
mod run;
mod surface;

use glam::DVec3;
use opencascade::primitives::Shape;

use self::neighbours::{first_contact, left_behind, neighbours, same_surface, tangent_run, EdgeKind};
use self::surface::{concave, faces_at, inner_point, surf, Surf};
use crate::builder::Fail;
use crate::topo::FaceAdjacency;

pub enum Resize {
    Built(Shape),
    /// A size the user asked for that has no valid result, with the reason.
    Refused(Fail),
    /// The kernel could not build it.
    Failed,
}

#[doc(hidden)]
pub enum Bad {
    Refused(Fail),
    Failed,
}

impl From<Result<Shape, Bad>> for Resize {
    fn from(r: Result<Shape, Bad>) -> Resize {
        match r {
            Ok(s) => Resize::Built(s),
            Err(Bad::Refused(f)) => Resize::Refused(f),
            Err(Bad::Failed) => Resize::Failed,
        }
    }
}

#[doc(hidden)]
pub use check::checked_solid;

/// `faces` moved `d` along their outward normal, so a positive `d` adds
/// material. `faces` is one analytic curved face (its siblings on the same
/// surface move with it), or a whole closed tangent run such as every face of
/// a slot. `follow` lets the faces that run smoothly into a lone face follow
/// it where the new size would leave them behind.
pub fn resize(part: &Shape, faces: &[Shape], d: f64, follow: bool) -> Resize {
    crate::bench::phase("resize", || resize_in(part, faces, d, follow))
}

fn resize_in(part: &Shape, faces: &[Shape], d: f64, follow: bool) -> Resize {
    let Some(first) = faces.first() else { return Resize::Failed };
    if d.abs() < 1e-9 {
        return Resize::Built(part.clone());
    }
    let memo::Around { group, nbs } = memo::around(part, first);
    if !faces.iter().all(|f| group.iter().any(|x| x.is_same(f))) {
        return whole_run(part, &FaceAdjacency::new(part), faces, d);
    }
    let s = surf(first);
    if !s.analytic_curved() {
        return Resize::Failed;
    }
    let Some(cave) = concave(first, &s) else { return Resize::Failed };
    let delta = if cave { -d } else { d };
    let cut = d < 0.0;
    if let Some(f) = refusal::size_guard(&s, delta) {
        return Resize::Refused(f);
    }
    let lost = left_behind(&s, &nbs, delta);
    if lost.is_empty() {
        return cells::cells(part, &group, &s, &nbs, delta, cut).into();
    }
    if !follow {
        return Resize::Refused(refusal::tangent_lost(&lost, delta));
    }
    let contacts = lost.iter().map(|l| l.contact);
    let contact = if delta < 0.0 { contacts.fold(f64::NEG_INFINITY, f64::max) } else { contacts.fold(f64::INFINITY, f64::min) };
    let unsupported = || Resize::Refused(refusal::run_unsupported(contact, delta));
    if !matches!(s, Surf::Cyl { .. }) {
        return unsupported();
    }
    let reach = contact - s.size();
    let (mid, mid_group) = if reach.abs() < 1e-9 {
        (part.clone(), group)
    } else {
        let mid = match cells::cells(part, &group, &s, &nbs, reach, cut) {
            Ok(m) => m,
            Err(e) => return Resize::from(Err(e)),
        };
        let g = faces_at(&mid, &s, reach);
        if g.is_empty() {
            return Resize::Failed;
        }
        (mid, g)
    };
    let run = tangent_run(&FaceAdjacency::new(&mid), &mid_group);
    match run::run_offset(&mid, &run, &mid_group[0], s.size() + delta - contact, cut) {
        Some(r) => r.into(),
        None => unsupported(),
    }
}

/// Every face of one closed tangent run, resized once.
fn whole_run(part: &Shape, adj: &FaceAdjacency, faces: &[Shape], d: f64) -> Resize {
    let Some(main) = faces.iter().find(|f| matches!(surf(f), Surf::Cyl { .. })) else { return Resize::Failed };
    let run = tangent_run(adj, std::slice::from_ref(main));
    let same = run.len() == faces.len() && run.iter().all(|r| faces.iter().any(|f| f.is_same(r)));
    if !same {
        return Resize::Failed;
    }
    let s = surf(main);
    let Some(cave) = concave(main, &s) else { return Resize::Failed };
    let delta = if cave { -d } else { d };
    if let Some(f) = refusal::size_guard(&s, delta) {
        return Resize::Refused(f);
    }
    run::run_offset(part, &run, main, delta, d < 0.0).map_or(Resize::Failed, Resize::from)
}

/// The resize of `face` with no left behind rule: the band split along every
/// neighbour that is not tangent. Only for checking the guards.
#[doc(hidden)]
pub fn plain_cells(part: &Shape, face: &Shape, d: f64) -> Resize {
    let adj = FaceAdjacency::new(part);
    let s = surf(face);
    let Some(cave) = concave(face, &s) else { return Resize::Failed };
    let delta = if cave { -d } else { d };
    let group = same_surface(&adj, face);
    let nbs: Vec<_> = neighbours(&adj, &group).into_iter().filter(|n| n.kind != Some(EdgeKind::Tangent)).collect();
    cells::cells(part, &group, &s, &nbs, delta, d < 0.0).into()
}

/// A face meets another one tangentially, so a kernel offset of it alone
/// would drag that one along or leave a step.
pub fn has_tangent_neighbour(part: &Shape, face: &Shape) -> bool {
    memo::around(part, face).nbs.iter().any(|n| n.kind == Some(EdgeKind::Tangent))
}

pub fn resize_invalid() -> Fail {
    refusal::coded(refusal::RESIZE_INVALID, "can't change this face to that size, the result wouldn't be a valid solid".into())
}

#[derive(Debug, Clone, PartialEq)]
pub struct TangentInfo {
    /// How many faces run smoothly into it.
    pub faces: usize,
    /// "shrink" or "grow", whichever would leave a neighbour behind.
    pub lost_when: Option<&'static str>,
    /// A point inside each face of its tangent run, itself included.
    pub run: Vec<DVec3>,
    /// The run closes into one loop of planes and cylinders along its axis.
    pub closed: bool,
    /// Tangent faces can follow a resize that would leave them behind.
    pub followable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResizeInfo {
    /// "cylinder", "cone", "sphere" or "torus".
    pub kind: &'static str,
    /// The radius, the tube radius, or 0 for a cone.
    pub size: f64,
    /// The face goes all the way round its axis.
    pub full: bool,
    pub concave: bool,
    /// (a point on it, unit direction).
    pub axis: Option<(DVec3, DVec3)>,
    pub centre: Option<DVec3>,
    /// The size where a neighbour would first be left behind.
    pub contact: Option<f64>,
    pub tangent: TangentInfo,
}

/// What a resize of `face` works with, for the tool that drives it.
pub fn describe(part: &Shape, face: &Shape) -> Option<ResizeInfo> {
    let s = surf(face);
    let kind = match s {
        Surf::Cyl { .. } => "cylinder",
        Surf::Cone { .. } => "cone",
        Surf::Sphere { .. } => "sphere",
        Surf::Torus { .. } => "torus",
        _ => return None,
    };
    let cave = concave(face, &s)?;
    let memo::Around { group, nbs } = memo::around(part, face);
    let sweep: f64 = group
        .iter()
        .filter_map(|f| f.as_face()?.uv_bounds().ok())
        .map(|b| b.u_max - b.u_min)
        .sum();
    let full = matches!(s, Surf::Cyl { .. } | Surf::Cone { .. } | Surf::Torus { .. }) && sweep >= std::f64::consts::TAU - 1e-6;
    let tangents: Vec<_> = nbs.iter().filter(|n| n.kind == Some(EdgeKind::Tangent)).collect();
    let lost_when = [(-1e-3, "shrink"), (1e-3, "grow")]
        .into_iter()
        .find(|(d, _)| tangents.iter().any(|t| !left_behind(&s, std::slice::from_ref(*t), *d).is_empty()))
        .map(|(_, w)| w);
    let run = if tangents.is_empty() { group.clone() } else { tangent_run(&FaceAdjacency::new(part), &group) };
    let closed = !tangents.is_empty() && run::closed(part, &run, face);
    Some(ResizeInfo {
        kind,
        size: s.size(),
        full,
        concave: cave,
        axis: s.axis(),
        centre: match s {
            Surf::Sphere { c, .. } => Some(c),
            _ => None,
        },
        contact: first_contact(&s, &nbs).map(|(c, _)| c),
        tangent: TangentInfo {
            faces: tangents.len(),
            lost_when,
            run: run.iter().filter_map(|f| inner_point(f).map(|(p, _)| p)).collect(),
            closed,
            followable: closed && kind == "cylinder",
        },
    })
}

mod refusal {
    use super::neighbours::Lost;
    use super::surface::{surf, Surf};
    use crate::builder::Fail;

    pub const TANGENT_LOST: &str = "tangentLost";
    pub const RUN_UNSUPPORTED: &str = "runUnsupported";
    pub const SIZE_AT_ZERO: &str = "sizeAtZero";
    pub const TUBE_TOO_WIDE: &str = "tubeTooWide";
    pub const CUTS_APART: &str = "cutsApart";
    pub const FACE_VANISHES: &str = "faceVanishes";
    pub const STEP_LEFT: &str = "stepLeft";
    pub const RESIZE_INVALID: &str = "resizeInvalid";

    pub fn coded(code: &'static str, message: String) -> Fail {
        Fail::Value { message, code: Some(code) }
    }

    fn word(s: &Surf) -> &'static str {
        match s {
            Surf::Plane { .. } => "flat",
            Surf::Cyl { .. } => "round",
            Surf::Sphere { .. } => "ball",
            _ => "curved",
        }
    }

    pub fn tangent_lost(lost: &[Lost], delta: f64) -> Fail {
        let words: Vec<&str> = lost.iter().map(|l| word(&surf(&l.face))).collect();
        let n = words.len();
        let what = match words.first() {
            Some(w) if n == 1 => format!("the {w} face that runs smoothly into it"),
            Some(w) if words.iter().all(|x| x == w) => format!("the {n} {w} faces that run smoothly into it"),
            _ => format!("the {n} faces that run smoothly into it"),
        };
        let size = if delta < 0.0 { "smaller" } else { "bigger" };
        let them = if n == 1 { "that face" } else { "them" };
        coded(
            TANGENT_LOST,
            format!("can't make this face {size} on its own, {what} would no longer meet it. Turn on Tangent faces follow to move {them} with it"),
        )
    }

    pub fn run_unsupported(contact: f64, delta: f64) -> Fail {
        let most = if delta < 0.0 { "smallest" } else { "largest" };
        coded(
            RUN_UNSUPPORTED,
            format!("the faces that run smoothly into this one can't follow it here, they don't close into one loop along its axis. The {most} it goes on its own is R{contact:.2}"),
        )
    }

    /// The new size, refused before any boolean when it cannot exist.
    pub fn size_guard(s: &Surf, delta: f64) -> Option<Fail> {
        match *s {
            Surf::Cyl { r, .. } | Surf::Sphere { r, .. } if r + delta <= 1e-6 => Some(size_at_zero(s)),
            Surf::Torus { small, .. } if small + delta <= 1e-6 => Some(size_at_zero(s)),
            Surf::Torus { big, small, .. } if small + delta >= big => {
                Some(coded(TUBE_TOO_WIDE, "the tube can't be wider than its ring".into()))
            }
            _ => None,
        }
    }

    pub fn size_at_zero(s: &Surf) -> Fail {
        match *s {
            Surf::Torus { .. } => coded(SIZE_AT_ZERO, "the tube radius has to stay above zero".into()),
            Surf::Cone { .. } => face_vanishes(),
            _ => coded(
                SIZE_AT_ZERO,
                format!("the radius has to stay above zero, this face can shrink by at most {:.2} mm", s.size()),
            ),
        }
    }

    pub fn cuts_apart(cone: bool) -> Fail {
        let what = if cone { "offset" } else { "radius" };
        coded(CUTS_APART, format!("that size cuts the body apart, try a smaller {what}"))
    }

    pub fn face_vanishes() -> Fail {
        coded(FACE_VANISHES, "at that size the face disappears".into())
    }

    pub fn step_left() -> Fail {
        coded(STEP_LEFT, "that size would leave a step in the face".into())
    }
}
