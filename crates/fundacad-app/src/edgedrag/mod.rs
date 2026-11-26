//! The arithmetic of the edge drag, FundaCAD 1's edgeDragMath.ts, edgeSwipe.ts, edgeCountGate.ts and
//! previewOutcomes.ts. It is signed: one way along the handle axis is a fillet, the other a chamfer, with no feature at
//! the origin between, so changing your mind costs a mouse move rather than a restart.

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use glam::Vec2;
use serde_json::Value;

use crate::i18n::tr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Treatment {
    Fillet,
    Chamfer,
}

impl Treatment {
    pub fn of(kind: &str) -> Option<Treatment> {
        match kind {
            "fillet" => Some(Treatment::Fillet),
            "chamfer" => Some(Treatment::Chamfer),
            _ => None,
        }
    }

    pub fn kind(self) -> &'static str {
        match self {
            Treatment::Fillet => "fillet",
            Treatment::Chamfer => "chamfer",
        }
    }

    /// The feature field the value is stored in, in mm.
    pub fn field(self) -> &'static str {
        match self {
            Treatment::Fillet => "radius",
            Treatment::Chamfer => "distance",
        }
    }

    /// The one-letter label on the heads-up input.
    pub fn letter(self) -> &'static str {
        match self {
            Treatment::Fillet => "R",
            Treatment::Chamfer => "D",
        }
    }

    pub fn other(self) -> Treatment {
        match self {
            Treatment::Fillet => Treatment::Chamfer,
            Treatment::Chamfer => Treatment::Fillet,
        }
    }

    pub fn label(self) -> String {
        tr!(match self {
            Treatment::Fillet => "tool.fillet",
            Treatment::Chamfer => "tool.chamfer",
        })
    }
}

/// mm. Below this OCCT refuses or builds an invisible blend; it floors a typed value and marks a drag sitting on the
/// origin as asking for no feature.
pub const MIN_EDGE_VALUE: f64 = 0.001;

/// A runaway guard so a flick cannot run the number to 10^4 mm and fire doomed rebuilds; the kernel decides what
/// builds. Half the diagonal is past a full round on a cube. Typed values are not clamped.
pub const MAX_DIAGONAL_FRACTION: f64 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub min: f64,
    pub max: f64,
}

/// mm, the same cap on both sides since an overrunning chamfer is no more buildable than a fillet. Infinity when
/// there is no geometry to measure.
pub fn drag_limit(diagonal: Option<f64>) -> f64 {
    match diagonal {
        Some(d) if d > 0.0 && d.is_finite() => (d * MAX_DIAGONAL_FRACTION).max(MIN_EDGE_VALUE),
        _ => f64::INFINITY,
    }
}

pub fn value_bounds(diagonal: Option<f64>) -> Bounds {
    Bounds { min: MIN_EDGE_VALUE, max: drag_limit(diagonal) }
}

pub fn clamp_value(v: f64, b: Bounds) -> f64 {
    if !v.is_finite() {
        return b.min;
    }
    v.max(b.min).min(b.max)
}

/// The kernel's answers on size in one gesture on one question (treatment, edges), reset when it changes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BlendRange {
    /// The largest size seen to build that is below every refusal.
    pub built: Option<f64>,
    /// The smallest size the kernel refused.
    pub refused: Option<f64>,
}

impl BlendRange {
    /// A refusal drops a `built` at or above it, so the range never claims a size both builds and does not.
    pub fn note(self, value: f64, built: bool) -> BlendRange {
        if !value.is_finite() || value <= 0.0 {
            return self;
        }
        if !built {
            let refused = self.refused.map_or(value, |r| r.min(value));
            return BlendRange { built: self.built.filter(|b| *b < refused), refused: Some(refused) };
        }
        let below = self.refused.is_none_or(|r| value < r);
        BlendRange { built: if below { Some(self.built.unwrap_or(0.0).max(value)) } else { self.built }, ..self }
    }

