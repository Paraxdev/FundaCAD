//! Split a body by a plane and Divide a face by sketch curves:
//! sidecar/booleans.py `_do_split` and sidecar/solid_ops.py `_imprint` with
//! the handlers of sidecar/builder.py.

use std::collections::HashMap;

use fundacad_core::schema::{Imprint, Split};
use glam::DVec3;
use opencascade::boolean_op::{BooleanKind, BooleanOp, BooleanOptions};
use opencascade::primitives::{Shape, ShapeType};
use opencascade::progress::ProgressRange;

use super::sketch::require;
use crate::builder::plane::{plane_of, PlaneRef};
use crate::builder::{Ctx, FResult, Fail};
use crate::kernel::{self, Frame, Kind};
use crate::select::Resolver;

fn leaves(shape: &Shape, out: &mut Vec<Shape>) {
    if shape.shape_type() == ShapeType::Compound {
        for c in kernel::children(shape) {
            leaves(&c, out);
        }
    } else {
        out.push(shape.clone());
    }
}

/// build123d `Shape.split(Plane)`: the pieces on the plane's normal side, and the rest.
pub(crate) fn split_by_plane(
    shape: &Shape,
    origin: DVec3,
    normal: DVec3,
    xdir: DVec3,
) -> FResult<(Vec<Shape>, Vec<Shape>)> {
    let internal = |e: opencascade::Error| Fail::Internal(super::solid_ops::occt_class(&e));
    let tool = Shape::plane_face(origin, normal, xdir).map_err(internal)?;
    let op = BooleanOp::run(
        BooleanKind::Split,
        [shape],
        [&tool],
        BooleanOptions::default(),
        &ProgressRange::detached(),
    )
    .map_err(internal)?;
    let mut parts = Vec::new();
    leaves(&op.shape().map_err(internal)?, &mut parts);
    let (mut tops, mut bottoms) = (Vec::new(), Vec::new());
    for p in parts {
        let c = kernel::center_of_mass(&p).map_or(DVec3::ZERO, DVec3::from);
        if (c - origin).dot(normal) >= 0.0 {
            tops.push(p);
        } else {
            bottoms.push(p);
        }
    }
    Ok((tops, bottoms))
}

fn v(a: [f64; 3]) -> DVec3 {
    DVec3::from(a)
}

/// `_vertex_components`: solids grouped by shared (rounded) vertices.
fn vertex_components(solids: &[Shape]) -> Vec<Vec<Shape>> {
    let n = solids.len();
    if n <= 1 {
        return if n == 1 {
            vec![solids.to_vec()]
        } else {
            Vec::new()
        };
    }
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let round3 = |x: f64| (x * 1000.0).round() as i64;
    let mut vmap: Vec<((i64, i64, i64), Vec<usize>)> = Vec::new();
    let mut index: HashMap<(i64, i64, i64), usize> = HashMap::new();
    for (i, s) in solids.iter().enumerate() {
        for vtx in kernel::subshapes(s, Kind::Vertex) {
            let Some(b) = kernel::bbox(&vtx) else {
                continue;
            };
            let key = (round3(b[0]), round3(b[1]), round3(b[2]));
            let slot = *index.entry(key).or_insert_with(|| {
                vmap.push((key, Vec::new()));
                vmap.len() - 1
            });
            vmap[slot].1.push(i);
        }
    }
    for (_, idxs) in &vmap {
        for &j in &idxs[1..] {
            let a = find(&mut parent, idxs[0]);
            let b = find(&mut parent, j);
            parent[a] = b;
        }
    }
    let mut order: Vec<usize> = Vec::new();
    let mut groups: HashMap<usize, Vec<Shape>> = HashMap::new();
    for (i, s) in solids.iter().enumerate() {
        let root = find(&mut parent, i);
        if !groups.contains_key(&root) {
            order.push(root);
        }
        groups.entry(root).or_default().push(s.clone());
    }
    order
        .into_iter()
        .filter_map(|r| groups.remove(&r))
        .collect()
}

fn one_or_compound(g: &[Shape]) -> Shape {
    if g.len() == 1 {
        g[0].clone()
    } else {
        kernel::compound(g)
    }
}

