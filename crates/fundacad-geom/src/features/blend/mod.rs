//! Fillets and chamfers, the Python engine's `blends.py` and the fillet and chamfer handlers
//! of the Python engine's `builder.py`.
//!
//! One kernel call on the whole group first, on a copy of the body. When that
//! refuses, the edges are blended one at a time on the evolving body in a
//! canonical order; an edge that still refuses fails the whole feature with a
//! sentence that says whether a smaller size would have built.

pub mod eval;
pub mod ops;
pub mod overlap;

use fundacad_core::schema::{Chamfer, Fillet, OneOrMany, Selector};
use glam::DVec3;
use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

use crate::builder::{py_g, Ctx, FResult, Fail};
use crate::select::entity::{edge_cost, edges_of, py_round, EdgeEnt};
use crate::select::{self, Resolver, Tuning};
use ops::Built;

pub const BLEND_TOO_LARGE: &str = "blendTooLarge";
pub const BLEND_HAS_NO_END: &str = "blendHasNoEnd";
pub const EDGE_ALREADY_SMOOTH: &str = "edgeAlreadySmooth";
pub const EDGE_IS_SEAM: &str = "edgeIsSeam";
pub const BLEND_FOLDS_OVER: &str = "blendFoldsOver";

const SMOOTH_EDGE_DEG: f64 = 1.0;
const SIZE_PROBE_FRACTION: f64 = 0.05;
const SIZE_PROBE_BODY_FRACTION: f64 = 1e-3;
const PROFILE_LIMIT: f64 = 0.99;
const PROFILE_EPS: f64 = 1e-6;

/// Why one kernel attempt did not build, as the Python exception reads.
#[derive(Debug, Clone)]
pub enum BlendErr {
    Kernel(String),
    /// conic_blend.py `ConicNotApplicable`: the profile, not the blend, refused.
    Conic(String),
}

impl BlendErr {
    fn text(&self) -> &str {
        match self {
            BlendErr::Kernel(s) | BlendErr::Conic(s) => s,
        }
    }
}

/// `(shape, edges, size)`: one kernel blend.
type BlendOp<'a> = dyn Fn(&Shape, &[Shape], f64) -> Result<Shape, BlendErr> + 'a;
type SectionOp<'a> = dyn Fn(&Shape, &[Shape]) -> Result<Shape, SectionErr> + 'a;

/// Why the lofted section blend did not build.
#[derive(Debug, Clone)]
pub enum SectionErr {
    /// section_blend.py `SectionBlendError`, a sentence.
    Blend(String),
    /// A plain `ValueError` on the way out.
    Value(String),
    /// An OpenCASCADE exception, by class.
    Internal(String),
    /// The job was cancelled while it ran.
    Cancelled,
}

/// Stop here when the job was cancelled. The builder drops whatever a
/// cancelled feature returns, so the failure only has to end the work.
fn checkpoint() -> FResult {
    if crate::cancel::requested() {
        return Err(Fail::msg("cancelled"));
    }
    Ok(())
}

fn value_err(message: impl Into<String>, code: Option<&'static str>) -> Fail {
    Fail::Value {
        message: message.into(),
        code,
    }
}

/// conic_blend.py `clamp_profile`.
pub fn clamp_profile(p: f64) -> f64 {
    if p.is_nan() {
        0.0
    } else {
        p.clamp(-PROFILE_LIMIT, PROFILE_LIMIT)
    }
}