    /// Assumes a size refused is refused at every larger size on the same edges, and one that built builds smaller, so
    /// a drag past the limit sends no doomed request per move and turns back at once.
    pub fn verdict(&self, value: f64) -> Verdict {
        const SAME: f64 = 1e-9;
        if !value.is_finite() || value <= 0.0 {
            return Verdict::Unknown;
        }
        if self.refused.is_some_and(|r| value >= r - SAME) {
            return Verdict::Refused;
        }
        if self.built.is_some_and(|b| value <= b + SAME) {
            return Verdict::Builds;
        }
        Verdict::Unknown
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Builds,
    Refused,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Commit {
    Commit { value: f64, unverified: bool },
    Cancel,
    Stay,
}

/// `shown` is the size on screen (None for the bare model), `settled` says the reply for `value` landed, `typed` that
/// it came from the keyboard. A refused drag commits what is shown or nothing; a refused typed value stays open. An
/// unanswered value commits `unverified`, and a refusal that lands later puts back what was shown.
pub fn commit_decision(value: f64, verdict: Verdict, settled: bool, shown: Option<f64>, typed: bool) -> Commit {
    if verdict == Verdict::Refused {
        if typed {
            return Commit::Stay;
        }
        return match shown {
            Some(s) if s >= MIN_EDGE_VALUE => Commit::Commit { value: s, unverified: false },
            _ => Commit::Cancel,
        };
    }
    Commit::Commit { value, unverified: !(settled || verdict == Verdict::Builds) }
}

/// The first number in `s`, with what follows it.
fn number(s: &str) -> Option<(f64, &str)> {
    let end = s.find(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))).unwrap_or(s.len());
    let n: f64 = s[..end].parse().ok()?;
    Some((n, &s[end..]))
}

/// The engine offers the largest size that builds only in its message, as "It fits up to 4.99mm", and a two distance
/// chamfer's with the second distance it takes there, as "It fits up to 3.99mm with distance 2 at 9.97mm".
fn fits_up_to(message: &str) -> (Option<f64>, Option<f64>) {
    let lower = message.to_lowercase();
    let Some(at) = lower.find("fits up to ") else { return (None, None) };
    let Some((size, rest)) = number(&lower[at + 11..]) else { return (None, None) };
    let Some(rest) = rest.strip_prefix("mm") else { return (None, None) };
    let second = rest.strip_prefix(" with distance 2 at ").and_then(number).filter(|(_, r)| r.starts_with("mm"));
    (Some(size).filter(|s| *s > 0.0), second.map(|(n, _)| n).filter(|n| *n > 0.0))
}

/// A length as the drag shows it, in mm with at most three decimals.
pub fn fmt_length(mm: f64) -> String {
    let mut s = format!("{mm:.3}");
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    format!("{} mm", s.replace('.', &crate::i18n::decimal_mark().to_string()))
}

/// The `fits`, `size` and `size2` of the messages that name what a blend fits up to. The engine rounds its size down,
/// so it is cut, not rounded, to the three decimals shown.
pub fn fits_args(message: &str) -> (&'static str, String, String) {
    let cut = |v: f64| fmt_length((v * 1000.0).floor() / 1000.0);
    match fits_up_to(message) {
        (Some(a), Some(b)) => ("pair", cut(a), cut(b)),
        (Some(a), None) => ("yes", cut(a), String::new()),
        _ => ("no", String::new(), String::new()),
    }
}

fn too_large(kind: Treatment, n: usize, message: &str) -> String {
    let (fits, size, size2) = fits_args(message);
    tr!("pick.blendTooLarge", kind = kind.kind(), n = n, fits = fits, size = size, size2 = size2)
}

