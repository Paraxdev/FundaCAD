//! Delete Face, the Python engine's `defeature.py` `_defeature` and its four rungs, with the
//! re-targeting of the Python engine's `booleans.py` `_retarget_delete_faces`.

use std::collections::{BTreeSet, HashMap, HashSet};

use fundacad_core::schema::{DeleteFace, Selector};
use glam::{dvec3, DVec3};
use opencascade::boolean_op::{BooleanKind, BooleanOp, BooleanOptions};
use opencascade::primitives::{Shape, ShapeType, SurfaceType};
use opencascade::progress::ProgressRange;
use opencascade::select_access as sa;
use opencascade::topology::{AncestorMap, ShapeMap};
use serde_json::{json, Value};

use super::solid_ops::surface_type;
use super::split::split_by_plane;
use crate::builder::owners::face_key;
use crate::builder::{Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind, Kind};
use crate::select::entity::FaceEnt;
use crate::select::Resolver;

fn centre(face: &Shape) -> DVec3 {
    FaceEnt::new(face.clone()).map_or(DVec3::ZERO, |f| f.centroid())
}

/// build123d `face.normal_at(point)`: the normal where the point projects.
fn normal_at(face: &Shape, p: DVec3) -> Option<DVec3> {
    let f = face.as_face()?;
    let proj = f.project_point(p).ok()??;
    f.point_and_normal(proj.u, proj.v)
        .ok()
        .map(|(_, n)| n.normalize())
}

fn vertices(shape: &Shape) -> Vec<DVec3> {
    kernel::subshapes(shape, Kind::Vertex)
        .iter()
        .filter_map(kernel::bbox)
        .map(|b| dvec3(b[0], b[1], b[2]))
        .collect()
}

fn fp(face: &Shape) -> Option<String> {
    face_key(face)
}

fn fps(shape: &Shape) -> HashSet<String> {
    kernel::subshapes(shape, Kind::Face)
        .iter()
        .filter_map(fp)
        .collect()
}

/// `_face_width`: 2 area / perimeter.
fn width(face: &Shape) -> f64 {
    let per: f64 = kernel::subshapes(face, Kind::Edge)
        .iter()
        .map(kernel::length)
        .sum();
    if per > 0.0 {
        2.0 * kernel::area(face) / per
    } else {
        0.0
    }
}

fn solids(shape: &Shape) -> Vec<Shape> {
    kernel::subshapes(shape, Kind::Solid)
}

fn one_or_compound(parts: Vec<Shape>) -> Shape {
    if parts.len() == 1 {
        parts.into_iter().next().unwrap_or_else(Shape::empty)
    } else {
        kernel::compound(&parts)
    }
}

/// topo_adj.py `FaceAdjacency`.
struct Adjacency {
    faces: ShapeMap,
    edges: AncestorMap,
}

impl Adjacency {
    fn new(shape: &Shape) -> Adjacency {
        Adjacency {
            faces: shape.shape_map(ShapeType::Face),
            edges: shape.ancestor_map(ShapeType::Edge, ShapeType::Face),
        }
    }

    fn face(&self, i: usize) -> Shape {
        self.faces.get(i).unwrap_or_else(Shape::empty)
    }

    fn index_of(&self, face: &Shape) -> usize {
        self.faces.index_of(face)
    }

    /// (other face, shared edge) per edge of face `i`, a neighbour once per edge.
    fn walk(&self, i: usize) -> Vec<(usize, Shape)> {
        let mut out = Vec::new();
        for edge in self.face(i).subshapes(ShapeType::Edge) {
            for other in self.edges.ancestors(&edge) {
                let j = self.faces.index_of(&other);
                if j != i {
                    out.push((j, edge.clone()));
                }
            }
        }
        out
    }
}

