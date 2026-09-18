//! Simplify Mesh and Clean Up: the Python engine's `solid_ops.py` `_simplify_mesh` and the
//! `_refacet_clean` then `_unify_body` pass of the Python engine's `shape_util.py`.

use std::collections::HashMap;

use fundacad_core::schema::{CleanUp, SimplifyMesh};
use glam::{dvec3, DVec3};
use opencascade::modify::UnifyOptions;
use opencascade::primitives::{Shape, ShapeType, SurfaceType};

use super::not_ported;
use super::solid_ops::surface_type;
use crate::builder::{Ctx, FResult};
use crate::kernel::{self, Kind};
use crate::select::entity::FaceEnt;

/// `_simplify_mesh`: coplanar facets merged under a widened angular tolerance.
fn simplify(shape: &Shape, tol_deg: f64) -> Shape {
    let options = UnifyOptions {
        concat_bsplines: true,
        angular_tolerance: if tol_deg > 0.0 {
            tol_deg.to_radians()
        } else {
            0.0
        },
        ..Default::default()
    };
    match shape.unify_same_domain(options, &[]) {
        Ok(u) if !kernel::is_null(&u.shape) => u.shape,
        _ => shape.clone(),
    }
}

pub fn simplify_mesh(ctx: &mut Ctx, f: &SimplifyMesh) -> FResult {
    let act = ctx.require_active("Simplify Mesh")?;
    let tol = ctx.val(&f.tolerance)?;
    let out = simplify(ctx.bodies[act].shape(), tol);
    ctx.set_shape(act, out);
    Ok(())
}

/// `_explode_solids`: one piece per solid, per shell of a multi-shell solid,
/// and per loose non-solid child.
fn pieces(shape: &Shape) -> Vec<Shape> {
    let solids = kernel::subshapes(shape, Kind::Solid);
    if solids.is_empty() {
        return vec![shape.clone()];
    }
    let mut out = Vec::new();
    for s in solids {
        let shells = kernel::subshapes(&s, Kind::Shell);
        if shells.len() <= 1 {
            out.push(s);
        } else {
            out.extend(shells);
        }
    }
    if shape.shape_type() == ShapeType::Compound {
        out.extend(
            kernel::children(shape)
                .into_iter()
                .filter(|c| kernel::count(c, Kind::Solid) == 0),
        );
    }
    out
}

fn vertices(face: &Shape) -> Vec<DVec3> {
    kernel::subshapes(face, Kind::Vertex)
        .iter()
        .filter_map(kernel::bbox)
        .map(|b| dvec3(b[0], b[1], b[2]))
        .collect()
}

/// Whether `_refacet_clean` would merge any faces: region growth from the
/// largest faces over edge neighbours whose vertices all lie within `tol` of
/// the anchor's plane.
fn has_debris(shape: &Shape, tol: f64) -> bool {
    let fmap = shape.shape_map(ShapeType::Face);
    let emap = shape.ancestor_map(ShapeType::Edge, ShapeType::Face);
    let n = fmap.len();
    let faces: Vec<Shape> = (1..=n).filter_map(|i| fmap.get(i)).collect();
    if faces.len() != n {
        return false;
    }
    let neighbours = |i: usize| -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        for e in faces[i - 1].subshapes(ShapeType::Edge) {
            for other in emap.ancestors(&e) {
                let j = fmap.index_of(&other);
                if j != i && !out.contains(&j) {
                    out.push(j);
                }
            }
        }
        out
    };
    let areas: Vec<f64> = faces.iter().map(kernel::area).collect();
    let mut order: Vec<usize> = (1..=n).collect();
    order.sort_by(|a, b| areas[b - 1].total_cmp(&areas[a - 1]));
    let mut region: HashMap<usize, usize> = HashMap::new();
    let mut planes = 0;
    for i in order {
        if region.contains_key(&i) {
            continue;
        }
        let Ok(ent) = FaceEnt::new(faces[i - 1].clone()) else {
            return false;
        };
        let (p0, nn) = (ent.centroid(), ent.normal());
        let rid = planes;
        planes += 1;
        region.insert(i, rid);
        let mut queue = vec![i];
        while let Some(k) = queue.pop() {
            for j in neighbours(k) {
                if region.contains_key(&j) {
                    continue;
                }
                let d = vertices(&faces[j - 1])
                    .iter()
                    .map(|v| (*v - p0).dot(nn).abs())
                    .fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x))));
                if d.is_some_and(|d| d <= tol) {
                    region.insert(j, rid);
                    queue.push(j);
                }
            }
        }
    }
    planes < n
}

/// `_refacet_clean`, for the shapes it leaves as they are. A faceted body with
/// sliver debris would be rebuilt from its snapped mesh, which is not ported.
fn refacet_clean(shape: &Shape, tol: f64) -> FResult<Shape> {
    let faces = kernel::subshapes(shape, Kind::Face);
    if faces.is_empty()
        || faces
            .iter()
            .any(|f| surface_type(f) != Some(SurfaceType::Plane))
    {
        return Ok(shape.clone());
    }
    let parts = pieces(shape);
    let dirty = if parts.len() > 1 {
        parts.iter().any(|p| has_debris(p, tol))
    } else {
        has_debris(shape, tol)
    };
    if dirty {
        return Err(not_ported("cleanUp of a faceted body"));
    }
    Ok(shape.clone())
}

pub fn clean_up(ctx: &mut Ctx, f: &CleanUp) -> FResult {
    let named = f.body.as_deref().filter(|b| !b.is_empty());
    let targets: Vec<Option<usize>> = match named {
        Some(id) => vec![ctx.find_body(id)],
        None => (0..ctx.bodies.len()).map(Some).collect(),
    };
    for target in targets {
        match target {
            Some(i) => {
                let tol = ctx.val_or(f.tolerance.as_ref(), 0.12)?;
                let refaceted = refacet_clean(ctx.bodies[i].shape(), tol)?;
                ctx.set_shape(i, kernel::unify_body(&refaceted));
            }
            None => ctx.skip_feature(&f.id, "cleanUp", "target body already consumed or missing"),
        }
    }
    Ok(())
}