pub fn fillet(ctx: &mut Ctx, f: &Fillet) -> FResult {
    let r = ctx.val(&f.radius)?;
    let p = match &f.profile {
        Some(n) => clamp_profile(ctx.val(n)?),
        None => 0.0,
    };
    let g2 = f.continuity.as_deref() == Some("G2");
    let chord = f.size_type.as_deref() == Some("chord");
    let only_picked = f.tangent_edges == Some(false);
    let draft = f.draft == Some(true);

    let op =
        move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, BlendErr> {
            let radii: Vec<f64> = es
                .iter()
                .map(|e| {
                    if chord {
                        chord_radius(s, e, size)
                    } else {
                        size
                    }
                })
                .collect();
            native_fillet(s, es, &radii)
        };
    let section_at = move |profile: f64| {
        move |s: &Shape, es: &[Shape]| -> Result<Shape, SectionErr> {
            let sizes: Vec<f64> = es
                .iter()
                .map(|e| if chord { chord_radius(s, e, r) } else { r })
                .collect();
            ops::section(s, es, false, &sizes, None, g2, draft, profile)
        }
    };
    let section = section_at(p);

    if g2 || only_picked || p.abs() < PROFILE_EPS {
        return blend_edges(
            ctx,
            &f.id,
            &f.edges,
            "Fillet",
            &op,
            r,
            draft,
            Some(&section),
            g2 || only_picked,
        );
    }
    let conic =
        move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, BlendErr> {
            ops::conic(s, es, size, p)
        };
    match blend_edges(
        ctx,
        &f.id,
        &f.edges,
        "Fillet",
        &conic,
        r,
        draft,
        Some(&section),
        false,
    ) {
        Err(Fail::Value {
            message,
            code: Some(CONIC_NOT_APPLICABLE),
        }) => {
            let _ = message;
            match blend_edges(
                ctx,
                &f.id,
                &f.edges,
                "Fillet",
                &op,
                r,
                draft,
                Some(&section),
                true,
            ) {
                Ok(()) => Ok(()),
                Err(_) => {
                    let section = section_at(0.0);
                    blend_edges(
                        ctx,
                        &f.id,
                        &f.edges,
                        "Fillet",
                        &op,
                        r,
                        draft,
                        Some(&section),
                        false,
                    )?;
                    note_profile_fallback(ctx, &f.id);
                    Ok(())
                }
            }
        }
        other => other,
    }
}

/// Internal marker for `ConicNotApplicable` between `blend_edges` and the fillet handler.
const CONIC_NOT_APPLICABLE: &str = "conicNotApplicable";

/// `_note_profile_fallback`: an advisory, the fillet built with a plain section.
fn note_profile_fallback(ctx: &mut Ctx, fid: &str) {
    ctx.diagnostics.push(json!({
        "feature_id": fid,
        "kind": "edge",
        "resolved": 1,
        "confidence": 1.0,
        "lossy": false,
        "reason": "the variable profile can't wrap this junction, so the fillet used its plain rounded section here",
    }));
}

pub fn chamfer(ctx: &mut Ctx, f: &Chamfer) -> FResult {
    let d = ctx.val(&f.distance)?;
    let d2 = match (&f.chamfer_type, &f.distance2) {
        (Some(t), Some(n)) if t == "twoDistance" => Some(ctx.val(n)?),
        _ => None,
    };
    let draft = f.draft == Some(true);
    // The Python engine's combined equal chamfer always refused ("Nothing to
    // chamfer", build123d found no solid for the copied edges), so every corner
    // was cut one edge at a time and came out pointed. Cut together, three
    // edges meeting at a corner end in one triangle.
    let op = move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, BlendErr> {
        match d2 {
            None => build123d_chamfer(s, es, size),
            Some(d2) => native_two_distance_chamfer(s, es, size, d2 * size / d),
        }
    };
    let section = move |s: &Shape, es: &[Shape]| -> Result<Shape, SectionErr> {
        ops::section(s, es, true, &vec![d; es.len()], d2, false, draft, 0.0)
    };
    blend_edges(
        ctx,
        &f.id,
        &f.edges,
        "Chamfer",
        &op,
        d,
        draft,
        Some(&section),
        f.tangent_edges == Some(false),
    )
}

/// `_DRAFT_FELL_BACK`: drags that needed the section build, with the smallest
/// size they needed it at.
///
/// Keyed by size, unlike blends.py: a drag that fell back at 43.7 mm and then
/// came down to 3 mm went straight to the section build, which the kernel's
/// own filleter would have answered at once, and the section build's boolean
/// can hang outright on such a small conic blend.
static DRAFT_FELL_BACK: std::sync::Mutex<Vec<(String, f64)>> = std::sync::Mutex::new(Vec::new());

fn fell_back_before(key: &str, size: f64) -> bool {
    DRAFT_FELL_BACK
        .lock()
        .map(|v| v.iter().any(|(k, at)| k == key && size >= *at))
        .unwrap_or(false)
}

fn remember_fell_back(key: String, size: f64) {
    if let Ok(mut v) = DRAFT_FELL_BACK.lock() {
        match v.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = entry.1.min(size),
            None => v.push((key, size)),
        }
    }
}

