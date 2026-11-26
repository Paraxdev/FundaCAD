//! The Geometry list: the faces, edges and planes of one body, read off its mesh on the client. The engine's
//! topology reply (exact surfaces, sizes, face runs) is not asked for, so a face is flat, a cylinder or curved by its
//! triangle normals alone.

use glam::Vec3;
use serde_json::{Map, Value};

use super::{datum_plane_name, features, str_of, suppressed};
use fundacad_client::Body;

pub const PAGE_SIZE: usize = 100;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GeomKind {
    #[default]
    Faces,
    Edges,
    Planes,
}

impl GeomKind {
    pub fn label(self) -> &'static str {
        match self {
            GeomKind::Faces => "Faces",
            GeomKind::Edges => "Edges",
            GeomKind::Planes => "Planes",
        }
    }

    fn noun(self, n: usize) -> &'static str {
        match (self, n == 1) {
            (GeomKind::Faces, true) => "face",
            (GeomKind::Faces, false) => "faces",
            (GeomKind::Edges, true) => "edge",
            (GeomKind::Edges, false) => "edges",
            (GeomKind::Planes, true) => "plane",
            (GeomKind::Planes, false) => "planes",
        }
    }

    pub fn count(self, n: usize) -> String {
        match n {
            0 => format!("No {}", self.noun(0)),
            n => format!("{n} {}", self.noun(n)),
        }
    }

    pub fn types(self) -> &'static [RowType] {
        match self {
            GeomKind::Faces => &[RowType::Flat, RowType::Cylinder, RowType::Curved],
            GeomKind::Edges => &[RowType::Straight, RowType::Round, RowType::CurvedEdge],
            GeomKind::Planes => &[],
        }
    }
}

pub const KINDS: [GeomKind; 3] = [GeomKind::Faces, GeomKind::Edges, GeomKind::Planes];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowType {
    Flat,
    Cylinder,
    Curved,
    Straight,
    Round,
    CurvedEdge,
}

impl RowType {
    pub fn label(self) -> &'static str {
        match self {
            RowType::Flat => "Flat",
            RowType::Cylinder => "Cylinder",
            RowType::Curved | RowType::CurvedEdge => "Curved",
            RowType::Straight => "Straight",
            RowType::Round => "Round",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Facing {
    Up,
    Down,
    Front,
    Back,
    Left,
    Right,
}

pub const FACINGS: [Facing; 6] = [Facing::Up, Facing::Down, Facing::Front, Facing::Back, Facing::Left, Facing::Right];

impl Facing {
    pub fn label(self) -> &'static str {
        match self {
            Facing::Up => "Up",
            Facing::Down => "Down",
            Facing::Front => "Front",
            Facing::Back => "Back",
            Facing::Left => "Left",
            Facing::Right => "Right",
        }
    }

    fn word(self) -> &'static str {
        match self {
            Facing::Up => "up",
            Facing::Down => "down",
            Facing::Front => "front",
            Facing::Back => "back",
            Facing::Left => "left",
            Facing::Right => "right",
        }
    }
}

const MATCH_COS: f32 = 0.999_390_8; // cos 2 degrees
const NOISE: f32 = 1e-6;

/// The axis a normal mostly points along, and how far off it it tilts in whole degrees. A tie goes Z, then Y, then X.
pub fn facing_of(n: Vec3) -> Option<(Facing, u32)> {
    let len = n.length();
    if !(len > 0.0) || !len.is_finite() {
        return None;
    }
    let a = n.abs() / len;
    let on_z = a.z >= a.x.max(a.y) - NOISE;
    let on_y = !on_z && a.y >= a.x - NOISE;
    let word = match (on_z, on_y) {
        (true, _) if n.z > 0.0 => Facing::Up,
        (true, _) => Facing::Down,
        (_, true) if n.y > 0.0 => Facing::Back,
        (_, true) => Facing::Front,
        _ if n.x > 0.0 => Facing::Right,
        _ => Facing::Left,
    };
    let main = if on_z { a.z } else if on_y { a.y } else { a.x };
    let tilt = if main >= MATCH_COS - NOISE { 0 } else { main.clamp(-1.0, 1.0).acos().to_degrees().round() as u32 };
    Some((word, tilt))
}

