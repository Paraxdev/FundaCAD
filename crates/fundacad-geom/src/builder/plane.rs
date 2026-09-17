//! What a document means when it names a plane, sidecar/plane_spec.py.

use fundacad_core::schema::{PlaneDef, PlaneSpec, Real};
use indexmap::IndexMap;
use serde::Serialize;

use super::{FResult, Fail};
use crate::kernel::Frame;

/// A registered datum plane, the `{origin, xdir, normal}` the result reports.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PlaneRecord {
    pub origin: [f64; 3],
    pub xdir: [f64; 3],
    pub normal: [f64; 3],
}

/// A plane reference: a base plane or datum id, or a baked placement.
pub enum PlaneRef<'a> {
    Name(&'a str),
    Def(&'a PlaneDef),
    Record(PlaneRecord),
}

impl<'a> From<&'a PlaneSpec> for PlaneRef<'a> {
    fn from(spec: &'a PlaneSpec) -> Self {
        match spec {
            PlaneSpec::Named(n) => PlaneRef::Name(n.as_str()),
            PlaneSpec::Def(d) => PlaneRef::Def(d),
        }
    }
}

fn v3(v: &[Real; 3]) -> [f64; 3] {
    [v[0].get(), v[1].get(), v[2].get()]
}

pub fn named(name: &str) -> Option<Frame> {
    let (x, z) = match name {
        "XY" => ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        "XZ" => ([1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
        "YZ" => ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        _ => return None,
    };
    Some(Frame::new([0.0; 3], x, z))
}

/// `_plane_of`: base plane id, datum id (looked up first), or placement.
pub fn plane_of(spec: PlaneRef<'_>, datums: &IndexMap<String, PlaneRecord>) -> FResult<Frame> {
    match spec {
        PlaneRef::Name(s) => {
            if let Some(rec) = datums.get(s) {
                return frame_of(rec.origin, rec.xdir, rec.normal);
            }
            named(s).ok_or_else(|| Fail::msg(format!("unknown plane reference: {s}")))
        }
        PlaneRef::Def(d) => frame_of(v3(&d.origin), v3(&d.xdir), v3(&d.normal)),
        PlaneRef::Record(r) => frame_of(r.origin, r.xdir, r.normal),
    }
}

fn len(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// build123d `Plane(origin, x_dir, z_dir)`, with its refusals.
fn frame_of(origin: [f64; 3], xdir: [f64; 3], normal: [f64; 3]) -> FResult<Frame> {
    if len(normal) == 0.0 {
        return Err(Fail::msg("z_dir must be non null"));
    }
    if len(xdir) == 0.0 {
        return Err(Fail::msg("x_dir must be non null"));
    }
    let n = len(normal);
    let x = len(xdir);
    let nz = [normal[0] / n, normal[1] / n, normal[2] / n];
    let nx = [xdir[0] / x, xdir[1] / x, xdir[2] / x];
    let cross = [
        nz[1] * nx[2] - nz[2] * nx[1],
        nz[2] * nx[0] - nz[0] * nx[2],
        nz[0] * nx[1] - nz[1] * nx[0],
    ];
    if len(cross) < 1e-12 {
        return Err(Fail::Internal("Standard_ConstructionError".into()));
    }
    Ok(Frame::new(origin, nx, nz))
}
