//! Feature handlers, one module per family, each naming the Python it replaces.

pub mod axis_push;
pub mod blend;
pub(crate) mod boolean;
mod cleanup;
mod datum;
mod defeature;
mod extrude;
mod joint;
mod face_anchor;
mod hole;
pub mod import;
mod loft_sweep;
mod pattern;
mod primitives;
mod revolve;
pub mod sketch;
mod press_pull;
mod solid_ops;
mod split;
mod transform;

pub use boolean::combine;
pub use pattern::pattern_sources;

use fundacad_core::schema::Feature;

use crate::builder::{Ctx, FResult, Fail};

/// `_FEATURE_HANDLERS`, for the types this engine builds so far.
pub fn dispatch(ctx: &mut Ctx, f: &Feature) -> FResult {
    crate::bench::phase_named(f.type_name().unwrap_or("feature"), || handle(ctx, f))
}

fn handle(ctx: &mut Ctx, f: &Feature) -> FResult {
    match f {
        Feature::Box(b) => primitives::make_box(ctx, b),
        Feature::Cylinder(c) => primitives::cylinder(ctx, c),
        Feature::Sphere(s) => primitives::sphere(ctx, s),
        Feature::Cone(c) => primitives::cone(ctx, c),
        Feature::Torus(t) => primitives::torus(ctx, t),
        Feature::Move(m) => transform::move_bodies(ctx, m),
        Feature::Duplicate(m) => transform::duplicate(ctx, m),
        Feature::Scale(s) => transform::scale(ctx, s),
        Feature::Mirror(m) => transform::mirror(ctx, m),
        Feature::RemoveBody(r) => transform::remove_body(ctx, r),
        Feature::DatumPlane(d) => datum::datum_plane(ctx, d),
        Feature::DatumPoint(_) => Ok(()),
        Feature::Joint(j) => joint::handle(ctx, j),
        Feature::DatumAxis(d) => datum::datum_axis(ctx, d),
        Feature::Sketch(s) => sketch::handle(ctx, s),
        Feature::Extrude(e) => extrude::handle(ctx, e),
        Feature::Revolve(r) => revolve::handle(ctx, r),
        Feature::Boolean(b) => boolean::do_boolean(ctx, b),
        Feature::Hole(h) => hole::handle(ctx, h),
        Feature::Fillet(b) => blend::fillet(ctx, b),
        Feature::Chamfer(b) => blend::chamfer(ctx, b),
        Feature::Loft(l) => loft_sweep::loft(ctx, l),
        Feature::Sweep(s) => loft_sweep::sweep(ctx, s),
        Feature::PatternRect(p) => pattern::pattern_rect(ctx, p),
        Feature::PatternLinear(p) => pattern::pattern_linear(ctx, p),
        Feature::PatternCircular(p) => pattern::pattern_circular(ctx, p),
        Feature::Shell(s) => solid_ops::shell(ctx, s),
        Feature::Thicken(t) => solid_ops::thicken(ctx, t),
        Feature::Draft(d) => solid_ops::draft(ctx, d),
        Feature::PressPull(p) => press_pull::press_pull(ctx, p),
        Feature::OffsetFace(o) => press_pull::offset_face(ctx, o),
        Feature::DeleteFace(d) => defeature::delete_face(ctx, d),
        Feature::SimplifyMesh(s) => cleanup::simplify_mesh(ctx, s),
        Feature::CleanUp(c) => cleanup::clean_up(ctx, c),
        Feature::Split(s) => split::split(ctx, s),
        Feature::Imprint(i) => split::imprint(ctx, i),
        Feature::Import(i) => import::handle(ctx, i),
        other => Err(not_ported(other.type_name().unwrap_or("feature"))),
    }
}

/// The refusal a type without a Rust handler yet gets, which the differential
/// harness sorts apart from real failures by "not ported".
pub fn not_ported(what: &str) -> Fail {
    Fail::msg(format!("{what} is not ported to the Rust engine yet"))
}