/// `_remove_features`: the healed shape, or `None`, and the alert keys.
fn remove_features(shape: &Shape, faces: &[Shape]) -> (Option<Shape>, Vec<String>) {
    let faces: Vec<_> = faces.iter().filter_map(Shape::as_face).collect();
    let refs: Vec<_> = faces.iter().collect();
    let keys = |lines: &[String]| -> Vec<String> {
        lines
            .iter()
            .filter_map(|l| l.split_once(' ').map(|(_, k)| k.to_owned()))
            .collect()
    };
    let removed = match shape.remove_features(&refs, true, &ProgressRange::detached()) {
        Ok(r) => r,
        Err(opencascade::Error::Occt(m)) => {
            let lines: Vec<String> = m.split(", ").map(str::to_owned).collect();
            return (None, keys(&lines));
        }
        Err(_) => return (None, Vec::new()),
    };
    let alerts = keys(&removed.alerts);
    let parts = solids(&removed.shape);
    if parts.is_empty() {
        return (None, alerts);
    }
    let before = kernel::count(shape, Kind::Face);
    let after: usize = parts.iter().map(|s| kernel::count(s, Kind::Face)).sum();
    if after >= before {
        return (None, alerts);
    }
    (Some(one_or_compound(parts)), alerts)
}

/// `_expand_blend_chain`: the picked faces grown into their chamfer or fillet chain.
fn expand_blend_chain(shape: &Shape, seeds: &[Shape]) -> Vec<Shape> {
    const WIDTH_FACTOR: f64 = 4.0;
    const MAX_FACES: usize = 64;
    const BAND_ASPECT_MAX: f64 = 0.4;
    let adj = Adjacency::new(shape);
    let seed_idx: Vec<usize> = seeds
        .iter()
        .map(|s| adj.index_of(s))
        .filter(|&i| i > 0)
        .collect();
    if seed_idx.is_empty() {
        return seeds.to_vec();
    }
    let mut neighbours: HashMap<usize, Vec<(usize, DVec3)>> = HashMap::new();
    let mut neighbours_of = |i: usize| -> Vec<(usize, DVec3)> {
        neighbours
            .entry(i)
            .or_insert_with(|| {
                adj.walk(i)
                    .into_iter()
                    .map(|(j, e)| {
                        let mid = e
                            .as_edge()
                            .and_then(|e| {
                                let r = e.range().ok()?;
                                e.d1(0.5 * (r.first + r.last)).ok().map(|(p, _)| p)
                            })
                            .unwrap_or(DVec3::ZERO);
                        (j, mid)
                    })
                    .collect()
            })
            .clone()
    };
    let width_cache = std::cell::RefCell::new(HashMap::<usize, f64>::new());
    let width_of = |i: usize| -> f64 {
        *width_cache
            .borrow_mut()
            .entry(i)
            .or_insert_with(|| width(&adj.face(i)))
    };
    let dihedral = |i: usize, j: usize, p: DVec3| -> f64 {
        match (normal_at(&adj.face(i), p), normal_at(&adj.face(j), p)) {
            (Some(a), Some(b)) => a.dot(b).clamp(-1.0, 1.0).abs().acos().to_degrees(),
            _ => 90.0,
        }
    };
    let mut blend_cache: HashMap<usize, bool> = HashMap::new();
    let cap = WIDTH_FACTOR
        * seed_idx
            .iter()
            .map(|&i| width_of(i))
            .fold(f64::NEG_INFINITY, f64::max);
    let patch_area_max = (cap / 2.0).powi(2);
    let mut chain: BTreeSet<usize> = seed_idx.iter().copied().collect();
    let mut queue = seed_idx.clone();
    while let Some(i) = queue.pop() {
        for (j, _) in neighbours_of(i) {
            if chain.contains(&j) || width_of(j) > cap {
                continue;
            }
            let near = neighbours_of(j);
            let in_chain = near.iter().filter(|(k, _)| chain.contains(k)).count();
            let blend = match blend_cache.get(&j) {
                Some(b) => *b,
                None => {
                    let face = adj.face(j);
                    let longest = kernel::subshapes(&face, Kind::Edge)
                        .iter()
                        .map(kernel::length)
                        .fold(0.0, f64::max);
                    let b = if longest <= 0.0 || width_of(j) / longest > BAND_ASPECT_MAX {
                        false
                    } else {
                        match surface_type(&face) {
                            Some(
                                SurfaceType::Cylinder
                                | SurfaceType::Cone
                                | SurfaceType::Torus
                                | SurfaceType::Sphere,
                            ) => near.iter().any(|(k, p)| dihedral(j, *k, *p) < 10.0),
                            Some(SurfaceType::Plane) => near.iter().any(|(k, p)| {
                                let d = dihedral(j, *k, *p);
                                (15.0..=75.0).contains(&d)
                            }),
                            _ => false,
                        }
                    };
                    blend_cache.insert(j, b);
                    b
                }
            };
            if blend || (in_chain >= 2 && kernel::area(&adj.face(j)) <= patch_area_max) {
                chain.insert(j);
                queue.push(j);
                if chain.len() >= MAX_FACES {
                    return seeds.to_vec();
                }
            }
        }
    }
    chain.into_iter().map(|i| adj.face(i)).collect()
}

