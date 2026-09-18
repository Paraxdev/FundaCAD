//! Per-face colours packed as a palette plus run-length encoding, the Rust twin
//! of `src/document/faceColors.ts` (decode, dominant) and the Python engine's `face_colors.py`
//! (encode, which only the engine writes).

use indexmap::IndexMap;
use serde_json::Value;

use crate::schema::{Extra, FaceColorRuns, Real};

/// The run index for a face with no colour of its own.
pub const NO_COLOR: i64 = -1;

/// `None` when no face carries a colour, which must add nothing to the document.
pub fn encode<S: AsRef<str>>(colors: &[Option<S>]) -> Option<FaceColorRuns> {
    if !colors
        .iter()
        .any(|c| c.as_ref().is_some_and(|s| !s.as_ref().is_empty()))
    {
        return None;
    }
    let mut palette: Vec<String> = Vec::new();
    let mut seen: IndexMap<&str, i64> = IndexMap::new();
    let mut runs: Vec<(i64, i64)> = Vec::new();
    for c in colors {
        let i = match c.as_ref().map(AsRef::as_ref).filter(|s| !s.is_empty()) {
            Some(s) => *seen.entry(s).or_insert_with(|| {
                palette.push(s.to_owned());
                i64::try_from(palette.len()).unwrap_or(i64::MAX) - 1
            }),
            None => NO_COLOR,
        };
        match runs.last_mut() {
            Some(last) if last.1 == i => last.0 += 1,
            _ => runs.push((1, i)),
        }
    }
    let runs = runs
        .into_iter()
        .map(|(n, i)| [Real::from(n), Real::from(i)])
        .collect();
    Some(FaceColorRuns {
        palette,
        runs,
        extra: Extra::new(),
    })
}

/// JavaScript's `Math.floor(Number(x))` over a JSON value.
fn js_floor_number(v: Option<&Value>) -> f64 {
    let n = match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
    };
    n.floor()
}

/// Unpacks to exactly `count` entries, tolerant of anything a hand-edited or
/// truncated document holds: a run it cannot read ends the decode, a run past
/// the end or naming a missing palette slot means no colour.
pub fn decode_value(enc: Option<&Value>, count: usize) -> Vec<Option<String>> {
    let mut out = vec![None; count];
    let Some(Value::Array(runs)) = enc.and_then(|e| e.get("runs")) else {
        return out;
    };
    let palette: &[Value] = match enc.and_then(|e| e.get("palette")) {
        Some(Value::Array(p)) => p,
        _ => &[],
    };
    let mut at = 0usize;
    for run in runs {
        let len = js_floor_number(run.get(0));
        let idx = js_floor_number(run.get(1));
        if !len.is_finite() || !idx.is_finite() {
            break;
        }
        if len <= 0.0 {
            continue;
        }
        let hex = if idx >= 0.0 && idx < palette.len() as f64 {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            palette
                .get(idx as usize)
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let end = if len >= count as f64 {
            count
        } else {
            at.saturating_add(len as usize).min(count)
        };
        for slot in out.iter_mut().take(end).skip(at) {
            slot.clone_from(&hex);
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let next = at.saturating_add(len.min(usize::MAX as f64) as usize);
        at = next;
        if at >= count {
            break;
        }
    }
    out
}

pub fn decode(enc: Option<&FaceColorRuns>, count: usize) -> Vec<Option<String>> {
    let v = enc.and_then(|e| serde_json::to_value(e).ok());
    decode_value(v.as_ref(), count)
}

/// The colour to treat as the whole body's own, by face count, ties to the
/// colour that appears first.
pub fn dominant<S: AsRef<str>>(colors: &[Option<S>]) -> Option<String> {
    let mut tally: IndexMap<&str, usize> = IndexMap::new();
    for c in colors
        .iter()
        .filter_map(|c| c.as_ref())
        .map(AsRef::as_ref)
        .filter(|s| !s.is_empty())
    {
        *tally.entry(c).or_default() += 1;
    }
    let mut best: Option<(&str, usize)> = None;
    for (c, n) in tally {
        if best.map_or(true, |(_, b)| n > b) {
            best = Some((c, n));
        }
    }
    best.map(|(c, _)| c.to_owned())
}