/// blends.py `native_fillet`.
fn native_fillet(s: &Shape, es: &[Shape], radii: &[f64]) -> Result<Shape, BlendErr> {
    const MSG: &str = "Failed creating a fillet, try a smaller value";
    match ops::fillet(s, es, radii) {
        Ok((out, Built::Done)) => Ok(out),
        Ok(_) => Err(BlendErr::Kernel(MSG.into())),
        Err(e) => Err(BlendErr::Kernel(e)),
    }
}

/// build123d `chamfer(edges, length)`: every kernel failure reads the same.
fn build123d_chamfer(s: &Shape, es: &[Shape], size: f64) -> Result<Shape, BlendErr> {
    let d = vec![size; es.len()];
    match ops::chamfer(s, es, &d, &d) {
        Ok((out, Built::Done)) => Ok(out),
        _ => Err(BlendErr::Kernel(
            "Failed creating a chamfer, try a smaller length value(s)".into(),
        )),
    }
}

/// blends.py `native_two_distance_chamfer`.
fn native_two_distance_chamfer(
    s: &Shape,
    es: &[Shape],
    d1: f64,
    d2: f64,
) -> Result<Shape, BlendErr> {
    const MSG: &str = "Failed creating a chamfer, try a smaller length value(s)";
    let a = vec![d1; es.len()];
    let b = vec![d2; es.len()];
    match ops::chamfer(s, es, &a, &b) {
        Ok((out, Built::Done)) => Ok(out),
        Ok(_) => Err(BlendErr::Kernel(MSG.into())),
        Err(e) => Err(BlendErr::Kernel(e)),
    }
}

/// blends.py `chord_radius`.
pub fn chord_radius(shape: &Shape, edge: &Shape, chord: f64) -> f64 {
    match ops::dihedral_deg(shape, edge) {
        Some(ang) if ang >= SMOOTH_EDGE_DEG => chord / (2.0 * (ang.to_radians() / 2.0).sin()),
        _ => chord,
    }
}

fn refuse_seam_edges(shape: &Shape, edges: &[Shape], label: &str) -> FResult {
    if edges.is_empty() || !edges.iter().all(|e| ops::is_seam(shape, e)) {
        return Ok(());
    }
    let which = if edges.len() == 1 {
        "that edge is a seam".to_owned()
    } else {
        format!("all {} selected edges are seams", edges.len())
    };
    Err(value_err(
        format!(
            "can't {} here, {which}. A seam is the line where a face that wraps all the way round meets itself, so both sides of it are the same face and there is no corner to cut. Pick the edges where that face meets its NEIGHBOURS instead.",
            label.to_lowercase()
        ),
        Some(EDGE_IS_SEAM),
    ))
}

fn refuse_smooth_edges(shape: &Shape, edges: &[Shape], label: &str) -> FResult {
    let smooth = edges
        .iter()
        .filter(|e| ops::dihedral_deg(shape, e).is_some_and(|a| a < SMOOTH_EDGE_DEG))
        .count();
    if smooth == 0 {
        return Ok(());
    }
    let which = if edges.len() == 1 {
        "that edge is already smooth".to_owned()
    } else if smooth == edges.len() {
        format!("all {} selected edges are already smooth", edges.len())
    } else {
        format!(
            "{smooth} of the {} selected edges are already smooth",
            edges.len()
        )
    };
    Err(value_err(
        format!(
            "can't {} here, {which}. The faces meet tangentially, so there is no corner to cut and no smaller value will help. To get the sharp edge back, delete the rounded face.",
            label.to_lowercase()
        ),
        Some(EDGE_ALREADY_SMOOTH),
    ))
}

fn edge_mid(e: &Shape) -> Option<DVec3> {
    EdgeEnt::new(e.clone()).ok().map(|x| x.mid)
}

/// `_edge_identity`.
fn edge_identity(e: &Shape) -> Option<Map<String, Value>> {
    let ent = EdgeEnt::new(e.clone()).ok()?;
    let (m, d) = (ent.mid, ent.dir());
    let mut fp = Map::new();
    fp.insert("mid".into(), json!([m.x, m.y, m.z]));
    fp.insert("dir".into(), json!([d.x, d.y, d.z]));
    fp.insert("length".into(), json!(ent.length));
    fp.insert("curve".into(), json!(ent.curve_name()));
    if ent.curve_name() == "circle" {
        if let Some(r) = ent.radius() {
            fp.insert("radius".into(), json!(r));
        }
        if let Some(c) = ent.centre() {
            fp.insert("center".into(), json!([c.x, c.y, c.z]));
        }
    }
    Some(fp)
}