/// `_wound_boundary`: faces edge-adjacent to `faces`, not among them.
fn wound_boundary(comp: &Shape, faces: &[Shape]) -> Vec<Shape> {
    let adj = Adjacency::new(comp);
    let removed: BTreeSet<usize> = faces.iter().map(|f| adj.index_of(f)).collect();
    let ring: BTreeSet<usize> = removed
        .iter()
        .filter(|&&i| i > 0)
        .flat_map(|&i| adj.walk(i).into_iter().map(|(j, _)| j))
        .filter(|j| !removed.contains(j))
        .collect();
    ring.into_iter().map(|j| adj.face(j)).collect()
}

fn debris(face: &Shape) -> bool {
    width(face) < 0.25 && kernel::area(face) < 1.0
}

/// Distinct support planes as (outward normal, largest offset), a facet
/// staircase kept at its outermost step.
fn support_groups(supports: &[Shape]) -> Vec<(DVec3, f64)> {
    let mut groups: Vec<(DVec3, f64)> = Vec::new();
    for b in supports {
        let p0 = centre(b);
        let n = normal_at(b, p0).unwrap_or(DVec3::ZERO);
        let off = p0.dot(n);
        match groups.iter_mut().find(|g| n.dot(g.0) > 0.9998) {
            Some(g) => g.1 = g.1.max(off),
            None => groups.push((n, off)),
        }
    }
    groups
}

fn samples(faces: &[Shape]) -> Vec<DVec3> {
    let mut out = Vec::new();
    for f in faces {
        out.push(centre(f));
        out.extend(vertices(f));
    }
    out
}

/// build123d `split(tool, bisect_by=Plane(origin, z_dir), keep=Keep.TOP)`.
fn split_keep_top(tool: &Shape, origin: DVec3, z: DVec3) -> Option<Shape> {
    let helper = if z.x.abs() < 0.9 { DVec3::X } else { DVec3::Y };
    let xdir = z.cross(helper).normalize();
    let (tops, _) = split_by_plane(tool, origin, z, xdir).ok()?;
    Some(kernel::compound(&tops))
}

/// The half-space wedge of `groups` clipped to a box around `region`, flush
/// on the axes no support bounds.
fn wedge(groups: &[(DVec3, f64)], region: &[Shape]) -> Option<Shape> {
    let bb = kernel::bbox(&kernel::compound(region))?;
    let (lo0, hi0) = (dvec3(bb[0], bb[1], bb[2]), dvec3(bb[3], bb[4], bb[5]));
    let d = (hi0 - lo0).length() * 0.2 + 0.5;
    let (mut lo, mut hi) = (lo0.to_array(), hi0.to_array());
    for ax in 0..3 {
        let comps: Vec<f64> = groups.iter().map(|(n, _)| n.to_array()[ax]).collect();
        if comps.iter().any(|&v| v < -0.5 - 1e-9) {
            lo[ax] -= d;
        }
        if comps.iter().any(|&v| v > 0.5 + 1e-9) {
            hi[ax] += d;
        }
    }
    if (0..3).map(|k| hi[k] - lo[k]).fold(f64::INFINITY, f64::min) < 1e-6 {
        return None;
    }
    let size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    let centre = [
        (lo[0] + hi[0]) / 2.0,
        (lo[1] + hi[1]) / 2.0,
        (lo[2] + hi[2]) / 2.0,
    ];
    let boxed = kernel::make_box(size[0], size[1], size[2]).ok()?;
    let mut tool = kernel::translated(&boxed, centre).ok()?;
    for (n, off) in groups {
        tool = split_keep_top(&tool, *n * *off, -*n)?;
        if solids(&tool).is_empty() {
            return None;
        }
    }
    Some(tool)
}

fn budget(faces: &[Shape]) -> f64 {
    let area: f64 = faces.iter().map(kernel::area).sum();
    let widest = faces.iter().map(width).fold(f64::NEG_INFINITY, f64::max);
    area.max(1.0) * widest.max(1.0) * 3.0
}

