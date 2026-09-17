//! Merging a new solid into the model and body to body booleans:
//! sidecar/handler_util.py `_combine` and sidecar/booleans.py
//! `_boolean_into_bodies`, `_do_boolean`, `_noop_eps`, `_sealed_void_diag`.

use std::collections::HashSet;

use fundacad_core::schema::{BooleanFeature, Operation};
use opencascade::primitives::Shape;
use serde_json::json;

use crate::builder::{Ctx, FResult, Fail};
use crate::kernel::{self, BoolKind};

/// A change smaller than this counts as nothing happening.
fn noop_eps(reference: f64) -> f64 {
    1e-6f64.max(1e-4 * reference)
}

fn vol(s: &Shape) -> f64 {
    if kernel::is_null(s) {
        return 0.0;
    }
    kernel::volume(s).abs()
}

fn overlap(a: Option<[f64; 6]>, b: Option<[f64; 6]>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    let tol = 1e-6;
    a[0] <= b[3] + tol
        && a[3] >= b[0] - tol
        && a[1] <= b[4] + tol
        && a[4] >= b[1] - tol
        && a[2] <= b[5] + tol
        && a[5] >= b[2] - tol
}

/// `_combine`: merge a solid a feature made the way its `operation` and
/// `targets` ask. `name` labels a new body; a join keeps its target's name.
pub fn combine(
    ctx: &mut Ctx,
    feature_id: &str,
    solid: Shape,
    operation: Option<&Operation>,
    targets: Option<&[String]>,
    hidden: Option<HashSet<String>>,
    name: Option<&str>,
) -> FResult {
    let op = operation.map_or("new", Operation::as_str);
    let hidden = hidden.unwrap_or_else(|| ctx.hidden_bodies.clone());
    let targets = targets.filter(|t| !t.is_empty());
    let name = name.map(str::to_owned);
    if op == "new" {
        ctx.new_body(solid, name, None);
        return Ok(());
    }
    let mut candidates: Vec<usize> = (0..ctx.bodies.len()).collect();
    if let Some(targets) = targets {
        let have: HashSet<&str> = ctx.bodies.iter().map(|b| b.id.as_str()).collect();
        let mut missing: Vec<&str> = targets
            .iter()
            .map(String::as_str)
            .filter(|t| !have.contains(t))
            .collect();
        missing.sort_unstable();
        missing.dedup();
        if !missing.is_empty() {
            return Err(Fail::msg(format!(
                "no body called {} exists at this point in the timeline, check the ids against the last build.",
                missing.join(", ")
            )));
        }
        candidates.retain(|&i| targets.contains(&ctx.bodies[i].id));
    }
    let solid_box = kernel::bbox(&solid);
    let hits: Vec<usize> = candidates
        .into_iter()
        .filter(|&i| {
            let b = &ctx.bodies[i];
            !hidden.contains(&b.id) && overlap(kernel::bbox(b.shape()), solid_box)
        })
        .collect();
    let prism_vol = vol(&solid);

    match op {
        "join" => {
            if hits.is_empty() {
                if let Some(targets) = targets {
                    return Err(Fail::msg(format!(
                        "Join failed: nothing to join to. This feature targets {}, and the new shape does not reach it.",
                        targets.join(", ")
                    )));
                }
                ctx.new_body(solid, name, None);
                return Ok(());
            }
            let mut merged = solid.clone();
            for &i in &hits {
                merged = kernel::serial_bool(&merged, &[ctx.bodies[i].shape()], BoolKind::Fuse)?;
            }
            let merged_vol = vol(&merged);
            let hit_vol: f64 = hits.iter().map(|&i| vol(ctx.bodies[i].shape())).sum();
            // The sliced retry of booleans.py `_retried_in_slices` is not ported,
            // so a fuse the kernel got wrong keeps the refusal it falls back to.
            if merged_vol < hit_vol - noop_eps(hit_vol) {
                return Err(Fail::msg(
                    "Join failed: the result came out smaller than the body it started from. That usually means the two shapes touch along a surface instead of overlapping. Move the profile so it reaches a little way into the body.",
                ));
            } else if merged_vol <= hit_vol + noop_eps(prism_vol) {
                return Err(Fail::msg(
                    "Join added no material, the profile is already inside the body. Did you mean Cut?",
                ));
            }
            let first_name = ctx.bodies[hits[0]].name.clone();
            let first_id = ctx.bodies[hits[0]].id.clone();
            let consumed: HashSet<String> =
                hits.iter().map(|&i| ctx.bodies[i].id.clone()).collect();
            ctx.remove_bodies(&consumed);
            ctx.new_body(
                kernel::unify_body(&merged),
                Some(first_name),
                Some(&first_id),
            );
            Ok(())
        }
        "cut" => {
            let mut results: Vec<(usize, Shape)> = Vec::new();
            let mut removed = 0.0;
            let mut sealed = false;
            for &i in &hits {
                let b = &ctx.bodies[i];
                let before = vol(b.shape());
                let voids_before = kernel::void_count(b.shape());
                let newshape = kernel::serial_bool(b.shape(), &[&solid], BoolKind::Cut)?;
                let after = vol(&newshape);
                if kernel::void_count(&newshape) > voids_before {
                    sealed = true;
                }
                if after < noop_eps(before) {
                    let label = if b.name.is_empty() {
                        "this body"
                    } else {
                        b.name.as_str()
                    };
                    return Err(Fail::msg(format!(
                        "Cut would remove all of {label}. Shorten it, or select a smaller area."
                    )));
                }
                removed += (before - after).max(0.0);
                results.push((i, newshape));
            }
            if hits.is_empty() || removed < noop_eps(prism_vol) {
                return Err(Fail::msg(
                    "Cut removed nothing, the extrude doesn't reach any body. Drag the other way, or use Join.",
                ));
            }
            for (i, shape) in results {
                ctx.set_shape(i, shape);
            }
            if sealed {
                let mut entry = json!({
                    "feature_id": feature_id,
                    "kind": "sealedVoid",
                    "resolved": 0,
                    "confidence": 0.0,
                    "lossy": false,
                    "reason": "This cut closed a cavity inside the body instead of opening its surface. Extrude it further, or make it symmetric.",
                    "code": "sealedVoid",
                });
                if let Some(c) = kernel::center_of_mass(&solid) {
                    let r6 = |v: f64| (v * 1e6).round() / 1e6;
                    entry["at"] = json!([r6(c[0]), r6(c[1]), r6(c[2])]);
                }
                ctx.diagnostics.push(entry);
            }
            Ok(())
        }
        "intersect" => {
            if hits.is_empty() {
                return Err(Fail::msg(
                    "Intersect left nothing, the profile doesn't overlap any body.",
                ));
            }
            let mut results: Vec<(usize, Shape)> = Vec::new();
            for &i in &hits {
                let b = &ctx.bodies[i];
                let newshape = kernel::serial_bool(b.shape(), &[&solid], BoolKind::Common)?;
                if vol(&newshape) < noop_eps(vol(b.shape())) {
                    return Err(Fail::msg(
                        "Intersect would leave the body empty, the profile doesn't overlap it.",
                    ));
                }
                results.push((i, newshape));
            }
            for (i, shape) in results {
                ctx.set_shape(i, shape);
            }
            Ok(())
        }
        other => Err(Fail::msg(format!("unknown extrude operation: {other}"))),
    }
}

