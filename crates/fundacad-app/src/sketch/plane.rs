//! A sketch plane as origin plus orthonormal basis, FundaCAD 1's SketchPlane: u is sketch +X, v is sketch +Y.

use glam::{DVec2, DVec3, Vec3};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    pub origin: DVec3,
    pub u: DVec3,
    pub v: DVec3,
    pub n: DVec3,
}

fn vec3(v: &Value) -> Option<DVec3> {
    let a = v.as_array()?;
    Some(DVec3::new(a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?))
}

impl Plane {
    pub fn named(name: &str) -> Option<Self> {
        let (u, v) = match name {
            "XY" => (DVec3::X, DVec3::Y),
            "XZ" => (DVec3::X, DVec3::Z),
            "YZ" => (DVec3::Y, DVec3::Z),
            _ => return None,
        };
        Some(Self { origin: DVec3::ZERO, u, v, n: u.cross(v) })
    }

    /// A sketch's `plane`: XY, XZ, YZ or `{origin, normal, xdir}`.
    pub fn from_spec(spec: &Value) -> Option<Self> {
        if let Some(name) = spec.as_str() {
            return Self::named(name);
        }
        let origin = vec3(spec.get("origin")?)?;
        let n = vec3(spec.get("normal")?)?.normalize();
        let u = vec3(spec.get("xdir")?)?.normalize();
        Some(Self { origin, u, v: n.cross(u).normalize(), n })
    }

    /// A plane on a flat face at `point`, its X along the world axis that lies flattest in it.
    pub fn on_face(point: Vec3, normal: Vec3) -> Self {
        let n = normal.as_dvec3().normalize();
        let axis = [DVec3::X, DVec3::Y, DVec3::Z]
            .into_iter()
            .min_by(|a, b| a.dot(n).abs().total_cmp(&b.dot(n).abs()))
            .unwrap_or(DVec3::X);
        let u = (axis - n * axis.dot(n)).normalize();
        let round = |v: DVec3| (v * 1e6).round() / 1e6;
        Self { origin: round(point.as_dvec3()), u, v: n.cross(u), n }
    }

    pub fn spec(&self) -> Value {
        let a = |v: DVec3| json!([v.x, v.y, v.z]);
        json!({"origin": a(self.origin), "normal": a(self.n), "xdir": a(self.u)})
    }

    pub fn to_2d(&self, p: DVec3) -> DVec2 {
        let d = p - self.origin;
        DVec2::new(d.dot(self.u), d.dot(self.v))
    }

    pub fn to_3d(&self, p: DVec2) -> DVec3 {
        self.origin + self.u * p.x + self.v * p.y
    }

    /// Where a ray meets the plane, in sketch coordinates.
    pub fn hit(&self, origin: Vec3, dir: Vec3) -> Option<DVec2> {
        let (o, d) = (origin.as_dvec3(), dir.as_dvec3());
        let den = d.dot(self.n);
        if den.abs() < 1e-9 {
            return None;
        }
        let t = (self.origin - o).dot(self.n) / den;
        (t > 0.0).then(|| self.to_2d(o + d * t))
    }
}
