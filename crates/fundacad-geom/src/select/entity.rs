//! Edges and faces measured once, with the fingerprint readings, keys and costs
//! of sidecar/geom_select.py.

use std::cmp::Ordering;

use glam::DVec3;
use opencascade::primitives::Shape;
use opencascade::select_access::{self as sa, CurveType, ItemKind, SurfaceType};
use serde_json::{Map, Value};

use super::tuning::Tuning;
use crate::builder::{FResult, Fail};

/// Python `round(x, digits)`, correctly rounded, ties to even.
pub fn py_round(x: f64, digits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{x:.digits$}").parse().unwrap_or(x)
}

pub type Key = [f64; 4];

/// Python tuple order over a rounded key.
pub fn key_cmp(a: &Key, b: &Key) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        match x.partial_cmp(y) {
            Some(Ordering::Equal) | None => {}
            Some(o) => return o,
        }
    }
    Ordering::Equal
}

/// A key usable in a hash map, with -0.0 and 0.0 equal as in a Python dict.
pub fn key_bits(k: &Key) -> [u64; 4] {
    k.map(|v| (v + 0.0).to_bits())
}

pub fn unit(v: DVec3) -> DVec3 {
    let n = v.length();
    if n > 1e-12 {
        v / n
    } else {
        v
    }
}

pub fn sign_normalize(d: DVec3) -> DVec3 {
    for c in [d.x, d.y, d.z] {
        if c.abs() > 1e-9 {
            return if c > 0.0 { d } else { -d };
        }
    }
    d
}

pub fn rel_err(a: f64, b: f64) -> f64 {
    let d = a.abs().max(b.abs()).max(1e-9);
    (a - b).abs() / d
}

pub fn internal() -> Fail {
    Fail::Internal("Standard_Failure".into())
}

fn v(p: [f64; 3]) -> DVec3 {
    DVec3::from_array(p)
}

/// A JSON value as Python truth-tests it.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// A number as Python reads it, bools included.
pub fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        other => other.as_f64(),
    }
}

/// build123d `Vector(*seq)`: missing trailing components are zero.
pub fn vector(v: &Value) -> FResult<DVec3> {
    let Value::Array(items) = v else {
        return Err(Fail::Internal("TypeError".into()));
    };
    if items.len() > 3 {
        return Err(Fail::Internal("TypeError".into()));
    }
    let mut out = [0.0; 3];
    for (slot, item) in out.iter_mut().zip(items) {
        *slot = num(item).ok_or_else(|| Fail::Internal("TypeError".into()))?;
    }
    Ok(DVec3::from_array(out))
}

/// `sel[key]`, a KeyError when absent.
pub fn need<'a>(m: &'a Map<String, Value>, key: &str) -> FResult<&'a Value> {
    m.get(key).ok_or_else(|| Fail::Missing(key.to_owned()))
}

pub struct EdgeEnt {
    pub shape: Shape,
    pub mid: DVec3,
    tangent: Option<DVec3>,
    pub ends: Option<(DVec3, DVec3)>,
    pub length: f64,
    pub curve: CurveType,
    circle: Option<(f64, DVec3)>,
}

impl EdgeEnt {
    pub fn new(shape: Shape) -> FResult<EdgeEnt> {
        let p = sa::edge_probe(&shape).ok_or_else(internal)?;
        Ok(EdgeEnt {
            mid: p.mid.map(v).ok_or_else(internal)?,
            length: p.length.ok_or_else(internal)?,
            tangent: p.tangent.map(v),
            ends: p.ends.map(|(a, b)| (v(a), v(b))),
            curve: p.curve,
            circle: p.circle.map(|(r, c)| (r, v(c))),
            shape,
        })
    }