fn outside_margin(inner: [f64; 6], outer: [f64; 6], margin: f64) -> bool {
    (0..3).any(|k| inner[k] < outer[k] - margin || inner[k + 3] > outer[k + 3] + margin)
}

/// `_tool_fill`: a missing corner rebuilt from its supports' half-spaces.
fn tool_fill(shape: &Shape, targets: &[Shape], feature_faces: &[Shape]) -> Option<Shape> {
    const MAX_PLANES: usize = 12;
    let comp = shape;
    let feature_faces = if feature_faces.is_empty() {
        targets
    } else {
        feature_faces
    };
    let feat_fps: HashSet<String> = feature_faces.iter().filter_map(fp).collect();
    let first_ring: Vec<Shape> = wound_boundary(comp, targets)
        .into_iter()
        .filter(|b| fp(b).map_or(true, |k| !feat_fps.contains(&k)))
        .collect();
    let mut seen: HashSet<Option<String>> = feat_fps.iter().cloned().map(Some).collect();
    let mut bases = Vec::new();
    for b in first_ring {
        let key = fp(&b);
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        if debris(&b) {
            for c in wound_boundary(comp, std::slice::from_ref(&b)) {
                let ck = fp(&c);
                if !seen.contains(&ck) && !debris(&c) {
                    seen.insert(ck);
                    bases.push(c);
                }
            }
        } else {
            bases.push(b);
        }
    }
    if bases.is_empty()
        || bases
            .iter()
            .any(|b| surface_type(b) != Some(SurfaceType::Plane))
    {
        return None;
    }
    let pts = samples(targets);
    let groups: Vec<(DVec3, f64)> = support_groups(&bases)
        .into_iter()
        .filter(|(n, off)| pts.iter().all(|p| p.dot(*n) <= off + 0.1))
        .collect();
    if groups.is_empty() || groups.len() > MAX_PLANES {
        return None;
    }
    let region_box = kernel::bbox(&kernel::compound(feature_faces))?;
    let tool = wedge(&groups, feature_faces)?;
    let outside = kernel::boolean_op(&tool, &[comp], BoolKind::Cut).ok()?;
    let region = kernel::compound(feature_faces);
    let voids: Vec<Shape> = solids(&outside)
        .into_iter()
        .filter(|s| s.distance(&region, 0.0).is_ok_and(|d| d.value < 1e-2))
        .collect();
    if voids.is_empty() {
        return None;
    }
    let vb = kernel::bbox(&kernel::compound(&voids))?;
    if outside_margin(vb, region_box, 0.5) {
        return None;
    }
    let gain_cap = budget(feature_faces);
    if voids.iter().map(kernel::volume).sum::<f64>() > gain_cap {
        return None;
    }
    let options = BooleanOptions {
        fuzzy: 1e-5,
        ..Default::default()
    };
    let op = BooleanOp::run(
        BooleanKind::Fuse,
        [comp],
        voids.iter(),
        options,
        &ProgressRange::detached(),
    )
    .ok()?;
    let result = op.shape().ok()?;
    if kernel::is_null(&result) || solids(&result).len() != solids(comp).len() {
        return None;
    }
    let gain = kernel::volume(&result) - kernel::volume(comp);
    if gain <= 1e-9 || gain > gain_cap {
        return None;
    }
    let target_fps: HashSet<String> = targets.iter().filter_map(fp).collect();
    let after = fps(&result);
    if !target_fps.is_empty() && target_fps.iter().all(|k| after.contains(k)) {
        return None;
    }
    if !result.is_valid().unwrap_or(false) {
        return None;
    }
    Some(one_or_compound(solids(&result)))
}