/// `_do_boolean`: the target keeps its id, tools are consumed unless kept.
pub fn do_boolean(ctx: &mut Ctx, f: &BooleanFeature) -> FResult {
    let op = f.operation.as_str();
    let (kind, label) = match op {
        "union" | "join" => (BoolKind::Fuse, "Union"),
        "subtract" | "cut" => (BoolKind::Cut, "Subtract"),
        "intersect" => (BoolKind::Common, "Intersect"),
        _ => return Err(Fail::msg(format!("unknown boolean operation: {op}"))),
    };
    let target = match f.target.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => ctx.find_body(t),
        None => (!ctx.bodies.is_empty()).then_some(0),
    };
    let Some(target) = target else {
        ctx.skip_feature(&f.id, "boolean", "target body already consumed or missing");
        return Ok(());
    };
    let target_id = ctx.bodies[target].id.clone();
    let tool_ids: Vec<String> = match f.tools.as_ref().filter(|t| !t.is_empty()) {
        Some(t) => t.clone(),
        None => ctx
            .bodies
            .iter()
            .filter(|b| b.id != target_id)
            .map(|b| b.id.clone())
            .collect(),
    };
    let tools: Vec<usize> = tool_ids
        .iter()
        .filter_map(|id| ctx.find_body(id))
        .filter(|&i| ctx.bodies[i].id != target_id)
        .collect();
    if tools.is_empty() {
        ctx.skip_feature(&f.id, "boolean", "tool bodies already consumed or missing");
        return Ok(());
    }
    let before = vol(ctx.bodies[target].shape());
    let mut shape = ctx.bodies[target].shape().clone();
    for &t in &tools {
        shape = kernel::serial_bool(&shape, &[ctx.bodies[t].shape()], kind)?;
    }
    let after = vol(&shape);
    let eps = noop_eps(before);
    if kind == BoolKind::Cut && after >= before - eps {
        return Err(Fail::msg(format!(
            "{label} removed nothing, no tool body overlaps the one being kept."
        )));
    }
    if kind == BoolKind::Cut && after < eps {
        return Err(Fail::msg(format!(
            "{label} would remove the whole body, the tools cover all of it."
        )));
    }
    if kind == BoolKind::Common && after < eps {
        return Err(Fail::msg(format!(
            "{label} would leave nothing, the tools don't overlap the body."
        )));
    }
    let shape = if kind == BoolKind::Fuse {
        kernel::unify_body(&shape)
    } else {
        shape
    };
    ctx.set_shape(target, shape);
    let keep_tools = f.extra.get("keepTools").is_some_and(truthy);
    if !(f.keep_originals.unwrap_or(false) || keep_tools) {
        let consumed: HashSet<String> = tools.iter().map(|&i| ctx.bodies[i].id.clone()).collect();
        ctx.remove_bodies(&consumed);
    }
    Ok(())
}

fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Array(a) => !a.is_empty(),
        serde_json::Value::Object(o) => !o.is_empty(),
    }
}
