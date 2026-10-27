//! Edge polylines for the outline pass. Dropped as in any MCAD: the seam between two coplanar planes,
//! the wrap seam of a closed periodic face, and a degenerate edge (a pole or an apex).

use opencascade::mesh_access::MeshAccess;

/// Chord deviation target of an edge polyline, millimetres. The sampler hits
/// it almost exactly, so it is the worst case deviation.
pub const EDGE_DEFLECTION: f64 = 0.01;
/// Segment clamps for a curved edge. Both even, so every clamped polyline keeps
/// an odd point count.
pub const EDGE_MIN_SEG: usize = 4;
pub const EDGE_MAX_SEG: usize = 512;
/// OCCT's quasi uniform sampler measures sag from the end tangents and takes a whole helix turn as one
/// chord, so a sample is kept only while no segment strays more than this many deflections.
pub const EDGE_SLACK: f64 = 4.0;
/// Segments of the parameter walk used when the deflection sampler cannot run.
pub const EDGE_FALLBACK_SEG: usize = 24;

/// Below this angle between the faces' normals two faces meet tangentially,
/// the boundary of a fillet rather than a corner.
pub const SMOOTH_EDGE_DEG: f64 = 1.0;

/// The radius a chord sized fillet makes of `chord` where the faces' normals meet at `dihedral_deg`.
pub fn radius_of_chord(dihedral_deg: Option<f64>, chord: f64) -> f64 {
    match dihedral_deg {
        Some(ang) if ang >= SMOOTH_EDGE_DEG => chord / (2.0 * (ang.to_radians() / 2.0).sin()),
        _ => chord,
    }
}

/// An edge shorter than this is a sliver a boolean left where two vertices
/// nearly met: too small to see, click or blend, so it is neither drawn nor blended.
pub const SLIVER_EDGE_MM: f64 = 1e-4;

#[derive(Debug, Clone, PartialEq)]
pub struct EdgeLine {
    pub points: Vec<[f64; 3]>,
    pub smooth: bool,
    /// The largest curvature across the edge of the faces either side, per mm, which the client cannot read: a
    /// fillet of radius R offers G2 and G3 here while it times R stays below 1e-6. 0 between planes.
    pub curvature: f64,
    /// `curvature` times the radius a 1 mm chord sized fillet takes here, weighed against a typed chord.
    pub chord_curvature: f64,
}

/// In edge-to-face map order. Edges go to other threads, build their own adaptors and write nothing back,
/// and results are collected by index, so the list matches a serial walk.
pub fn edge_polylines(access: &MeshAccess) -> Vec<EdgeLine> {
    let cos_tol = 1.0f64.to_radians().cos();
    let plane: Vec<Option<[f64; 3]>> = (0..access.face_count()).map(|f| access.face_plane_normal(f)).collect();
    let work = crate::par::Shared((access, &plane));
    let lines = crate::par::map_indexed(access.edge_count(), move |e| {
        let (access, plane) = *work.get();
        one_edge(access, plane, cos_tol, e)
    });
    lines.into_iter().flatten().collect()
}

fn one_edge(access: &MeshAccess, plane: &[Option<[f64; 3]>], cos_tol: f64, e: usize) -> Option<EdgeLine> {
    let plane_of = |f: usize| plane.get(f).copied().flatten();
    let faces = access.edge_faces(e);
    if faces.len() == 2 {
        if let (Some(n0), Some(n1)) = (plane_of(faces[0]), plane_of(faces[1])) {
            if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]).abs() > cos_tol {
                return None;
            }
        }
    }
    if access.edge_degenerated(e) {
        return None;
    }
    if !faces.is_empty()
        && faces.iter().all(|&f| f == faces[0])
        && (0..faces.len()).any(|k| access.edge_closed_on(e, k))
    {
        return None;
    }
    let points = edge_points(access, e)?;
    let length: f64 = points.windows(2).map(|w| (0..3).map(|k| (w[1][k] - w[0][k]).powi(2)).sum::<f64>().sqrt()).sum();
    if length < SLIVER_EDGE_MM {
        return None;
    }
    let flat = faces.len() == 2 && plane_of(faces[0]).is_some() && plane_of(faces[1]).is_some();
    let smooth =
        faces.len() == 2 && faces[0] != faces[1] && !flat && access.edge_smooth(e, SMOOTH_EDGE_DEG.to_radians().cos());
    let curvature = if flat { 0.0 } else { access.edge_cross_curvature(e) };
    let chord_curvature =
        if curvature > 0.0 { curvature * radius_of_chord(access.edge_dihedral_deg(e), 1.0) } else { 0.0 };
    Some(EdgeLine { points, smooth, curvature, chord_curvature })
}

/// A line is its two endpoints; any other curve is deviation bounded; an edge
/// the sampler refuses is walked by its raw parameter.
fn edge_points(access: &MeshAccess, e: usize) -> Option<Vec<[f64; 3]>> {
    if let Ok(Some(ends)) = access.edge_line(e) {
        return Some(ends.to_vec());
    }
    sample_by_deflection(access, e, EDGE_DEFLECTION, EDGE_MIN_SEG, EDGE_MAX_SEG)
        .or_else(|| uniform_param_points(access, e, EDGE_FALLBACK_SEG))
}

fn uniform_param_points(access: &MeshAccess, e: usize, n: usize) -> Option<Vec<[f64; 3]>> {
    let (u0, u1) = access.edge_range(e)?;
    if u1.partial_cmp(&u0) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    let params: Vec<f64> = (0..=n).map(|j| u0 + (u1 - u0) * (j as f64 / n as f64)).collect();
    access.edge_values(e, &params)
}

