//! Fillets and chamfers, blends.py. One kernel call on the whole group first, on a copy. When that refuses the
//! edges go one at a time in canonical order, and one that still refuses fails saying whether a smaller size builds.

pub mod eval;
pub mod ops;
pub mod overlap;
pub mod smooth;

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
pub const BLEND_CHANGED_NOTHING: &str = "blendChangedNothing";

const SMOOTH_EDGE_DEG: f64 = 1.0;
const SIZE_PROBE_FRACTION: f64 = 0.05;
const SIZE_PROBE_BODY_FRACTION: f64 = 1e-3;
/// blend_conic.hxx `PROFILE_MAX` and `PROFILE_MIN`, where the kernel stops
/// computing correctly on the blend.
const PROFILE_MAX: f64 = 0.95;
const PROFILE_MIN: f64 = -0.99;
const PROFILE_EPS: f64 = 1e-6;

/// Why one kernel attempt did not build, as the Python exception reads.
#[derive(Debug, Clone)]
pub enum BlendErr {
    Kernel(String),
    /// A kernel failure that names the vertices it gave up at.
    Stuck(String, Vec<[f64; 3]>),
    /// conic_blend.py `ConicNotApplicable`: the profile, not the blend, refused.
    Conic(String),
}

impl BlendErr {
    fn text(&self) -> &str {
        match self {
            BlendErr::Kernel(s) | BlendErr::Stuck(s, _) | BlendErr::Conic(s) => s,
        }
    }
}

/// `(shape, edges, size)`: one kernel blend.
type BlendOp<'a> = dyn Fn(&Shape, &[Shape], f64) -> Result<Shape, BlendErr> + 'a;
/// `(shape, edges, size)`: the section build.
type SectionOp<'a> = dyn Fn(&Shape, &[Shape], f64) -> Result<Shape, SectionErr> + 'a;

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
    /// The blend does not fit an edge: why, how much of the asked size does,
    /// and a point on that edge.
    TooLarge { why: Misfit, fits: Fits, at: [f64; 3] },
}

/// blend_section.hxx `Misfit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Misfit {
    IntoBody,
    Mixed,
    Split,
    /// It would carve away the face line the blend on a neighbouring edge
    /// rests on.
    Overlap,
}

impl Misfit {
    pub fn from_code(code: i32) -> Misfit {
        match code {
            4 => Misfit::Mixed,
            5 => Misfit::Split,
            6 => Misfit::Overlap,
            _ => Misfit::IntoBody,
        }
    }
}

/// The largest size that fits, in mm of the asked one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fits {
    UpTo(f64),
    Nothing,
    /// The search for it ran out of time.
    Unknown,
}

/// The section build's refusal of a blend too large for its edge, with the
/// size that fits rounded down so that it still does.
fn misfit_error(label: &str, body: &str, size: f64, why: Misfit, fits: Fits, at: [f64; 3]) -> Fail {
    let [x, y, z] = at.map(|c| py_g(py_round(c, 3)));
    let neighbour = format!("it would run into the {} on the neighbouring edge", label.to_lowercase());
    let past = match why {
        Misfit::IntoBody => "it would cut on past a face into the body beyond it",
        Misfit::Mixed => "it would run off a face on part of the edge only",
        Misfit::Split => "it would cut the body in pieces",
        Misfit::Overlap => &neighbour,
    };
    let head = format!(
        "{label} failed on {body}: at {}mm the {} does not fit the edge through ({x}, {y}, {z}), {past}.",
        py_g(size),
        label.to_lowercase()
    );
    // At the limit the ball ends exactly on a face's edge and the kernel leaves a sliver face, so the offer stays
    // a hair below it. A split's or an overlap's limit is a size that built, already on this grid.
    let shown = |v: f64| {
        let v = if matches!(why, Misfit::Split | Misfit::Overlap) { v + 1e-6 } else { v - 1e-4 };
        let step = if v >= 1.0 { 100.0 } else { 1000.0 };
        (v * step).floor() / step
    };
    match fits {
        Fits::UpTo(k) if shown(k) > 0.0 => value_err(
            format!("{head} It fits up to {}mm, so try that or a smaller value.", py_g(shown(k))),
            Some(BLEND_TOO_LARGE),
        ),
        Fits::Unknown => value_err(format!("{head} Try a smaller value."), Some(BLEND_TOO_LARGE)),
        _ => value_err(format!("{head} No size fits it here."), Some(BLEND_HAS_NO_END)),
    }
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
    Fail::Value { message: message.into(), code }
}