fn fp_vec(fp: &Map<String, Value>, key: &str) -> [f64; 3] {
    let a = fp.get(key).and_then(Value::as_array);
    let at = |i: usize| {
        a.and_then(|a| a.get(i))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    [at(0), at(1), at(2)]
}

/// `_canonical_blend_key`.
fn canonical_key(fp: &Map<String, Value>) -> [f64; 7] {
    let m = fp_vec(fp, "mid");
    let d = fp_vec(fp, "dir");
    let ln = fp.get("length").and_then(Value::as_f64).unwrap_or(0.0);
    [m[0], m[1], m[2], d[0], d[1], d[2], ln].map(|x| py_round(x, 3))
}

/// `_rematch_edge`: the cheapest edge within the drift gate, the first on a tie.
fn rematch_edge(
    shape: &Shape,
    fp: &Map<String, Value>,
    max_mid_dist: f64,
    tol_pos: f64,
) -> Option<Shape> {
    let mid = DVec3::from_array(fp_vec(fp, "mid"));
    let tuning = Tuning::shipped();
    let mut best: Option<(f64, Shape)> = None;
    for e in edges_of(shape).ok()? {
        if (e.mid - mid).length() > max_mid_dist {
            continue;
        }
        let cost = edge_cost(tuning, &e, fp, tol_pos, None).ok()?;
        if best.as_ref().map_or(true, |(b, _)| cost < *b) {
            best = Some((cost, e.shape));
        }
    }
    best.map(|b| b.1)
}

/// `_sequential_blend`: the survivors blended one by one to a fixpoint.
pub(crate) fn sequential_blend(
    shape: &Shape,
    edges: &[Shape],
    apply_one: &dyn Fn(&Shape, &Shape) -> Result<Shape, BlendErr>,
    blend_size: f64,
) -> (Shape, Vec<Shape>) {
    let mut pending: Vec<(Shape, Map<String, Value>)> = edges
        .iter()
        .map(|e| (e.clone(), edge_identity(e).unwrap_or_default()))
        .collect();
    pending.sort_by(|a, b| {
        let (ka, kb) = (canonical_key(&a.1), canonical_key(&b.1));
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
    });
    let t = Tuning::shipped();
    let base = t.pos_drift + t.rel_drift * opencascade::select_access::bbox_diagonal(shape);
    let max_mid_dist = 1.5 * blend_size + base;
    let tol_pos = base.max(blend_size);

    let mut current = shape.clone();
    let mut progressed = true;
    while !pending.is_empty() && progressed {
        progressed = false;
        let mut still = Vec::new();
        for (orig, fp) in pending {
            if crate::cancel::requested() {
                still.push((orig, fp));
                continue;
            }
            let Some(target) = crate::bench::phase("blend_rematch", || {
                rematch_edge(&current, &fp, max_mid_dist, tol_pos)
            }) else {
                still.push((orig, fp));
                continue;
            };
            match apply_one(&current, &target) {
                Ok(next) => {
                    current = next;
                    progressed = true;
                }
                Err(_) => still.push((orig, fp)),
            }
        }
        pending = still;
    }
    (current, pending.into_iter().map(|p| p.0).collect())
}

fn size_probe(shape: &Shape, blend_size: f64) -> Option<f64> {
    if !(blend_size > 0.0) {
        return None;
    }
    let small = (blend_size * SIZE_PROBE_FRACTION)
        .min(opencascade::select_access::bbox_diagonal(shape) * SIZE_PROBE_BODY_FRACTION);
    (small > 0.0).then_some(small)
}

/// `_kernel_sentence`: OCCT's words without the build123d-only `max_fillet()` advice.
fn kernel_sentence(err: &str) -> String {
    let mut s = err.to_owned();
    while let Some(at) = s.find("or use max_fillet()") {
        let mut start = at;
        let head = s[..at].trim_end();
        start = start.min(head.len());
        let head_bytes = head.as_bytes();
        if let Some(&last) = head_bytes.last() {
            if last == b',' || last == b';' {
                start = head.len() - 1;
            }
        }
        let rest = &s[at..];
        let end = rest.find('.').map_or(s.len(), |i| at + i);
        s = format!("{}{}", &s[..start], &s[end..]);
    }
    s.trim().to_owned()
}

/// Where the blend failed, for `_blend_edges`'s refusal and edge report.
struct BodyRef<'a> {
    name: &'a str,
    shape: &'a Shape,
}

