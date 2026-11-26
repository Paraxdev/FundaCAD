//! A body's edges as the engine sends them, polylines in one flat array, and finding the one under the cursor.

#[cfg(test)]
mod tests;

use fundacad_client::Body;
use glam::{Vec2, Vec3};

/// Each edge's points, in the order the engine listed them.
pub fn polylines(body: &Body) -> Vec<Vec<Vec3>> {
    let pts = &body.edges.points;
    let mut out = Vec::with_capacity(body.edges.counts.len());
    let mut at = 0usize;
    for &n in &body.edges.counts {
        let end = at + n as usize;
        if end * 3 > pts.len() {
            break;
        }
        out.push((at..end).map(|i| Vec3::new(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])).collect());
        at = end;
    }
    out
}

/// The point halfway along the polyline by length, the first point of one with no length.
pub fn midpoint(line: &[Vec3]) -> Option<Vec3> {
    let first = *line.first()?;
    let total: f32 = line.windows(2).map(|w| w[0].distance(w[1])).sum();
    let mut left = total / 2.0;
    for w in line.windows(2) {
        let d = w[0].distance(w[1]);
        if d >= left && d > 0.0 {
            return Some(w[0].lerp(w[1], left / d));
        }
        left -= d;
    }
    Some(first)
}

fn to_segment(p: Vec2, a: Vec2, b: Vec2) -> (f32, f32) {
    let ab = b - a;
    let t = if ab.length_squared() > 0.0 { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) } else { 0.0 };
    (p.distance(a + ab * t), t)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Near {
    pub edge: usize,
    /// On screen, in pixels.
    pub distance: f32,
    /// The point of the edge nearest the cursor, in the world.
    pub point: Vec3,
}

/// The edge nearest `cursor` on screen within `reach` pixels. `project` puts a world point on screen and says None for
/// one behind the camera.
pub fn nearest(lines: &[Vec<Vec3>], project: impl Fn(Vec3) -> Option<Vec2>, cursor: Vec2, reach: f32) -> Option<Near> {
    let mut best: Option<Near> = None;
    for (i, line) in lines.iter().enumerate() {
        let screen: Vec<Option<Vec2>> = line.iter().map(|p| project(*p)).collect();
        for (w, world) in screen.windows(2).zip(line.windows(2)) {
            let (Some(a), Some(b)) = (w[0], w[1]) else { continue };
            let (d, t) = to_segment(cursor, a, b);
            if d <= reach && best.is_none_or(|n| d < n.distance) {
                best = Some(Near { edge: i, distance: d, point: world[0].lerp(world[1], t) });
            }
        }
    }
    best
}