/// conic_blend.py `clamp_profile`.
pub fn clamp_profile(p: f64) -> f64 {
    if p.is_nan() {
        0.0
    } else {
        p.clamp(PROFILE_MIN, PROFILE_MAX)
    }
}

/// A fillet's `continuity` as the section build takes it: "G2" and "G3" ease into the faces, anything else is a
/// circular round.
pub fn continuity_of(c: Option<&str>) -> i32 {
    match c {
        Some("G3") => 3,
        Some("G2") => 2,
        _ => 1,
    }
}

pub fn fillet(ctx: &mut Ctx, f: &Fillet) -> FResult {
    let r = ctx.val(&f.radius)?;
    let p = match &f.profile {
        Some(n) => clamp_profile(ctx.val(n)?),
        None => 0.0,
    };
    let cont = continuity_of(f.continuity.as_deref());
    let smooth = cont > 1;
    let chord = f.size_type.as_deref() == Some("chord");
    let only_picked = f.tangent_edges == Some(false);
    let draft = f.draft == Some(true);

    let op = move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, BlendErr> {
        let radii: Vec<f64> = es.iter().map(|e| if chord { chord_radius(s, e, size) } else { size }).collect();
        native_fillet(s, es, &radii)
    };
    let section_at = move |profile: f64| {
        move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, SectionErr> {
            let sizes: Vec<f64> = es.iter().map(|e| if chord { chord_radius(s, e, size) } else { size }).collect();
            ops::section(s, es, false, &sizes, None, size, cont, draft, profile)
        }
    };
    let section = section_at(p);

    if smooth || only_picked || p.abs() < PROFILE_EPS {
        return blend_edges(
            ctx,
            &f.id,
            &f.edges,
            "Fillet",
            &format!("round {p} {cont} {chord}"),
            &op,
            r,
            draft,
            Some(&section),
            smooth || only_picked,
        );
    }
    let conic = move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, BlendErr> { ops::conic(s, es, size, p) };
    match blend_edges(
        ctx,
        &f.id,
        &f.edges,
        "Fillet",
        &format!("conic {p} {chord}"),
        &conic,
        r,
        draft,
        Some(&section),
        false,
    ) {
        Err(Fail::Value { message, code: Some(CONIC_NOT_APPLICABLE) }) => {
            let _ = message;
            match blend_edges(
                ctx,
                &f.id,
                &f.edges,
                "Fillet",
                &format!("conic round {p} {chord}"),
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
                        &format!("round 0 1 {chord}"),
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
    // All edges in one call, so three edges meeting at a corner end in one triangle. build123d's combined chamfer
    // refused here ("Nothing to chamfer"), which is why the Python engine's corners came out pointed.
    let op = move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, BlendErr> {
        match d2 {
            None => build123d_chamfer(s, es, size),
            Some(d2) => native_two_distance_chamfer(s, es, size, d2 * size / d),
        }
    };
    let section = move |s: &Shape, es: &[Shape], size: f64| -> Result<Shape, SectionErr> {
        ops::section(s, es, true, &vec![size; es.len()], d2.map(|d2| d2 * size / d), size, 1, draft, 0.0)
    };
    blend_edges(
        ctx,
        &f.id,
        &f.edges,
        "Chamfer",
        &format!("{d2:?}"),
        &op,
        d,
        draft,
        Some(&section),
        f.tangent_edges == Some(false),
    )
}

/// `_DRAFT_FELL_BACK`: drags that needed the section build and the smallest size they needed it at. Keyed by
/// size unlike blends.py, so a drag shrunk from 43.7 mm to 3 mm tries the kernel's filleter again first, since
/// the section build's boolean can hang outright on such a small conic blend.
static DRAFT_FELL_BACK: std::sync::Mutex<Vec<(String, f64)>> = std::sync::Mutex::new(Vec::new());

fn fell_back_before(key: &str, size: f64) -> bool {
    DRAFT_FELL_BACK.lock().map(|v| v.iter().any(|(k, at)| k == key && size >= *at)).unwrap_or(false)
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
        Ok((at, Built::NotDone)) => Err(BlendErr::Stuck(MSG.into(), vertex_points(&at))),
        Ok(_) => Err(BlendErr::Kernel(MSG.into())),
        Err(e) => Err(BlendErr::Kernel(e)),
    }
}

/// build123d `chamfer(edges, length)`: every kernel failure reads the same.
fn build123d_chamfer(s: &Shape, es: &[Shape], size: f64) -> Result<Shape, BlendErr> {
    let d = vec![size; es.len()];
    match ops::chamfer(s, es, &d, &d) {
        Ok((out, Built::Done)) => Ok(out),
        _ => Err(BlendErr::Kernel("Failed creating a chamfer, try a smaller length value(s)".into())),
    }
}

/// blends.py `native_two_distance_chamfer`.
fn native_two_distance_chamfer(s: &Shape, es: &[Shape], d1: f64, d2: f64) -> Result<Shape, BlendErr> {
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
    crate::mesh::edges::radius_of_chord(ops::dihedral_deg(shape, edge), chord)
}

/// Seams out of the set. One an edge pick named is refused, since the kernel would skip it and call the blend
/// done. One a broad selector swept in is no edge anyone sees and is left out quietly.
fn drop_seams(shape: &Shape, sels: &[Value], edges: Vec<Shape>, label: &str) -> FResult<Vec<Shape>> {
    let adj = crate::topo::FaceAdjacency::new(shape);
    let (seams, real): (Vec<Shape>, Vec<Shape>) = edges.into_iter().partition(|e| adj.is_seam(e));
    if seams.is_empty() {
        return Ok(real);
    }
    let mut picked: Vec<Shape> = Vec::new();
    for sel in sels.iter().filter(|s| names_one_edge(s)) {
        for e in Resolver::new(None, None).edges(shape, sel).unwrap_or_default() {
            if seams.iter().any(|s| s.is_same(&e)) && !picked.iter().any(|p| p.is_same(&e)) {
                picked.push(e);
            }
        }
    }
    let which = match (real.is_empty(), picked.len()) {
        (true, _) if seams.len() == 1 => "that edge is a seam".to_owned(),
        (true, _) => format!("all {} selected edges are seams", seams.len()),
        (false, 0) => return Ok(real),
        (false, 1) => "one of the selected edges is a seam".to_owned(),
        (false, n) => format!("{n} of the selected edges are seams"),
    };
    Err(value_err(
        format!(
            "can't {} here, {which}. A seam is the line where a face that wraps all the way round meets itself, so both sides of it are the same face and there is no corner to cut. Pick the edges where that face meets its NEIGHBOURS instead.",
            label.to_lowercase()
        ),
        Some(EDGE_IS_SEAM),
    ))
}

/// Sliver edges out of the set: one among real edges is left out, since the
/// kernel refuses the whole blend over an edge it cannot put a round on.
fn drop_slivers(edges: Vec<Shape>, label: &str) -> FResult<Vec<Shape>> {
    use crate::mesh::edges::SLIVER_EDGE_MM;
    let real: Vec<Shape> = edges.iter().filter(|e| crate::kernel::length(e) >= SLIVER_EDGE_MM).cloned().collect();
    if real.is_empty() && !edges.is_empty() {
        return Err(Fail::msg(format!(
            "can't {} here, the selected edge is under {}mm long, a sliver left where two corners nearly meet. Pick the edges beside it instead.",
            label.to_lowercase(),
            py_g(SLIVER_EDGE_MM)
        )));
    }
    Ok(real)
}

fn names_one_edge(sel: &Value) -> bool {
    sel.get("kind").and_then(Value::as_str) == Some("edge")
        && matches!(sel.get("by").and_then(Value::as_str), Some("nearest" | "match"))
}

/// A blend only reshapes the outside, so a hollow inside the body must survive
/// it. A blend near one has been seen to come back with it filled.
fn keeps_voids(before: &Shape, after: &Shape) -> bool {
    crate::kernel::void_count(after) >= crate::kernel::void_count(before)
}

/// The kernel can hand a blend back with nothing cut, and that must not pass
/// as done.
fn refuse_unchanged(before: &Shape, after: &Shape, label: &str, body: &str) -> FResult {
    use crate::kernel::{count, volume, Kind};
    let same = before.is_same(after)
        || (count(before, Kind::Face) == count(after, Kind::Face)
            && count(before, Kind::Edge) == count(after, Kind::Edge)
            && (volume(before) - volume(after)).abs() <= 1e-9 * volume(before).abs().max(1.0));
    if !same {
        return Ok(());
    }
    let done = if label == "Chamfer" { "chamfered" } else { "filleted" };
    Err(value_err(
        format!(
            "{label} changed nothing on {body}, none of the selected edges could be {done}. Pick the edges again, with the point on the edge itself rather than on a corner where it meets another."
        ),
        Some(BLEND_CHANGED_NOTHING),
    ))
}

fn refuse_smooth_edges(shape: &Shape, edges: &[Shape], label: &str) -> FResult {
    let smooth = edges.iter().filter(|e| ops::dihedral_deg(shape, e).is_some_and(|a| a < SMOOTH_EDGE_DEG)).count();
    if smooth == 0 {
        return Ok(());
    }
    let which = if edges.len() == 1 {
        "that edge is already smooth".to_owned()
    } else if smooth == edges.len() {
        format!("all {} selected edges are already smooth", edges.len())
    } else {
        format!("{smooth} of the {} selected edges are already smooth", edges.len())
    };
    Err(value_err(
        format!(
            "can't {} here, {which}. The faces meet tangentially, so there is no corner to cut and no smaller value will help. To get the sharp edge back, delete the rounded face.",
            label.to_lowercase()
        ),
        Some(EDGE_ALREADY_SMOOTH),
    ))
}

fn vertex_points(s: &Shape) -> Vec<[f64; 3]> {
    crate::kernel::subshapes(s, crate::kernel::Kind::Vertex)
        .iter()
        .filter_map(crate::kernel::bbox)
        .map(|b| [0.5 * (b[0] + b[3]), 0.5 * (b[1] + b[4]), 0.5 * (b[2] + b[5])])
        .collect()
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
    let at = |i: usize| a.and_then(|a| a.get(i)).and_then(Value::as_f64).unwrap_or(0.0);
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
fn rematch_edge(shape: &Shape, fp: &Map<String, Value>, max_mid_dist: f64, tol_pos: f64) -> Option<Shape> {
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

/// Blending a neighbour trims an edge but leaves it on its own curve. Without this a notch corner's round once
/// landed on a 0.03 mm sliver its neighbour left, and the corner stayed sharp with no error.
fn still_on(orig: &Shape, target: &Shape, tol: f64) -> bool {
    let Ok(t) = EdgeEnt::new(target.clone()) else {
        return false;
    };
    crate::kernel::distance_to_point(orig, t.mid.to_array()).is_some_and(|d| d <= tol)
}

/// The asked for edges that `out` still has. The section build could hand one back untouched and call it done,
/// a notch corner that stayed sharp without a word.
fn still_sharp(out: &Shape, edges: &[Shape]) -> Vec<Shape> {
    let after = crate::kernel::subshapes(out, crate::kernel::Kind::Edge);
    edges
        .iter()
        .filter(|e| {
            let Ok(ent) = EdgeEnt::new((*e).clone()) else {
                return false;
            };
            let mid = ent.mid.to_array();
            after.iter().any(|a| {
                crate::kernel::distance_to_point(a, mid).is_some_and(|d| d < 1e-4)
                    && (crate::kernel::length(a) - ent.length).abs() < 0.5 * ent.length
            })
        })
        .cloned()
        .collect()
}

/// `_sequential_blend`: the survivors blended one by one to a fixpoint.
pub(crate) fn sequential_blend(
    shape: &Shape,
    edges: &[Shape],
    apply_one: &dyn Fn(&Shape, &Shape) -> Result<Shape, BlendErr>,
    blend_size: f64,
) -> (Shape, Vec<Shape>) {
    // The body each edge last failed on: the kernel answers the same body the
    // same way, so the next pass skips an edge until a neighbour has changed it.
    let mut pending: Vec<(Shape, Map<String, Value>, Option<Shape>)> =
        edges.iter().map(|e| (e.clone(), edge_identity(e).unwrap_or_default(), None)).collect();
    pending.sort_by(|a, b| {
        let (ka, kb) = (canonical_key(&a.1), canonical_key(&b.1));
        ka.partial_cmp(&kb).unwrap_or(std::cmp::Ordering::Equal)
    });
    let t = Tuning::shipped();
    let base = t.pos_drift + t.rel_drift * crate::kernel::bbox_diagonal(shape);
    let max_mid_dist = 1.5 * blend_size + base;
    let tol_pos = base.max(blend_size);
    let on_curve = 0.01_f64.max(0.01 * blend_size);

    let mut current = shape.clone();
    let mut progressed = true;
    while !pending.is_empty() && progressed {
        progressed = false;
        let mut still = Vec::new();
        for (orig, fp, failed_on) in pending {
            if crate::cancel::requested() || failed_on.as_ref().is_some_and(|f| f.is_same(&current)) {
                still.push((orig, fp, failed_on));
                continue;
            }
            let Some(target) = crate::bench::phase("blend_rematch", || {
                rematch_edge(&current, &fp, max_mid_dist, tol_pos).filter(|t| still_on(&orig, t, on_curve))
            }) else {
                still.push((orig, fp, failed_on));
                continue;
            };
            match apply_one(&current, &target) {
                Ok(next) => {
                    current = next;
                    progressed = true;
                }
                Err(_) => still.push((orig, fp, Some(current.clone()))),
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
    let small = (blend_size * SIZE_PROBE_FRACTION).min(crate::kernel::bbox_diagonal(shape) * SIZE_PROBE_BODY_FRACTION);
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

/// The largest of a few halvings of `blend_size` at which the edges build together. Each can refuse alone at
/// any size, its round having nowhere to end short of the next, while the chain as a whole fits smaller.
fn group_fits_at(body: &Shape, edges: &[Shape], op: &BlendOp, blend_size: f64) -> Option<f64> {
    if edges.len() < 2 {
        return None;
    }
    (1..=4)
        .map(|k| blend_size / f64::from(1u32 << k))
        .find(|&size| op(body, edges, size).is_ok_and(|out| !overlap::folds_over_itself(body, &out, size)))
}

fn blend_failure(
    label: &str,
    body: &BodyRef,
    unresolved: &[Shape],
    one_edge_at: &dyn Fn(&Shape, &Shape, f64) -> Result<Shape, BlendErr>,
    group_op: &BlendOp,
    blend_size: f64,
    err: &BlendErr,
) -> Fail {
    let probed = size_probe(body.shape, blend_size);
    let helps = match probed {
        Some(small) if unresolved.len() <= 8 => {
            Some(unresolved.iter().all(|e| one_edge_at(body.shape, e, small).is_ok()))
        }
        _ => None,
    };
    if helps != Some(false) {
        let stuck = match (err, helps, probed) {
            (BlendErr::Stuck(_, at), Some(true), Some(small)) => {
                short_edge_at(body.shape, unresolved, at, blend_size).map(|(len, p)| (len, p, small))
            }
            _ => None,
        };
        if let Some((len, p, small)) = stuck {
            let [x, y, z] = p.map(|c| py_g(py_round(c, 3)));
            return value_err(
                format!(
                    "{label} failed on {}: at {}mm the blend cannot end at ({x}, {y}, {z}), where the selected edge runs on into a {}mm edge. At {}mm it builds, so try a smaller value, or change the model so the edge does not end in such a short one.",
                    body.name,
                    py_g(blend_size),
                    py_g(py_round(len, 2)),
                    py_g(small)
                ),
                Some(BLEND_TOO_LARGE),
            );
        }
        return value_err(
            format!("{label} failed on {}: {}", body.name, kernel_sentence(err.text())),
            helps.and(Some(BLEND_TOO_LARGE)),
        );
    }
    if let Some(fits) = group_fits_at(body.shape, unresolved, group_op, blend_size) {
        return value_err(
            format!(
                "{label} failed on {}: at {}mm the blend has nowhere to end where these edges run out, but together they build at {}mm, so try that size.",
                body.name,
                py_g(blend_size),
                py_g(fits)
            ),
            Some(BLEND_TOO_LARGE),
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

/// An edge shorter than the blend that runs on from one of `edges` to a vertex the kernel gave up at, with its
/// length. The kernel carries a blend along such a tangent sliver and then has to end it in the corner past it.
fn short_edge_at(body: &Shape, edges: &[Shape], at: &[[f64; 3]], blend_size: f64) -> Option<(f64, [f64; 3])> {
    use crate::kernel::{subshapes, Kind};
    const SAME: f64 = 1e-4;
    let near = |a: &[f64; 3], b: &[f64; 3]| DVec3::from_array(*a).distance(DVec3::from_array(*b)) <= SAME;
    let ends: Vec<[f64; 3]> = edges.iter().flat_map(vertex_points).collect();
    subshapes(body, Kind::Edge)
        .iter()
        .filter_map(|e| {
            let vs = vertex_points(e);
            let [a, b] = vs.as_slice() else {
                return None;
            };
            let stuck = at.iter().find_map(|p| {
                if near(a, p) {
                    Some((*p, b))
                } else if near(b, p) {
                    Some((*p, a))
                } else {
                    None
                }
            });
            let (p, other) = stuck?;
            if !ends.iter().any(|v| near(v, other)) {
                return None;
            }
            let len = crate::kernel::length(e);
            (len < blend_size).then_some((len, p))
        })
        .min_by(|x, y| x.0.total_cmp(&y.0))
}

/// `_report_edge_failures`.
fn report_edge_failures(diag: &mut Vec<Value>, fid: &str, edges: &[Shape], try_one: &dyn Fn(&Shape) -> bool) {
    if edges.len() > 32 {
        return;
    }
    let failed: Vec<&Shape> = edges.iter().filter(|e| !try_one(e)).collect();
    let probed: Vec<&Shape> = if failed.is_empty() { edges.iter().collect() } else { failed.clone() };
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

/// Sizes tried under a refused one, as shares of it: the kernel fails these edges at sizes in no order, so a
/// bisection would trust a failure that a smaller size does not share.
const SMOOTH_LADDER: [f64; 6] = [0.75, 0.5, 0.35, 0.25, 0.15, 0.1];

/// The largest size on the ladder under `size` that builds smooth, on the grid a refusal offers sizes on.
fn smooth_size(size: f64, builds: &dyn Fn(f64) -> bool) -> Option<f64> {
    SMOOTH_LADDER
        .iter()
        .map(|k| {
            let v = k * size;
            let step = if v >= 1.0 { 100.0 } else { 1000.0 };
            (v * step).floor() / step
        })
        .filter(|&v| v > 0.0)
        .find(|&v| checkpoint().is_ok() && builds(v))
}

/// A blend over an edge whose faces turn tangent that came out rippled, or did not build. `found` is `None` when
/// no smaller size was tried, and `Some(None)` when none tried built smooth.
fn uneven_error(label: &str, body: &str, size: f64, rippled: bool, found: Option<Option<f64>>) -> Fail {
    let what = label.to_lowercase();
    let how = if rippled { "comes out rippled" } else { "does not fit" };
    let head = format!(
        "{label} failed on {body}: at {}mm the {what} {how} where the selected edges run up into a seam whose faces turn tangent",
        py_g(size)
    );
    match found {
        Some(Some(v)) => value_err(format!("{head}. It builds smooth at {}mm, so try that size.", py_g(v)), Some(BLEND_TOO_LARGE)),
        Some(None) => value_err(
            format!(
                "{head}, and none of the smaller sizes tried, down to {}mm, did either. Leave out the edge that runs up into that seam.",
                py_g(SMOOTH_LADDER[SMOOTH_LADDER.len() - 1] * size)
            ),
            Some(BLEND_HAS_NO_END),
        ),
        None => value_err(format!("{head}. Try a smaller value."), Some(BLEND_TOO_LARGE)),
    }
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
    // What else shapes the blend. A fall back remembered for one profile says nothing about another, and would
    // send its preview down another path than the commit takes.
    variant: &str,
    op: &BlendOp,
    blend_size: f64,
    draft: bool,
    section: Option<&SectionOp>,
    section_only: bool,
) -> FResult {
    if !(blend_size > 0.0) {
        return Err(Fail::msg(format!("{label}: size must be greater than 0 (got {})", py_g(blend_size))));
    }
    let groups = select::group_by_body(ctx, sels, label)?;
    let mut staged: Vec<(usize, Shape)> = Vec::new();
    let overruns: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
    for (index, group) in groups {
        checkpoint()?;
        let body_shape = ctx.bodies[index].shape().clone();
        let body_name = ctx.bodies[index].name.clone();
        let sel_value = Value::Array(group.iter().map(|s| serde_json::to_value(s).unwrap_or(Value::Null)).collect());
        let edges = Resolver::new(Some(&mut ctx.diagnostics), Some(fid)).edges(&body_shape, &sel_value)?;
        if edges.is_empty() {
            return Err(Fail::msg(format!("no edge found to {} on {body_name}", label.to_lowercase())));
        }
        let sels = sel_value.as_array().map_or(&[][..], Vec::as_slice);
        let edges = drop_seams(&body_shape, sels, edges, label)?;
        let edges = drop_slivers(edges, label)?;
        refuse_smooth_edges(&body_shape, &edges, label)?;
        let misfit: std::cell::Cell<Option<Fail>> = std::cell::Cell::new(None);
        let fades = smooth::turns_tangent(&body_shape, &edges);
        let gauge = fades.then(|| smooth::Gauge::new(&body_shape));
        let rippled = std::cell::Cell::new(false);
        let smooth_at = |out: &Shape, size: f64| {
            let ok = gauge.as_ref().is_none_or(|g| g.lumps(out, size).smooth());
            if !ok && size == blend_size {
                rippled.set(true);
            }
            ok
        };
        let note_overrun = || {
            if let Some(o) = ops::take_overrun() {
                overruns.borrow_mut().push(overrun_note(label, &body_name, blend_size, o));
            }
        };
        let try_section = |shape: &Shape, es: &[Shape]| -> Option<Shape> {
            match section?(shape, es, blend_size) {
                Ok(out) => {
                    let kept = Some(out).filter(|out| {
                        still_sharp(out, es).is_empty() && keeps_voids(shape, out) && smooth_at(out, blend_size)
                    });
                    if kept.is_some() {
                        note_overrun();
                    }
                    kept
                }
                Err(SectionErr::TooLarge { why, fits, at }) => {
                    misfit.set(Some(misfit_error(label, &body_name, blend_size, why, fits, at)));
                    None
                }
                Err(_) => None,
            }
        };
        if section_only {
            match section.map(|s| s(&body_shape, &edges, blend_size)) {
                Some(Ok(out)) => {
                    if !smooth_at(&out, blend_size) {
                        return Err(uneven_error(label, &body_name, blend_size, true, None));
                    }
                    let sharp = still_sharp(&out, &edges);
                    if !sharp.is_empty() {
                        return Err(Fail::msg(format!(
                            "{label} failed on {body_name}: {} of the edges could not be blended at this size",
                            sharp.len()
                        )));
                    }
                    note_overrun();
                    staged.push((index, out));
                    continue;
                }
                Some(Err(SectionErr::Blend(e))) => {
                    return Err(Fail::msg(format!("{label} failed on {body_name}: {e}")))
                }
                Some(Err(SectionErr::Value(e))) => return Err(Fail::msg(e)),
                Some(Err(SectionErr::Internal(name))) => return Err(Fail::Internal(name)),
                Some(Err(SectionErr::Cancelled)) => return Err(Fail::msg("cancelled")),
                Some(Err(SectionErr::TooLarge { why, fits, at })) => {
                    return Err(misfit_error(label, &body_name, blend_size, why, fits, at))
                }
                None => return Err(Fail::Internal("TypeError".into())),
            }
        }
        let fell_back = format!("{fid}|{}|{label}|{variant}|{sel_value}", ctx.bodies[index].id);
        if draft && fell_back_before(&fell_back, blend_size) {
            if let Some(built) = try_section(&body_shape, &edges) {
                staged.push((index, built));
                continue;
            }
        }

        let (work, work_edges) = ops::copy(&body_shape, &edges).unwrap_or((body_shape.clone(), edges.clone()));
        let one_edge_at = |s: &Shape, e: &Shape, size: f64| op(s, std::slice::from_ref(e), size);
        // Whether a size really builds smooth, by the kernel or else the section build, each on a fresh copy.
        let builds_smooth = |size: f64| {
            let by_kernel = ops::copy(&body_shape, &edges).is_some_and(|(b, es)| {
                op(&b, &es, size).is_ok_and(|out| !overlap::folds_over_itself(&b, &out, size) && smooth_at(&out, size))
            });
            by_kernel
                || section.is_some_and(|sec| {
                    sec(&body_shape, &edges, size).is_ok_and(|out| {
                        still_sharp(&out, &edges).is_empty() && keeps_voids(&body_shape, &out) && smooth_at(&out, size)
                    })
                })
        };
        let uneven = || {
            let found = (!draft).then(|| smooth_size(blend_size, &builds_smooth));
            uneven_error(label, &body_name, blend_size, rippled.get(), found)
        };
        let new_shape = match op(&work, &work_edges, blend_size) {
            Ok(out) => out,
            Err(BlendErr::Conic(msg)) => return Err(value_err(msg, Some(CONIC_NOT_APPLICABLE))),
            Err(combined_err) => {
                checkpoint()?;
                let (out, unresolved) = if draft && section.is_some() {
                    (work.clone(), work_edges.clone())
                } else {
                    let apply = |s: &Shape, e: &Shape| op(s, std::slice::from_ref(e), blend_size);
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
                    if fades {
                        return Err(uneven());
                    }
                    if let Some(fail) = misfit.take() {
                        return Err(fail);
                    }
                    let body = BodyRef { name: &body_name, shape: &work };
                    return Err(blend_failure(label, &body, &unresolved, &one_edge_at, op, blend_size, &combined_err));
                }
            }
        };
        checkpoint()?;
        let new_shape = if overlap::folds_over_itself(&work, &new_shape, blend_size) {
            match try_section(&body_shape, &edges) {
                Some(built) => built,
                None if fades => return Err(uneven()),
                None => return Err(misfit.take().unwrap_or_else(|| fold_error(&body_name))),
            }
        } else if !smooth_at(&new_shape, blend_size) {
            match try_section(&body_shape, &edges) {
                Some(built) => built,
                None => return Err(uneven()),
            }
        } else {
            new_shape
        };
        staged.push((index, new_shape));
    }
    for (index, shape) in &staged {
        let body = &ctx.bodies[*index];
        refuse_unchanged(body.shape(), shape, label, &body.name)?;
        if !keeps_voids(body.shape(), shape) {
            return Err(Fail::msg(format!(
                "{label} failed on {}: the blend came back with a hollow inside the body filled in, so it was refused. Try a smaller size.",
                body.name
            )));
        }
    }
    for (index, shape) in staged {
        ctx.set_shape(index, shape);
    }
    for message in overruns.into_inner() {
        ctx.diagnostics.push(json!({
            "feature_id": fid,
            "kind": "edge",
            "lossy": false,
            "message": message,
        }));
    }
    Ok(())
}

/// A section round built though it runs past a face: no fillet rests on both
/// faces at that size, it cuts the corner off, so the build says so.
fn overrun_note(label: &str, body: &str, size: f64, o: ops::Overrun) -> String {
    let [x, y, z] = o.at.map(|c| py_g(py_round(c, 3)));
    let what = label.to_lowercase();
    let head = format!(
        "at {}mm the {what} runs past a face beside the edge through ({x}, {y}, {z}) on {body}, so it cuts that \
         corner off instead of resting on both faces.",
        py_g(size)
    );
    let fits = o.fits.map(|v| {
        let v = v - 1e-4;
        let step = if v >= 1.0 { 100.0 } else { 1000.0 };
        (v * step).floor() / step
    });
    match fits {
        Some(v) if v > 0.0 => format!("{head} A {what} that rests on both fits up to {}mm.", py_g(v)),
        _ => head,
    }
}

#[cfg(test)]
mod tests;