/// Python's `round`, half to even.
fn py_round(x: f64) -> usize {
    x.round_ties_even().max(0.0) as usize
}

fn sample_by_deflection(
    access: &MeshAccess,
    e: usize,
    deflection: f64,
    min_seg: usize,
    max_seg: usize,
) -> Option<Vec<[f64; 3]>> {
    let (pts, params) = access.edge_deflection(e, deflection)?;
    let n = pts.len();
    if n < 2 {
        return None;
    }
    if n - 1 < min_seg {
        return checked_walk(access, e, deflection, min_seg, max_seg);
    }
    let picks: Vec<usize> = if n - 1 > max_seg {
        (0..=max_seg).map(|i| py_round(i as f64 * (n - 1) as f64 / max_seg as f64)).collect()
    } else {
        (0..n).collect()
    };
    let decimated = picks.len() < n;
    let mut out: Vec<[f64; 3]> = picks.iter().map(|&i| pts[i]).collect();
    let mut us: Vec<f64> = picks.iter().map(|&i| params[i]).collect();
    if out.len() % 2 == 0 {
        // The frontend names an edge by its index-middle point, stored in saved
        // selectors; an odd count keeps that point the parametric midpoint.
        let j = out.len() / 2;
        let umid = 0.5 * (us[j - 1] + us[j]);
        let mid = access.edge_values(e, &[umid])?;
        out.insert(j, *mid.first()?);
        us.insert(j, umid);
    }
    if !decimated && mid_sag(access, e, &out, &us).is_some_and(|m| m.2 > EDGE_SLACK * deflection) {
        return checked_walk(access, e, deflection, min_seg, max_seg).or(Some(out));
    }
    Some(out)
}

/// Kept if within the slack, else doubled until within `deflection` or at `max_seg`. Counts stay `min_seg`
/// times a power of two, so the middle point stays the parametric midpoint.
fn checked_walk(
    access: &MeshAccess,
    e: usize,
    deflection: f64,
    min_seg: usize,
    max_seg: usize,
) -> Option<Vec<[f64; 3]>> {
    let (u0, u1) = access.edge_range(e)?;
    if u1.partial_cmp(&u0) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    let mut us: Vec<f64> = (0..=min_seg).map(|j| u0 + (u1 - u0) * (j as f64 / min_seg as f64)).collect();
    let mut pts = access.edge_values(e, &us)?;
    let mut limit = EDGE_SLACK * deflection;
    while us.len() - 1 < max_seg {
        let Some((mids, mid_pts, worst)) = mid_sag(access, e, &pts, &us) else {
            break;
        };
        if worst <= limit {
            break;
        }
        let (mut nu, mut np) = (Vec::with_capacity(2 * us.len()), Vec::with_capacity(2 * us.len()));
        for k in 0..mids.len() {
            nu.extend([us[k], mids[k]]);
            np.extend([pts[k], mid_pts[k]]);
        }
        nu.push(us[mids.len()]);
        np.push(pts[mids.len()]);
        (us, pts) = (nu, np);
        limit = deflection;
    }
    Some(pts)
}

/// Each segment's middle parameter, curve point and worst sag. Also probed at each segment's golden
/// section, as a helix turning whole times per segment meets the chord at its middle.
fn mid_sag(access: &MeshAccess, e: usize, pts: &[[f64; 3]], us: &[f64]) -> Option<(Vec<f64>, Vec<[f64; 3]>, f64)> {
    const PROBES: [f64; 3] = [0.5, 0.381_966_011_250_105, 0.618_033_988_749_895];
    if pts.len() != us.len() {
        return None;
    }
    let probes: Vec<f64> = us.windows(2).flat_map(|w| PROBES.map(|f| w[0] + (w[1] - w[0]) * f)).collect();
    let at = access.edge_values(e, &probes)?;
    if at.len() != probes.len() {
        return None;
    }
    let worst = (0..at.len()).map(|i| to_segment(at[i], pts[i / 3], pts[i / 3 + 1])).fold(0.0f64, f64::max);
    let mids = probes.iter().step_by(3).copied().collect();
    let mid_pts = at.iter().step_by(3).copied().collect();
    Some((mids, mid_pts, worst))
}

fn to_segment(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let t = if len2 > 0.0 { ((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2).clamp(0.0, 1.0) } else { 0.0 };
    (0..3).map(|k| (ap[k] - t * ab[k]).powi(2)).sum::<f64>().sqrt()
}

/// Unsigned, tangent faces can carry opposite orientations. The reference the test and the bench's
/// `smooth` stage check `MeshAccess::edge_smooth` against, which is what the pass calls.
pub fn meets_smoothly(access: &MeshAccess, e: usize) -> bool {
    let cos_tol = SMOOTH_EDGE_DEG.to_radians().cos();
    let Some((t0, t1)) = access.edge_brep_range(e) else {
        return false;
    };
    for frac in [0.5, 0.15, 0.85] {
        let t = t0 + (t1 - t0) * frac;
        let mut normals = [[0.0f64; 3]; 2];
        for (side, slot) in normals.iter_mut().enumerate() {
            let Some(n) = access.edge_face_normal(e, side, t) else {
                return false;
            };
            let mag = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if mag < 1e-12 {
                return false;
            }
            *slot = [n[0] / mag, n[1] / mag, n[2] / mag];
        }
        let d = normals[0][0] * normals[1][0] + normals[0][1] * normals[1][1] + normals[0][2] * normals[1][2];
        if d.abs() < cos_tol {
            return false;
        }
    }
    true
}