fn facing_words(f: (Facing, u32)) -> String {
    match f {
        (w, 0) => format!("facing {}", w.word()),
        (w, deg) => format!("tilted {deg}° from {}", w.word()),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GeomRow {
    /// `f:<body>:<face>`, `e:<body>:<slot>`, `p:o:<plane>` or `p:<feature>`.
    pub key: String,
    pub kind: GeomKind,
    pub index: usize,
    pub label: String,
    pub hint: String,
    pub row_type: Option<RowType>,
    pub facing: Option<Facing>,
}

pub fn fmt_mm(v: f32) -> String {
    let s = format!("{v:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s} mm")
}

fn fmt_area(v: f32) -> String {
    let s = format!("{v:.1}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    format!("{s} mm²")
}

struct FaceAcc {
    area: f32,
    normal: Vec3,
    normals: Vec<Vec3>,
}

/// One row per face, numbered from 1 in the body's own face order.
pub fn face_rows(body: &Body, owner_name: impl Fn(&str) -> Option<String>) -> Vec<GeomRow> {
    let at = |v: u32| {
        let i = v as usize * 3;
        Vec3::new(body.positions[i], body.positions[i + 1], body.positions[i + 2])
    };
    let mut faces: Vec<FaceAcc> = Vec::new();
    for (t, tri) in body.indices.chunks_exact(3).enumerate() {
        let face = body.face_ids.get(t).copied().unwrap_or(t as u32) as usize;
        if faces.len() <= face {
            faces.resize_with(face + 1, || FaceAcc { area: 0.0, normal: Vec3::ZERO, normals: Vec::new() });
        }
        let cross = (at(tri[1]) - at(tri[0])).cross(at(tri[2]) - at(tri[0]));
        let area = cross.length() * 0.5;
        if area <= 0.0 {
            continue;
        }
        // The mesh's own normals win over the winding, which the engine does not promise.
        let given = body.normals.as_ref().map(|n| {
            tri.iter().map(|&v| Vec3::new(n[v as usize * 3], n[v as usize * 3 + 1], n[v as usize * 3 + 2])).sum::<Vec3>()
        });
        let normal = given.map(Vec3::normalize_or_zero).filter(|n| *n != Vec3::ZERO).unwrap_or(cross / (area * 2.0));
        let f = &mut faces[face];
        f.area += area;
        f.normal += normal * area;
        f.normals.push(normal);
    }
    faces
        .iter()
        .enumerate()
        .filter(|(_, f)| !f.normals.is_empty())
        .map(|(i, f)| {
            let row_type = face_type(&f.normals);
            let facing = if row_type == RowType::Flat { facing_of(f.normal) } else { None };
            let label = match row_type {
                RowType::Flat => format!("Flat face {}", i + 1),
                RowType::Cylinder => format!("Cylinder {}", i + 1),
                _ => format!("Curved face {}", i + 1),
            };
            let mut hint = vec![fmt_area(f.area)];
            hint.extend(facing.map(facing_words));
            hint.extend(body.face_owners.get(i).cloned().flatten().and_then(|o| owner_name(&o)));
            GeomRow {
                key: format!("f:{}:{i}", body.id),
                kind: GeomKind::Faces,
                index: i,
                label,
                hint: hint.join(", "),
                row_type: Some(row_type),
                facing: facing.map(|f| f.0),
            }
        })
        .collect()
}

/// Flat when every triangle faces the same way, a cylinder when every normal is square to one axis.
pub fn face_type(normals: &[Vec3]) -> RowType {
    let Some(&first) = normals.first() else { return RowType::Curved };
    if normals.iter().all(|n| n.dot(first) >= MATCH_COS) {
        return RowType::Flat;
    }
    let far = normals.iter().copied().min_by(|a, b| a.dot(first).total_cmp(&b.dot(first))).unwrap_or(first);
    let axis = first.cross(far).normalize_or_zero();
    if axis != Vec3::ZERO && normals.iter().all(|n| n.dot(axis).abs() <= 0.02) {
        RowType::Cylinder
    } else {
        RowType::Curved
    }
}

/// The polylines of a body's edges, in wire order.
pub fn edge_polylines(body: &Body) -> Vec<Vec<Vec3>> {
    let pts = &body.edges.points;
    let mut at = 0usize;
    let mut out = Vec::with_capacity(body.edges.counts.len());
    for &count in &body.edges.counts {
        let count = count as usize;
        let line: Vec<Vec3> = (at..at + count)
            .filter(|&i| i * 3 + 2 < pts.len())
            .map(|i| Vec3::new(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]))
            .collect();
        at += count;
        out.push(line);
    }
    out
}

pub fn polyline_length(points: &[Vec3]) -> f32 {
    points.windows(2).map(|w| w[0].distance(w[1])).sum()
}

// Wire points are exact on a line, so this only has to clear float noise and stay under the bow of a large shallow
// arc.
const LINE_TOL_MM: f32 = 1e-4;
const ARC_TOL: f32 = 0.005;

fn is_straight(points: &[Vec3]) -> bool {
    let (a, b) = (points[0], points[points.len() - 1]);
    let chord = a.distance(b);
    if chord == 0.0 {
        return points.iter().all(|p| p.distance(a) <= LINE_TOL_MM);
    }
    let u = (b - a) / chord;
    points.iter().all(|p| {
        let d = *p - a;
        (d - u * d.dot(u)).length() <= LINE_TOL_MM.max(chord * 1e-6)
    })
}

/// The diameter of a closed polyline that is a circle. Chord midpoints are weighted by length, since the engine sends
/// a rim as two half circles with a half step where they meet.
pub fn circle_diameter(points: &[Vec3]) -> Option<f32> {
    if points.len() < 8 {
        return None;
    }
    let span = polyline_length(points);
    if span <= 0.0 || points[0].distance(points[points.len() - 1]) > span * 1e-3 {
        return None;
    }
    let centre = points.windows(2).map(|w| (w[0] + w[1]) * (w[0].distance(w[1]) / 2.0)).sum::<Vec3>() / span;
    let ring = &points[..points.len() - 1];
    let radii: Vec<f32> = ring.iter().map(|p| p.distance(centre)).collect();
    let mean = radii.iter().sum::<f32>() / radii.len() as f32;
    (mean > 0.0 && radii.iter().all(|r| (r - mean).abs() <= mean * 0.01)).then_some(mean * 2.0)
}

/// The circle through the first, middle and last points, every other point lying on it too.
fn arc_radius(points: &[Vec3]) -> Option<f32> {
    if points.len() < 3 {
        return None;
    }
    let (a, b, c) = (points[0], points[points.len() / 2], points[points.len() - 1]);
    let (ab, ac) = (b - a, c - a);
    let n = ab.cross(ac);
    let nn = n.length_squared();
    if nn == 0.0 {
        return None;
    }
    let rel = (ac.cross(n) * ab.length_squared() + n.cross(ab) * ac.length_squared()) / (2.0 * nn);
    let radius = rel.length();
    let centre = a + rel;
    points.iter().all(|p| (p.distance(centre) - radius).abs() <= radius * ARC_TOL).then_some(radius)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Curve {
    Line,
    Circle(f32),
    Arc(f32),
    Other,
}

pub fn edge_curve(points: &[Vec3]) -> Curve {
    if points.len() < 2 || is_straight(points) {
        return Curve::Line;
    }
    if let Some(d) = circle_diameter(points) {
        return Curve::Circle(d / 2.0);
    }
    let closed = points[0].distance(points[points.len() - 1]) <= polyline_length(points) * 1e-3;
    match (closed, arc_radius(points)) {
        (false, Some(r)) => Curve::Arc(r),
        _ => Curve::Other,
    }
}

pub fn edge_rows(body: &Body) -> Vec<GeomRow> {
    edge_polylines(body)
        .iter()
        .enumerate()
        .map(|(slot, line)| {
            let curve = edge_curve(line);
            let (row_type, label) = match curve {
                Curve::Line => (RowType::Straight, "Straight edge"),
                Curve::Circle(_) | Curve::Arc(_) => (RowType::Round, "Round edge"),
                Curve::Other => (RowType::CurvedEdge, "Curved edge"),
            };
            let mut hint = vec![fmt_mm(polyline_length(line))];
            match curve {
                Curve::Circle(r) => hint.push(format!("⌀{}", fmt_mm(r * 2.0))),
                Curve::Arc(r) => hint.push(format!("R{}", fmt_mm(r))),
                _ => {}
            }
            GeomRow {
                key: format!("e:{}:{slot}", body.id),
                kind: GeomKind::Edges,
                index: slot,
                label: format!("{label} {}", slot + 1),
                hint: hint.join(", "),
                row_type: Some(row_type),
                facing: None,
            }
        })
        .collect()
}

/// The origin planes, then the datum planes that are not suppressed. A datum's normal is the engine's to work out,
/// so a datum row has no facing here.
pub fn plane_rows(doc: &Map<String, Value>) -> Vec<GeomRow> {
    let origin = [("XY", Vec3::Z), ("XZ", -Vec3::Y), ("YZ", Vec3::X)];
    let mut rows: Vec<GeomRow> = origin
        .iter()
        .enumerate()
        .map(|(i, (p, n))| {
            let facing = facing_of(*n);
            GeomRow {
                key: format!("p:o:{p}"),
                kind: GeomKind::Planes,
                index: i,
                label: format!("{p} plane"),
                hint: ["origin".to_string()].into_iter().chain(facing.map(facing_words)).collect::<Vec<_>>().join(", "),
                row_type: None,
                facing: facing.map(|f| f.0),
            }
        })
        .collect();
    let datums = features(doc).filter(|f| str_of(f, "type") == Some("datumPlane"));
    for (n, f) in datums.enumerate() {
        let id = str_of(f, "id").unwrap_or("");
        if suppressed(doc, id) {
            continue;
        }
        rows.push(GeomRow {
            key: format!("p:{id}"),
            kind: GeomKind::Planes,
            index: rows.len(),
            label: datum_plane_name(f, n),
            hint: "datum plane".into(),
            row_type: None,
            facing: None,
        });
    }
    rows
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Filters {
    pub row_type: Option<RowType>,
    pub facing: Option<Facing>,
}

pub fn filter_rows<'a>(rows: &'a [GeomRow], f: &Filters) -> Vec<&'a GeomRow> {
    rows.iter()
        .filter(|r| f.row_type.is_none_or(|t| r.row_type == Some(t)) && f.facing.is_none_or(|w| r.facing == Some(w)))
        .collect()
}

/// "1 to 100 of 340", for the page that starts at `page * PAGE_SIZE`.
pub fn range_text(page: usize, total: usize) -> String {
    let first = (page * PAGE_SIZE + 1).min(total);
    let last = ((page + 1) * PAGE_SIZE).min(total);
    format!("{first} to {last} of {total}")
}

pub fn page_count(total: usize) -> usize {
    total.div_ceil(PAGE_SIZE).max(1)
}

#[cfg(test)]
mod tests;