fn blend_failure(
    label: &str,
    body: &BodyRef,
    unresolved: &[Shape],
    one_edge_at: &dyn Fn(&Shape, &Shape, f64) -> Result<Shape, BlendErr>,
    blend_size: f64,
    err: &BlendErr,
) -> Fail {
    let probed = size_probe(body.shape, blend_size);
    let helps = match probed {
        Some(small) if unresolved.len() <= 8 => Some(
            unresolved
                .iter()
                .all(|e| one_edge_at(body.shape, e, small).is_ok()),
        ),
        _ => None,
    };
    if helps != Some(false) {
        return value_err(
            format!(
                "{label} failed on {}: {}",
                body.name,
                kernel_sentence(err.text())
            ),
            helps.and(Some(BLEND_TOO_LARGE)),
        );
    }
    let which = if unresolved.len() == 1 {
        "that edge".to_owned()
    } else {
        format!("{} of the selected edges", unresolved.len())
    };
    value_err(
        format!(
            "can't {} {which} on {} at ANY size, it fails the same at {}mm as at {}mm. The blend has nowhere to end: add the neighbouring edges to it, or blend those first.",
            label.to_lowercase(),
            body.name,
            py_g(probed.unwrap_or(0.0)),
            py_g(blend_size)
        ),
        Some(BLEND_HAS_NO_END),
    )
}

/// `_report_edge_failures`.
fn report_edge_failures(
    diag: &mut Vec<Value>,
    fid: &str,
    edges: &[Shape],
    try_one: &dyn Fn(&Shape) -> bool,
) {
    if edges.len() > 32 {
        return;
    }
    let failed: Vec<&Shape> = edges.iter().filter(|e| !try_one(e)).collect();
    let probed: Vec<&Shape> = if failed.is_empty() {
        edges.iter().collect()
    } else {
        failed.clone()
    };
    let mids: Vec<Value> = probed
        .iter()
        .map(|e| {
            let m = edge_mid(e).unwrap_or(DVec3::ZERO);
            json!({"mid": [py_round(m.x, 3), py_round(m.y, 3), py_round(m.z, 3)]})
        })
        .collect();
    diag.push(json!({
        "feature_id": fid,
        "kind": "edgeOpFailed",
        "resolved": edges.len(),
        "confidence": 0.0,
        "lossy": true,
        "reason": if failed.is_empty() { "combination" } else { "per-edge" },
        "failed": mids,
    }));
}

fn fold_error(name: &str) -> Fail {
    value_err(
        format!("made surface that folds back over itself on {name}, at this size the blend runs past its own face and covers the model twice. Try a different size, or blend this edge before the one next to it."),
        Some(BLEND_FOLDS_OVER),
    )
}