    pub fn curve_name(&self) -> &'static str {
        self.curve.name()
    }

    /// `_edge_dir`: the unit tangent at the middle, else the chord, sign-normalized.
    pub fn dir(&self) -> DVec3 {
        match (self.tangent, self.ends) {
            (Some(t), _) => sign_normalize(unit(t)),
            (None, Some((a, b))) => sign_normalize(unit(b - a)),
            (None, None) => DVec3::ZERO,
        }
    }

    pub fn radius(&self) -> Option<f64> {
        self.circle.map(|c| c.0)
    }

    pub fn centre(&self) -> Option<DVec3> {
        self.circle.map(|c| c.1)
    }

    /// `tangent_at(position)`, sign-normalized, `None` where it raises.
    pub fn tangent_at(&self, position: f64) -> Option<DVec3> {
        sa::edge_tangent(&self.shape, position).map(|t| sign_normalize(unit(v(t))))
    }

    pub fn canonical_key(&self) -> Key {
        let m = self.mid;
        [m.x, m.y, m.z, self.length].map(|x| py_round(x, 3))
    }

    pub fn dedup_key(&self) -> Key {
        let m = self.mid;
        [m.x, m.y, m.z, self.length].map(|x| py_round(x, 4))
    }

    pub fn describe(&self) -> String {
        let c = self.mid;
        format!(
            "an edge at ({:.2},{:.2},{:.2}) length {:.1}",
            c.x, c.y, c.z, self.length
        )
    }
}

pub fn edges_of(shape: &Shape) -> FResult<Vec<EdgeEnt>> {
    sa::items(shape, ItemKind::Edge)
        .into_iter()
        .map(EdgeEnt::new)
        .collect()
}

pub struct FaceEnt {
    pub shape: Shape,
    centre: Option<DVec3>,
    normal: Option<DVec3>,
    pub area: f64,
    pub surface: SurfaceType,
    pub radius: Option<f64>,
}

impl FaceEnt {
    pub fn new(shape: Shape) -> FResult<FaceEnt> {
        let p = sa::face_probe(&shape).ok_or_else(internal)?;
        Ok(FaceEnt {
            centre: p.centre.map(v),
            normal: p.normal.map(v),
            area: p.area.ok_or_else(internal)?,
            surface: p.surface,
            radius: p.radius,
            shape,
        })
    }

    pub fn surface_name(&self) -> &'static str {
        self.surface.name()
    }

    /// `_face_centroid`, the origin where `center()` raises.
    pub fn centroid(&self) -> DVec3 {
        self.centre.unwrap_or(DVec3::ZERO)
    }

    /// `_face_normal`, zero where `normal_at()` raises.
    pub fn normal(&self) -> DVec3 {
        self.normal.map_or(DVec3::ZERO, unit)
    }

    pub fn canonical_key(&self) -> Key {
        let c = self.centroid();
        [c.x, c.y, c.z, self.area].map(|x| py_round(x, 3))
    }

    pub fn dedup_key(&self) -> Key {
        let c = self.centroid();
        [c.x, c.y, c.z, self.area].map(|x| py_round(x, 4))
    }

    pub fn describe(&self) -> FResult<String> {
        let c = self.centre.ok_or_else(internal)?;
        Ok(format!(
            "a face at ({:.2},{:.2},{:.2}) area {:.1}",
            c.x, c.y, c.z, self.area
        ))
    }

    /// `f.distance_to_with_closest_points(p)`, `None` where it raises.
    pub fn distance(&self, p: DVec3) -> Option<(f64, DVec3)> {
        sa::distance_to_point(&self.shape, p.to_array()).map(|(d, q)| (d, v(q)))
    }

    pub fn edges(&self) -> FResult<Vec<EdgeEnt>> {
        edges_of(&self.shape)
    }
}

pub fn faces_of(shape: &Shape) -> FResult<Vec<FaceEnt>> {
    sa::items(shape, ItemKind::Face)
        .into_iter()
        .map(FaceEnt::new)
        .collect()
}

/// `_circle_center_groups`: (rank, group size) per edge, circles only.
pub fn circle_groups(edges: &[EdgeEnt], tol: f64) -> Vec<Option<(usize, usize)>> {
    let circles: Vec<(usize, DVec3, f64)> = edges
        .iter()
        .enumerate()
        .filter(|(_, e)| e.curve == CurveType::Circle)
        .filter_map(|(i, e)| Some((i, e.centre()?, e.radius()?)))
        .collect();
    let mut out = vec![None; edges.len()];
    for &(i, c, r) in &circles {
        let sibs: Vec<f64> = circles
            .iter()
            .filter(|(_, cc, _)| (*cc - c).length() < tol)
            .map(|s| s.2)
            .collect();
        let rank = sibs.iter().filter(|&&rr| rr < r - 1e-9).count();
        out[i] = Some((rank, sibs.len()));
    }
    out
}

fn fp_vec(fp: &Map<String, Value>, key: &str) -> FResult<Option<DVec3>> {
    fp.get(key).map(vector).transpose()
}