/// `_tool_fill_all`: pocket by pocket until every feature face is consumed.
fn tool_fill_all(shape: &Shape, feature_faces: &[Shape]) -> Option<Shape> {
    const MAX_ROUNDS: usize = 24;
    let v0 = kernel::volume(shape);
    let total_cap = budget(feature_faces);
    let by_area = |mut faces: Vec<Shape>| {
        faces.sort_by(|a, b| {
            kernel::area(b)
                .partial_cmp(&kernel::area(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        faces
    };
    let mut cur = shape.clone();
    let mut remaining = by_area(feature_faces.to_vec());
    for _ in 0..MAX_ROUNDS {
        let filled = remaining
            .iter()
            .find_map(|t| tool_fill(&cur, std::slice::from_ref(t), &remaining))?;
        if kernel::volume(&filled) - v0 > total_cap {
            return None;
        }
        // The fuse can split a band face at the clip boundary; its stub keeps
        // the plane but not the fingerprint, and must not become a support.
        let prev: Vec<(DVec3, DVec3, [f64; 6])> = remaining
            .iter()
            .filter_map(|f| {
                let c = centre(f);
                Some((normal_at(f, c)?, c, kernel::bbox(f)?))
            })
            .collect();
        cur = filled;
        let cur_fps = fps(&cur);
        let left: HashSet<String> = remaining
            .iter()
            .filter_map(fp)
            .filter(|k| cur_fps.contains(k))
            .collect();
        let fragment = |g: &Shape| -> bool {
            let gc = centre(g);
            let Some(gn) = normal_at(g, gc) else {
                return false;
            };
            prev.iter().any(|(n, c, fb)| {
                gn.dot(*n).abs() > 0.999
                    && (gc - *c).dot(*n).abs() < 0.05
                    && (0..3).all(|k| {
                        fb[k] - 0.5 <= gc.to_array()[k] && gc.to_array()[k] <= fb[k + 3] + 0.5
                    })
            })
        };
        remaining = by_area(
            kernel::subshapes(&cur, Kind::Face)
                .into_iter()
                .filter(|f| fp(f).is_some_and(|k| left.contains(&k)) || fragment(f))
                .collect(),
        );
        if remaining.is_empty() {
            return Some(cur);
        }
    }
    None
}

/// `_tool_cut`: an extra-material remnant cut away by the same wedge.
fn tool_cut(shape: &Shape, targets: &[Shape]) -> Option<Shape> {
    const MAX_PLANES: usize = 12;
    let comp = shape;
    let band_cap = 2.0 * targets.iter().map(kernel::area).sum::<f64>();
    let mut cut_set = targets.to_vec();
    cut_set.extend(
        wound_boundary(comp, targets)
            .into_iter()
            .filter(|b| width(b) < 2.5 && kernel::area(b) <= band_cap),
    );
    let cut_fps: HashSet<String> = cut_set.iter().filter_map(fp).collect();
    let supports: Vec<Shape> = wound_boundary(comp, &cut_set)
        .into_iter()
        .filter(|b| fp(b).map_or(true, |k| !cut_fps.contains(&k)))
        .collect();
    if supports.is_empty()
        || supports
            .iter()
            .any(|b| surface_type(b) != Some(SurfaceType::Plane))
    {
        return None;
    }
    let pts = samples(&cut_set);
    let groups: Vec<(DVec3, f64)> = support_groups(&supports)
        .into_iter()
        .filter(|(n, off)| pts.iter().all(|p| p.dot(*n) <= off + 0.1))
        .collect();
    if groups.is_empty() || groups.len() > MAX_PLANES {
        return None;
    }
    let tool = wedge(&groups, &cut_set)?;
    let loss_cap = budget(&cut_set);
    // A plain cut: the cleaned operator merges coplanar faces everywhere and
    // would dissolve the band topology the next remnant is recognised by.
    let options = BooleanOptions {
        fuzzy: 1e-5,
        ..Default::default()
    };
    let op = BooleanOp::run(
        BooleanKind::Cut,
        [comp],
        [&tool],
        options,
        &ProgressRange::detached(),
    )
    .ok()?;
    let result = op.shape().ok()?;
    if kernel::is_null(&result) {
        return None;
    }
    let loss = kernel::volume(comp) - kernel::volume(&result);
    if loss <= 1e-9 || loss > loss_cap {
        return None;
    }
    if solids(&result).len() != solids(comp).len() {
        return None;
    }
    let target_fps: HashSet<String> = targets.iter().filter_map(fp).collect();
    let after = fps(&result);
    if !target_fps.is_empty() && target_fps.iter().all(|k| after.contains(k)) {
        return None;
    }
    if !result.is_valid().unwrap_or(false) {
        return None;
    }
    Some(one_or_compound(solids(&result)))
}

/// `_defeature`: stock removal, the whole blend chain, a wedge fill, a wedge cut.
fn defeature(shape: &Shape, faces: &[Shape]) -> FResult<Shape> {
    let (healed, mut alerts) = remove_features(shape, faces);
    if let Some(h) = healed {
        return Ok(h);
    }
    let chain = expand_blend_chain(shape, faces);
    let expanded = chain.len() > faces.len();
    if expanded {
        let (healed, more) = remove_features(shape, &chain);
        if let Some(h) = healed {
            return Ok(h);
        }
        alerts.extend(more);
    }
    let fbb = kernel::bbox(&kernel::compound(faces)).unwrap_or([0.0; 6]);
    let flat = (0..3)
        .map(|k| fbb[k + 3] - fbb[k])
        .fold(f64::INFINITY, f64::min)
        < 1e-6;
    if flat {
        if let Some(cut) = tool_cut(shape, faces) {
            return Ok(cut);
        }
    } else {
        let feature = if expanded { &chain[..] } else { faces };
        if let Some(filled) = tool_fill_all(shape, feature) {
            return Ok(filled);
        }
        if let Some(cut) = tool_cut(shape, faces) {
            return Ok(cut);
        }
    }
    let keys: BTreeSet<String> = alerts.into_iter().collect();
    let detail = if keys.is_empty() {
        String::new()
    } else {
        format!(
            " (OCCT: {})",
            keys.into_iter().collect::<Vec<_>>().join(", ")
        )
    };
    let tried = if expanded {
        format!(
            ", even removing its whole {}-face chamfer/fillet chain and wedge-filling the corner",
            chain.len()
        )
    } else {
        ", wedge-filling didn't apply either".to_owned()
    };
    Err(Fail::msg(format!(
        "can't heal after removing that face{tried}, use Press/Pull to cut it instead{detail}"
    )))
}

fn resolve_all(
    ctx: &mut Ctx,
    feature_id: &str,
    part: &Shape,
    sels: &[Selector],
) -> FResult<Vec<Shape>> {
    let mut out = Vec::new();
    for sel in sels {
        let v = serde_json::to_value(sel).map_err(|_| Fail::Internal("TypeError".into()))?;
        out.extend(Resolver::new(Some(&mut ctx.diagnostics), Some(feature_id)).faces(part, &v)?);
    }
    Ok(out)
}

fn bbox_distance(shape: &Shape, p: DVec3) -> f64 {
    let Some(bb) = kernel::bbox(shape) else {
        return f64::INFINITY;
    };
    let d = |lo: f64, v: f64, hi: f64| (lo - v).max(0.0).max(v - hi);
    let (dx, dy, dz) = (
        d(bb[0], p.x, bb[3]),
        d(bb[1], p.y, bb[4]),
        d(bb[2], p.z, bb[5]),
    );
    (dx * dx + dy * dy + dz * dz).sqrt()
}

/// `_retarget_delete_faces`: a nearest pick anchors the delete to the body
/// holding the face nearest its point, wherever the named id now points.
fn retarget(
    ctx: &mut Ctx,
    f: &DeleteFace,
    named: Option<usize>,
    sels: &[Selector],
) -> FResult<Option<(usize, Vec<Shape>)>> {
    let points: Vec<DVec3> = sels
        .iter()
        .filter_map(|s| serde_json::to_value(s).ok())
        .filter(|v| v.get("by").and_then(Value::as_str) == Some("nearest"))
        .filter_map(|v| {
            let p = v.get("point")?.as_array()?;
            (p.len() == 3).then(|| {
                dvec3(
                    p[0].as_f64().unwrap_or(0.0),
                    p[1].as_f64().unwrap_or(0.0),
                    p[2].as_f64().unwrap_or(0.0),
                )
            })
        })
        .collect();
    if points.is_empty() || ctx.bodies.is_empty() {
        let Some(named) = named else {
            return Ok(None);
        };
        let part = ctx.bodies[named].shape().clone();
        return Ok(Some((named, resolve_all(ctx, &f.id, &part, sels)?)));
    }
    let p0 = points[0];
    let mut order: Vec<(f64, usize)> = ctx
        .bodies
        .iter()
        .enumerate()
        .map(|(i, b)| (bbox_distance(b.shape(), p0), i))
        .collect();
    order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut winner: Option<(f64, usize)> = None;
    for (bd, i) in order {
        if winner.is_some_and(|w| bd >= w.0) {
            break;
        }
        let faces = kernel::subshapes(ctx.bodies[i].shape(), Kind::Face);
        let d = faces
            .iter()
            .map(|fc| sa::distance_to_point(fc, p0.to_array()).map(|r| r.0))
            .collect::<Option<Vec<f64>>>()
            .and_then(|ds| ds.into_iter().reduce(f64::min));
        let Some(d) = d else {
            continue;
        };
        if winner.map_or(true, |w| d < w.0) {
            winner = Some((d, i));
        }
    }
    let Some((_, target)) = winner else {
        return Ok(named.map(|n| (n, Vec::new())));
    };
    if let Some(n) = named.filter(|&n| n != target) {
        let reason = format!(
            "picked face found on {} (body ids shifted upstream); re-targeted from {}",
            ctx.bodies[target].id, ctx.bodies[n].id
        );
        ctx.diagnostics.push(json!({
            "feature_id": f.id,
            "kind": "deleteFace",
            "resolved": 1,
            "confidence": 0.8,
            "lossy": true,
            "reason": reason,
        }));
    }
    let part = ctx.bodies[target].shape().clone();
    Ok(Some((target, resolve_all(ctx, &f.id, &part, sels)?)))
}

pub fn delete_face(ctx: &mut Ctx, f: &DeleteFace) -> FResult {
    let named = match f.body.as_deref().filter(|b| !b.is_empty()) {
        Some(id) => ctx.find_body(id),
        None => Some(ctx.require_active("Delete Face")?),
    };
    let sels = f.face.as_slice().to_vec();
    let Some((act, faces)) = retarget(ctx, f, named, &sels)? else {
        return Err(Fail::msg("Delete Face: the target body no longer exists"));
    };
    if faces.is_empty() {
        return Err(Fail::msg("no face found to delete"));
    }
    let healed = defeature(ctx.bodies[act].shape(), &faces)?;
    ctx.set_shape(act, healed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corner_chamfered() -> Shape {
        let b = Shape::box_centered(20.0, 20.0, 20.0);
        let corner = dvec3(10.0, 10.0, 10.0);
        let edges: Vec<_> = b
            .edges()
            .filter(|e| {
                (e.start_point() - corner).length() < 1e-6
                    || (e.end_point() - corner).length() < 1e-6
            })
            .collect();
        b.chamfer_edges(2.0, edges)
    }

    fn smallest_face(s: &Shape) -> Shape {
        let mut faces = kernel::subshapes(s, Kind::Face);
        faces.sort_by(|a, b| kernel::area(a).total_cmp(&kernel::area(b)));
        faces.remove(0)
    }

    // The numbers the Python engine's `test_smoke.py` test_tool_fill and
    // test_defeature_chain assert on the Python rungs.
    #[test]
    fn a_corner_chain_fills_back_to_the_box() {
        let part = corner_chamfered();
        assert_eq!(kernel::count(&part, Kind::Face), 10);
        let chain = expand_blend_chain(&part, &[smallest_face(&part)]);
        assert_eq!(chain.len(), 4);
        assert!(chain.iter().all(|f| width(f) < 3.0));
        let filled = tool_fill_all(&part, &chain).expect("the corner fills");
        assert!(
            (kernel::volume(&filled) - 8000.0).abs() < 0.01,
            "{}",
            kernel::volume(&filled)
        );

        let healed = defeature(&part, &chain).expect("the chain heals");
        assert_eq!(kernel::count(&healed, Kind::Face), 6);
        assert!((kernel::volume(&healed) - 8000.0).abs() < 1.0);
    }

    #[test]
    fn an_unbounded_wound_is_not_filled_and_a_hole_in_the_wedge_survives() {
        let b = Shape::box_centered(20.0, 20.0, 20.0);
        let top = kernel::subshapes(&b, Kind::Face)
            .into_iter()
            .max_by(|x, y| centre(x).z.total_cmp(&centre(y).z))
            .unwrap();
        assert!(tool_fill_all(&b, &[top]).is_none());

        let part = corner_chamfered();
        let pin =
            kernel::translated(&kernel::make_cylinder(1.5, 2.0).unwrap(), [5.0, 5.0, 9.0]).unwrap();
        let holed = kernel::boolean_op(&part, &[&pin], BoolKind::Cut).unwrap();
        let hole_void = kernel::volume(&part) - kernel::volume(&holed);
        let chain = expand_blend_chain(&holed, &[smallest_face(&holed)]);
        let filled = tool_fill_all(&holed, &chain).expect("the corner fills around the hole");
        assert!(
            (kernel::volume(&filled) - (8000.0 - hole_void)).abs() < 0.05,
            "{}",
            kernel::volume(&filled)
        );
    }
}