/// `_blend_edges`: every selected edge of every body, assigned only once all built.
#[allow(clippy::too_many_arguments)]
fn blend_edges(
    ctx: &mut Ctx,
    fid: &str,
    sels: &OneOrMany<Selector>,
    label: &str,
    op: &BlendOp,
    blend_size: f64,
    draft: bool,
    section: Option<&SectionOp>,
    section_only: bool,
) -> FResult {
    if !(blend_size > 0.0) {
        return Err(Fail::msg(format!(
            "{label}: size must be greater than 0 (got {})",
            py_g(blend_size)
        )));
    }
    let groups = select::group_by_body(ctx, sels, label)?;
    let mut staged: Vec<(usize, Shape)> = Vec::new();
    for (index, group) in groups {
        checkpoint()?;
        let body_shape = ctx.bodies[index].shape().clone();
        let body_name = ctx.bodies[index].name.clone();
        let sel_value = Value::Array(
            group
                .iter()
                .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
                .collect(),
        );
        let edges =
            Resolver::new(Some(&mut ctx.diagnostics), Some(fid)).edges(&body_shape, &sel_value)?;
        if edges.is_empty() {
            return Err(Fail::msg(format!(
                "no edge found to {} on {body_name}",
                label.to_lowercase()
            )));
        }
        refuse_seam_edges(&body_shape, &edges, label)?;
        refuse_smooth_edges(&body_shape, &edges, label)?;
        let try_section = |shape: &Shape, es: &[Shape]| -> Option<Shape> {
            section.and_then(|s| s(shape, es).ok())
        };
        if section_only {
            match section.map(|s| s(&body_shape, &edges)) {
                Some(Ok(out)) => {
                    staged.push((index, out));
                    continue;
                }
                Some(Err(SectionErr::Blend(e))) => {
                    return Err(Fail::msg(format!("{label} failed on {body_name}: {e}")))
                }
                Some(Err(SectionErr::Value(e))) => return Err(Fail::msg(e)),
                Some(Err(SectionErr::Internal(name))) => return Err(Fail::Internal(name)),
                Some(Err(SectionErr::Cancelled)) => return Err(Fail::msg("cancelled")),
                None => return Err(Fail::Internal("TypeError".into())),
            }
        }
        let fell_back = format!("{fid}|{}|{label}|{sel_value}", ctx.bodies[index].id);
        if draft && fell_back_before(&fell_back, blend_size) {
            if let Some(built) = try_section(&body_shape, &edges) {
                staged.push((index, built));
                continue;
            }
        }

        let (work, work_edges) =
            ops::copy(&body_shape, &edges).unwrap_or((body_shape.clone(), edges.clone()));
        let one_edge_at =
            |s: &Shape, e: &Shape, size: f64| op(s, std::slice::from_ref(e), size);
        let new_shape = match op(&work, &work_edges, blend_size) {
            Ok(out) => out,
            Err(BlendErr::Conic(msg)) => return Err(value_err(msg, Some(CONIC_NOT_APPLICABLE))),
            Err(combined_err) => {
                checkpoint()?;
                let (out, unresolved) = if draft && section.is_some() {
                    (work.clone(), work_edges.clone())
                } else {
                    let apply =
                        |s: &Shape, e: &Shape| op(s, std::slice::from_ref(e), blend_size);
                    sequential_blend(&work, &work_edges, &apply, blend_size)
                };
                if unresolved.is_empty() {
                    out
                } else {
                    checkpoint()?;
                    if let Some(built) = try_section(&body_shape, &edges) {
                        if draft {
                            remember_fell_back(fell_back, blend_size);
                        }
                        staged.push((index, built));
                        continue;
                    }
                    checkpoint()?;
                    report_edge_failures(&mut ctx.diagnostics, fid, &unresolved, &|e| {
                        one_edge_at(&work, e, blend_size).is_ok()
                    });
                    let body = BodyRef {
                        name: &body_name,
                        shape: &work,
                    };
                    return Err(blend_failure(
                        label,
                        &body,
                        &unresolved,
                        &one_edge_at,
                        blend_size,
                        &combined_err,
                    ));
                }
            }
        };
        checkpoint()?;
        let new_shape = if overlap::folds_over_itself(&work, &new_shape) {
            match try_section(&body_shape, &edges) {
                Some(built) => built,
                None => return Err(fold_error(&body_name)),
            }
        } else {
            new_shape
        };
        staged.push((index, new_shape));
    }
    for (index, shape) in staged {
        ctx.set_shape(index, shape);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_that_fell_back_asks_the_kernel_again_below_that_size() {
        let key = "test-fell-back|body1|Fillet|[]".to_owned();
        assert!(!fell_back_before(&key, 43.7));
        remember_fell_back(key.clone(), 43.7);
        assert!(fell_back_before(&key, 43.7));
        assert!(fell_back_before(&key, 50.0));
        assert!(!fell_back_before(&key, 3.0));
        remember_fell_back(key.clone(), 37.0);
        assert!(fell_back_before(&key, 40.0));
        assert!(!fell_back_before(&key, 36.0));
    }

    #[test]
    fn kernel_sentence_drops_the_max_fillet_tail() {
        assert_eq!(
            kernel_sentence("Failed creating a fillet with radius of 5, try a smaller value or use max_fillet() to find the largest valid fillet radius"),
            "Failed creating a fillet with radius of 5, try a smaller value"
        );
        assert_eq!(kernel_sentence("x, or use max_fillet() y. z"), "x. z");
    }
}