fn fp_num(fp: &Map<String, Value>, key: &str) -> FResult<Option<f64>> {
    fp.get(key)
        .map(|x| num(x).ok_or_else(|| Fail::Internal("TypeError".into())))
        .transpose()
}

/// `fp.get(key) and entity_type != fp[key]`.
fn type_differs(fp: &Map<String, Value>, key: &str, name: &str) -> bool {
    truthy(fp.get(key)) && fp.get(key).and_then(Value::as_str) != Some(name)
}

/// `_edge_cost`, lower is better.
pub fn edge_cost(
    t: &Tuning,
    e: &EdgeEnt,
    fp: &Map<String, Value>,
    tol_pos: f64,
    rank: Option<(usize, usize)>,
) -> FResult<f64> {
    let is_circle = e.curve == CurveType::Circle;
    let group = fp_num(fp, "radius_group")?.unwrap_or(1.0);
    if is_circle && group >= 2.0 && fp.contains_key("radius_rank") {
        let mut cost = match (e.centre(), fp.get("center")) {
            (Some(c), Some(fc)) => t.w_pos * (c - vector(fc)?).length() / tol_pos,
            _ => 0.0,
        };
        if type_differs(fp, "curve", e.curve_name()) {
            cost += t.w_type;
        }
        match rank {
            Some((r, size)) if size as f64 == group => {
                let want = fp_num(fp, "radius_rank")?.unwrap_or(0.0);
                cost += t.w_rank * (r as f64 - want).abs();
            }
            _ => {
                if let (Some(fr), Some(r)) = (fp_num(fp, "radius")?, e.radius()) {
                    cost += t.w_rad * rel_err(r, fr) / t.len_rel_tol;
                }
            }
        }
        return Ok(cost);
    }

    let mut cost = t.w_pos * (e.mid - vector(need(fp, "mid")?)?).length() / tol_pos;
    if let Some(d) = fp_vec(fp, "dir")? {
        let dot = e.dir().dot(unit(d)).abs();
        cost += t.w_dir * (1.0 - dot) / t.ang_tol;
    }
    if let Some(len) = fp_num(fp, "length")? {
        cost += t.w_len * rel_err(e.length, len) / t.len_rel_tol;
    }
    if type_differs(fp, "curve", e.curve_name()) {
        cost += t.w_type;
    }
    if is_circle {
        if let (Some(fr), Some(r)) = (fp_num(fp, "radius")?, e.radius()) {
            cost += t.w_rad * rel_err(r, fr) / t.len_rel_tol;
        }
        if let (Some(fc), Some(c)) = (fp_vec(fp, "center")?, e.centre()) {
            cost += t.w_pos * (c - fc).length() / tol_pos;
        }
    }
    Ok(cost)
}

/// `_face_cost`, lower is better. The normal term is signed, so the inward twin
/// of a thin wall loses.
pub fn face_cost(t: &Tuning, f: &FaceEnt, fp: &Map<String, Value>, tol_pos: f64) -> FResult<f64> {
    let mut cost = t.w_pos * (f.centroid() - vector(need(fp, "centroid")?)?).length() / tol_pos;
    if let Some(n) = fp_vec(fp, "normal")? {
        let dot = f.normal().dot(unit(n));
        cost += t.w_dir * (1.0 - dot) / t.ang_tol;
    }
    if let Some(area) = fp_num(fp, "area")? {
        cost += t.w_area * rel_err(f.area, area) / t.area_rel_tol;
    }
    if type_differs(fp, "surface", f.surface_name()) {
        cost += t.w_type;
    }
    if let (Some(fr), Some(r)) = (fp_num(fp, "radius")?, f.radius) {
        cost += t.w_rad * rel_err(r, fr) / t.len_rel_tol;
    }
    Ok(cost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_matches_python() {
        // round(0.125, 2), round(2.675, 2), round(0.0625, 3), round(-0.0001, 3)
        assert_eq!(py_round(0.125, 2), 0.12);
        assert_eq!(py_round(2.675, 2), 2.67);
        assert_eq!(py_round(0.0625, 3), 0.062);
        assert_eq!(py_round(0.375, 2), 0.38);
        assert_eq!(
            key_bits(&[py_round(-0.0001, 3), 0.0, 0.0, 0.0]),
            key_bits(&[0.0; 4])
        );
        assert_eq!(format!("{:.2}", 0.125), "0.12");
    }
}