/// `code` is the engine's category; the message is only read for older wording that carried no code, and for the size
/// a too large blend fits up to.
pub fn refusal_reason(kind: Treatment, n: usize, code: Option<&str>, message: &str) -> String {
    let k = kind.kind();
    match code {
        Some("blendTooLarge") => return too_large(kind, n, message),
        Some("blendHasNoEnd") => return tr!("tool.fillet.noEnd", kind = k, n = n),
        Some("edgeAlreadySmooth") => return tr!("tool.fillet.smooth", kind = k, n = n),
        Some("edgeIsSeam") => return tr!("tool.fillet.seam", kind = k, n = n),
        Some("blendFoldsOver") => return tr!("tool.fillet.foldsOver", kind = k),
        _ => {}
    }
    let lower = message.to_lowercase();
    if lower.contains("smaller value") || lower.contains("smaller length value") {
        return too_large(kind, n, message);
    }
    for lead in ["Fillet failed on ", "Chamfer failed on "] {
        if let Some(rest) = message.strip_prefix(lead) {
            if let Some((_, after)) = rest.split_once(':') {
                return after.trim_start().to_string();
            }
        }
    }
    message.to_string()
}

pub struct Scrub {
    /// The signed offset in mm when the handle was grabbed.
    pub grab_signed: f64,
    /// The swipe in mm at grab time, and now.
    pub grab_proj: f64,
    pub proj: f64,
    /// The snap granularity in mm.
    pub step: f64,
    /// The largest magnitude the drag may reach, either side of the origin.
    pub limit: f64,
}

/// Relative to the grab so taking hold never makes the value jump, snapped to a clean step, held inside the limit.
/// Exactly 0 within one step of the origin: half a step is about 4 px, too fine a detent for abandoning the gesture.
pub fn scrub_signed(s: &Scrub) -> f64 {
    let raw = s.grab_signed + (s.proj - s.grab_proj);
    if !raw.is_finite() {
        return 0.0;
    }
    let dead = if s.step > 0.0 && s.step.is_finite() { s.step } else { MIN_EDGE_VALUE };
    if raw.abs() < dead {
        return 0.0;
    }
    let stepped = snap(raw, s.step);
    let limit = if s.limit > 0.0 { s.limit } else { f64::INFINITY };
    stepped.signum() * stepped.abs().min(limit)
}

pub fn snap(v: f64, step: f64) -> f64 {
    if step > 0.0 && step.is_finite() {
        let n = (v / step).round() * step;
        // Rounds away the float noise of n * 0.1.
        (n * 1e6).round() / 1e6
    } else {
        v
    }
}

/// The 1, 2, 5 step about ten pixels make at the handle, a tenth of it with Shift held.
pub fn snap_step(mm_per_px: f64, fine: bool) -> f64 {
    let want = (mm_per_px * 10.0).max(1e-4);
    let decade = 10f64.powf(want.log10().floor());
    let step = [1.0, 2.0, 5.0, 10.0].iter().map(|m| m * decade).find(|s| *s >= want * 0.999).unwrap_or(decade * 10.0);
    if fine { step / 10.0 } else { step }
}

/// `positive` is what the arrow's own direction means, the magnitude is the radius or setback. At exactly 0 the kind
/// is arbitrary, and callers keep the one they showed so the label does not flicker.
pub fn treatment_at(positive: Treatment, signed: f64) -> (Treatment, f64) {
    (if signed < 0.0 { positive.other() } else { positive }, signed.abs())
}

/// What Tab does, the only way to switch a typed value, which has no side of the origin.
pub fn switch_treatment(kind: Treatment, value: f64, b: Bounds) -> (Treatment, f64) {
    (kind.other(), clamp_value(value, b))
}

/// The opening value when a gesture opens without a drag: the usual 2 mm fillet or 1 mm chamfer, held to the bounds.
pub fn seed_value(kind: Treatment, b: Bounds) -> f64 {
    clamp_value(if kind == Treatment::Fillet { 2.0 } else { 1.0 }, b)
}

/// Pixels. A shorter projection gives a perpendicular that swings with the projection's rounding.
const MIN_EDGE_PX: f32 = 4.0;

