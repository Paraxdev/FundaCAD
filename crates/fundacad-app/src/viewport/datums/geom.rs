//! Where each shown datum sits, from the latest build's `datumPlanes` and `datumMarks`, else the feature's own fields,
//! and which plane a ray lands on.

#[cfg(test)]
mod tests;

use glam::{DVec2, DVec3, Vec3};
use serde_json::{Map, Value};

use crate::items;
use crate::sketch::Plane;

#[derive(Clone, Debug, PartialEq)]
pub enum Mark {
    Plane { id: String, plane: Plane },
    Axis { id: String, origin: DVec3, dir: DVec3 },
    Point { id: String, at: DVec3 },
}

impl Mark {
    pub fn id(&self) -> &str {
        match self {
            Mark::Plane { id, .. } | Mark::Axis { id, .. } | Mark::Point { id, .. } => id,
        }
    }
}

fn vec3(v: Option<&Value>) -> Option<DVec3> {
    let a = v?.as_array()?;
    Some(DVec3::new(a.first()?.as_f64()?, a.get(1)?.as_f64()?, a.get(2)?.as_f64()?))
}

fn built_plane(result: &Map<String, Value>, id: &str) -> Option<Plane> {
    let r = result.get("datumPlanes")?.get(id)?;
    Plane::from_spec(r)
}

/// A datum plane before the engine built it: its reference plane moved `offset` along the normal.
fn own_plane(f: &Value) -> Option<Plane> {
    let mut p = Plane::from_spec(f.get("plane")?)?;
    p.origin += p.n * f.get("offset").and_then(Value::as_f64).unwrap_or(0.0);
    Some(p)
}

/// The visible Origin planes, then each visible datum before the rollback marker and not suppressed.
pub fn marks(doc: &Map<String, Value>, result: &Map<String, Value>) -> Vec<Mark> {
    let mut out: Vec<Mark> = ["XY", "XZ", "YZ"]
        .into_iter()
        .filter(|id| items::plane_visible(doc, id))
        .filter_map(|id| Some(Mark::Plane { id: id.into(), plane: Plane::named(id)? }))
        .collect();
    let features = doc.get("features").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let end = doc.get("rollback").and_then(Value::as_u64).map_or(features.len(), |r| (r as usize).min(features.len()));
    for f in &features[..end] {
        let Some(id) = f.get("id").and_then(Value::as_str) else { continue };
        if items::suppressed(doc, id) || !items::plane_visible(doc, id) {
            continue;
        }
        let mark = result.get("datumMarks").and_then(|m| m.get(id));
        let found = match f.get("type").and_then(Value::as_str) {
            Some("datumPlane") => built_plane(result, id).or_else(|| own_plane(f)).map(|plane| Mark::Plane { id: id.into(), plane }),
            Some("datumAxis") => {
                let origin = vec3(mark.and_then(|m| m.get("origin"))).or_else(|| vec3(f.get("origin")));
                let dir = vec3(mark.and_then(|m| m.get("dir"))).or_else(|| vec3(f.get("dir")));
                origin.zip(dir.and_then(|d| d.try_normalize())).map(|(origin, dir)| Mark::Axis { id: id.into(), origin, dir })
            }
            Some("datumPoint") => vec3(mark.and_then(|m| m.get("position")))
                .or_else(|| vec3(f.get("point")))
                .map(|at| Mark::Point { id: id.into(), at }),
            _ => None,
        };
        out.extend(found);
    }
    out
}

/// A plane's square, `half` from its origin each way, as sketch coordinates.
pub fn square(half: f64) -> [DVec2; 4] {
    [DVec2::new(-half, -half), DVec2::new(half, -half), DVec2::new(half, half), DVec2::new(-half, half)]
}

/// The plane square a ray meets first, and how far along it.
pub fn plane_under<'a>(marks: &'a [Mark], half: f64, origin: Vec3, dir: Vec3) -> Option<(&'a str, f64)> {
    marks
        .iter()
        .filter_map(|m| match m {
            Mark::Plane { id, plane } => {
                let q = plane.hit(origin, dir)?;
                let t = (plane.to_3d(q) - origin.as_dvec3()).length();
                (q.x.abs() <= half && q.y.abs() <= half).then_some((id.as_str(), t))
            }
            _ => None,
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
}