pub fn split(ctx: &mut Ctx, f: &Split) -> FResult {
    let plane: Frame = match f.plane_id.as_deref().filter(|p| !p.is_empty()) {
        Some(id) => plane_of(PlaneRef::Name(id), &ctx.datums)?,
        None => match &f.plane {
            Some(spec) => plane_of(PlaneRef::from(spec), &ctx.datums)?,
            None => return Err(Fail::Missing("plane".into())),
        },
    };
    let keep = f.keep.as_str().to_owned();
    if !["top", "bottom", "both"].contains(&keep.as_str()) {
        return Err(Fail::msg(format!("unknown split keep mode: {keep}")));
    }
    let targets: Vec<usize> = match f.bodies.as_ref().filter(|b| !b.is_empty()) {
        Some(ids) => ids.iter().filter_map(|b| ctx.find_body(b)).collect(),
        None => match f.body.as_deref().filter(|b| !b.is_empty()) {
            Some(id) => ctx.find_body(id).into_iter().collect(),
            None => ctx.bodies.len().checked_sub(1).into_iter().collect(),
        },
    };
    if targets.is_empty() {
        return Err(Fail::msg("Split needs an existing body"));
    }
    let (origin, normal, xdir) = (v(plane.origin), v(plane.z), v(plane.x));
    let single = targets.len() == 1;
    for target in targets {
        let (tops, bottoms) = split_by_plane(ctx.bodies[target].shape(), origin, normal, xdir)?;
        let kept: Vec<Shape> = match keep.as_str() {
            "top" => tops,
            "bottom" => bottoms,
            _ => tops.into_iter().chain(bottoms).collect(),
        };
        let res = kernel::compound(&kept);
        let pieces = kernel::subshapes(&res, Kind::Solid);
        if keep == "both" && pieces.len() > 1 {
            if f.group_sides.unwrap_or(false) {
                let side = |p: &Shape| {
                    let c = kernel::center_of_mass(p).map_or(DVec3::ZERO, DVec3::from);
                    (c - origin).dot(normal) >= 0.0
                };
                let top: Vec<Shape> = pieces.iter().filter(|p| side(p)).cloned().collect();
                let bottom: Vec<Shape> = pieces.iter().filter(|p| !side(p)).cloned().collect();
                let mut groups = vertex_components(&top);
                groups.extend(vertex_components(&bottom));
                if groups.is_empty() {
                    ctx.set_shape(target, res);
                } else {
                    ctx.set_shape(target, one_or_compound(&groups[0]));
                    for g in &groups[1..] {
                        ctx.new_body(one_or_compound(g), Some("Split".into()), None);
                    }
                }
            } else {
                ctx.set_shape(target, pieces[0].clone());
                for p in &pieces[1..] {
                    ctx.new_body(p.clone(), Some("Split".into()), None);
                }
            }
        } else if pieces.is_empty() {
            if single {
                return Err(Fail::msg("the plane does not intersect the body"));
            }
        } else {
            ctx.set_shape(target, res);
        }
    }
    Ok(())
}

/// `_imprint_target`: the named body, else the one the sketch's face lies on,
/// else the active body.
fn imprint_target(ctx: &Ctx, f: &Imprint) -> FResult<Option<usize>> {
    if let Some(id) = f.body.as_deref().filter(|b| !b.is_empty()) {
        return Ok(ctx.find_body(id));
    }
    if let Some(sel) = ctx.sketches.get(&f.sketch).and_then(|e| e.face.clone()) {
        let v = serde_json::to_value(&sel).map_err(|_| Fail::Internal("TypeError".into()))?;
        for (i, b) in ctx.bodies.iter().enumerate() {
            let found = Resolver::new(None, Some(&f.id)).faces(b.shape(), &v);
            if found.is_ok_and(|faces| !faces.is_empty()) {
                return Ok(Some(i));
            }
        }
    }
    ctx.require_active("Divide").map(Some)
}

pub fn imprint(ctx: &mut Ctx, f: &Imprint) -> FResult {
    let edges = require(ctx, &f.sketch, "divide")?.edges.clone();
    if edges.is_empty() {
        ctx.skip_feature(
            &f.id,
            "imprint",
            "this sketch has no curves to divide a face with",
        );
        return Ok(());
    }
    let Some(act) = imprint_target(ctx, f)? else {
        return Err(Fail::msg(
            "Divide: the face to split is no longer in the model",
        ));
    };
    let shape = ctx.bodies[act].shape().clone();
    let before = kernel::count(&shape, Kind::Face);
    let options = BooleanOptions {
        non_destructive: true,
        ..Default::default()
    };
    let op = BooleanOp::run(
        BooleanKind::Split,
        [&shape],
        edges.iter(),
        options,
        &ProgressRange::detached(),
    )
    .map_err(|_| Fail::msg("Divide: the sketch curves could not be imprinted onto the face"))?;
    let out = op
        .shape()
        .ok()
        .filter(|s| !kernel::is_null(s))
        .unwrap_or(shape);
    let after = kernel::count(&out, Kind::Face);
    ctx.set_shape(act, out);
    if after <= before {
        ctx.skip_feature(
            &f.id,
            "imprint",
            "these curves don't divide the face, extend them across it to its edges",
        );
    }
    Ok(())
}