/// All in screen pixels. To the line, not the segment, since a blend runs the edge's whole length. `outward` sets only
/// the sign; with the edge seen end on there is no perpendicular, and it falls back to travel along `outward`.
pub fn swipe_offset_px(origin: Vec2, edge_dir: Vec2, outward: Vec2, cursor: Vec2) -> f32 {
    let d = cursor - origin;
    let out = outward.try_normalize();
    let tangent = if edge_dir.length() >= MIN_EDGE_PX { edge_dir.try_normalize() } else { None };
    let Some(t) = tangent else { return out.map_or(0.0, |o| d.dot(o)) };
    let mut n = Vec2::new(-t.y, t.x);
    if out.is_some_and(|o| n.dot(o) < 0.0) {
        n = -n;
    }
    d.dot(n)
}

/// How many edges one fillet or chamfer may take. On 8192 boxes (98k edges) the preview took 16 s at 1,000 edges and
/// 45 s at 5,000. At 20,000 on a big robot it ran past a minute and took the PC from 8 GB free memory to 0.1 GB.
pub const EDGE_WARN: usize = 3000;
pub const EDGE_CAP: usize = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Go,
    Warn,
    Refuse,
}

pub fn edge_gate(count: usize) -> Gate {
    if count > EDGE_CAP {
        Gate::Refuse
    } else if count > EDGE_WARN {
        Gate::Warn
    } else {
        Gate::Go
    }
}

/// A preview, everything but its id.
pub fn feature_key(f: &Value) -> String {
    let mut rest = f.clone();
    if let Some(o) = rest.as_object_mut() {
        o.remove("id");
    }
    rest.to_string()
}

fn question_key(f: &Value, dragged: &[&str]) -> String {
    let mut rest = f.clone();
    if let Some(o) = rest.as_object_mut() {
        for k in std::iter::once(&"id").chain(dragged) {
            o.remove(*k);
        }
    }
    rest.to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    Built,
    /// The kernel refused the preview, with the reason shown.
    Refused(String),
    /// The whole build failed, which says nothing about the preview.
    Failed,
}

/// Which preview values built or were refused, so a refused value holds the last one that built.
#[derive(Default)]
pub struct Outcomes {
    /// None when none shows.
    pub shown: Option<Value>,
    /// The refusal painted on the handle, the value box and the status.
    pub refusal: Option<String>,
    refused: HashMap<String, String>,
    built: HashSet<String>,
}

impl Outcomes {
    /// Forget every answer. The refusal on screen stays until `refresh` decides.
    pub fn forget(&mut self) {
        self.shown = None;
        self.refused.clear();
        self.built.clear();
    }

    /// The reply for the preview it was sent, which in a fast drag is often not the one on the handle any more.
    /// `sent` is None when the reply's document had no preview.
    pub fn note(&mut self, sent: Option<&Value>, reply: Reply) {
        match (sent, reply) {
            (None, _) => self.shown = None,
            (Some(f), Reply::Refused(why)) => drop(self.refused.insert(feature_key(f), why)),
            (Some(f), Reply::Built) => {
                self.shown = Some(f.clone());
                self.built.insert(feature_key(f));
            }
            (Some(_), Reply::Failed) => {}
        }
    }

    pub fn verdict(&self, key: &str) -> Verdict {
        if self.refused.contains_key(key) {
            Verdict::Refused
        } else if self.built.contains(key) {
            Verdict::Builds
        } else {
            Verdict::Unknown
        }
    }

    /// The reply for this very preview has landed and is on screen.
    pub fn settled(&self, key: &str) -> bool {
        self.shown.as_ref().is_some_and(|f| feature_key(f) == key)
    }

    /// Differs from `current` only in the `dragged` fields, so a value held from earlier in the drag still counts.
    pub fn shown_for(&self, current: &Value, dragged: &[&str]) -> Option<&Value> {
        self.shown.as_ref().filter(|f| question_key(f, dragged) == question_key(current, dragged))
    }

    /// None when nothing is pushed. Stays up until a value builds, so the box does not flicker; true when it changed.
    pub fn refresh(&mut self, key: Option<&str>) -> bool {
        let reason = key.and_then(|k| match self.refused.get(k) {
            Some(why) => Some(why.clone()),
            None if self.built.contains(k) => None,
            None => self.refusal.clone(),
        });
        if reason == self.refusal {
            return false;
        }
        self.refusal = reason;
        true
    }
}
