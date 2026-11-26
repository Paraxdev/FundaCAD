//! The closed areas of finished sketches as the view draws them and a click finds them, FundaCAD 1's regionUnder.

#[cfg(test)]
mod tests;

use glam::{DVec2, DVec3, Vec3};
use serde_json::{Map, Value};

use super::{regions, Editor, Plane};

#[derive(Clone, Debug, PartialEq)]
pub struct Area {
    pub sketch: String,
    pub plane: Plane,
    pub outline: Vec<DVec2>,
    pub holes: Vec<Vec<DVec2>>,
    /// The world point a feature stores for it, inside it and clear of its holes.
    pub point: [f64; 3],
}

impl Area {
    pub fn contains(&self, p: DVec2) -> bool {
        regions::contains(&self.outline, p) && !self.holes.iter().any(|h| regions::contains(h, p))
    }

    /// Whether the world point `p` of `sketch` lies in this area.
    pub fn holds(&self, sketch: &str, p: [f64; 3]) -> bool {
        let w = DVec3::from(p);
        sketch == self.sketch && (w - self.plane.origin).dot(self.plane.n).abs() < 1e-3 && self.contains(self.plane.to_2d(w))
    }
}

/// A finished sketch as the view shows it: its strokes and its areas.
#[derive(Clone, Debug, PartialEq)]
pub struct Shown {
    pub sketch: String,
    pub plane: Plane,
    pub lines: Vec<Vec<DVec2>>,
    pub areas: Vec<Area>,
}

/// Each outline nested in an even number of others is an area, the outlines directly inside it its holes.
pub fn of_outlines(sketch: &str, plane: Plane, outlines: &[Vec<DVec2>]) -> Vec<Area> {
    let within = |a: &[DVec2], b: &[DVec2]| !std::ptr::eq(a, b) && a.iter().all(|p| regions::contains(b, *p));
    let depth = |o: &[DVec2]| outlines.iter().filter(|b| within(o, b)).count();
    let mut out = Vec::new();
    for o in outlines {
        let d = depth(o);
        if d % 2 == 1 {
            continue;
        }
        let holes: Vec<Vec<DVec2>> = outlines.iter().filter(|k| within(k, o) && depth(k) == d + 1).cloned().collect();
        let refs: Vec<&Vec<DVec2>> = holes.iter().collect();
        let Some(inner) = regions::inside(o, &refs) else { continue };
        let w = plane.to_3d(inner);
        let point = [w.x, w.y, w.z].map(|c| (c * 1e4).round() / 1e4 + 0.0);
        out.push(Area { sketch: sketch.to_string(), plane, outline: o.clone(), holes, point });
    }
    out
}

/// The sketches before the rollback marker and not suppressed, the hidden ones too when `all`, `open` left out.
pub fn shown(doc: &Map<String, Value>, all: bool, open: Option<&str>) -> Vec<Shown> {
    let features = doc.get("features").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let end = doc.get("rollback").and_then(Value::as_u64).map_or(features.len(), |r| (r as usize).min(features.len()));
    features[..end]
        .iter()
        .filter(|f| f.get("type").and_then(Value::as_str) == Some("sketch"))
        .filter_map(|f| f.get("id").and_then(Value::as_str))
        .filter(|id| Some(*id) != open && !crate::items::suppressed(doc, id))
        .filter(|id| all || crate::items::sketch_visible(doc, id))
        .filter_map(|id| Editor::open(doc, id))
        .map(|e| {
            let lines = e
                .solved
                .entities
                .iter()
                .filter(|x| !e.is_construction(x.id()))
                .filter_map(|x| {
                    regions::path(x).or_else(|| {
                        let mut ring = regions::outline(x)?;
                        ring.extend(ring.first().copied());
                        Some(ring)
                    })
                })
                .chain(e.polygons().into_iter().map(|(_, mut p)| {
                    p.extend(p.first().copied());
                    p
                }))
                .collect();
            let areas = of_outlines(&e.feature, e.plane, &e.regions());
            Shown { sketch: e.feature.clone(), plane: e.plane, lines, areas }
        })
        .collect()
}

/// The area a ray from `origin` along `dir` meets first.
pub fn under<'a>(areas: impl IntoIterator<Item = &'a Area>, origin: Vec3, dir: Vec3) -> Option<&'a Area> {
    areas
        .into_iter()
        .filter_map(|a| {
            let q = a.plane.hit(origin, dir)?;
            a.contains(q).then(|| ((a.plane.to_3d(q) - origin.as_dvec3()).length(), a))
        })
        .min_by(|x, y| x.0.total_cmp(&y.0))
        .map(|(_, a)| a)
}
