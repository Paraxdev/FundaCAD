//! sidecar/tools/eval_fillet_corpus.py on this engine: every case rebuilt, the
//! blend feature failed on an error (not a selector miss), on a result that is
//! not one valid solid, on too few faces, or on removed volume more than 2% off
//! the reference. The corpus self hash is left to the Python tool, whose float
//! formatting it depends on.

use std::collections::BTreeMap;

use fundacad_core::CadDocument;
use serde_json::Value;

use super::ops;
use crate::builder::{self, NoWatch};
use crate::kernel::{self, Kind};

const VOLUME_TOL: f64 = 0.02;

#[derive(Default)]
pub struct Report {
    pub count: usize,
    pub failed: usize,
    pub selector_miss: usize,
    pub per_edge: usize,
    pub combination: usize,
    pub other: usize,
    pub messages: BTreeMap<String, usize>,
    pub by_band: BTreeMap<String, (usize, usize)>,
    pub failed_ids: Vec<String>,
    /// Every case in corpus order: its id and "pass", "fail" or "selector-miss".
    pub outcomes: Vec<(String, &'static str)>,
}

fn is_selector_miss(msg: &str) -> bool {
    msg.to_lowercase().contains("no edge found")
}

/// One case: `None` when it passed, else what failed.
fn score(case: &Value, r: &mut Report) -> Result<(), String> {
    let doc = &case["doc"];
    let typed: CadDocument =
        serde_json::from_value(doc.clone()).map_err(|e| format!("document: {e}"))?;
    let built = builder::rebuild(&typed, doc, &NoWatch).map_err(|_| "cancelled".to_owned())?;
    let op_id = case["op_feature_id"].as_str().unwrap_or("");
    let id = case["id"].as_str().unwrap_or("?").to_owned();
    let band = case["band"].as_str().unwrap_or("").to_owned();
    r.by_band.entry(band.clone()).or_default().0 += 1;

    let mut failed = false;
    if let Some(err) = built
        .errors
        .iter()
        .find(|e| e.feature_id.as_deref() == Some(op_id))
    {
        if is_selector_miss(&err.message) {
            r.selector_miss += 1;
            r.outcomes.push((id, "selector-miss"));
            return Ok(());
        }
        failed = true;
        *r.messages.entry(err.message.clone()).or_default() += 1;
        let reasons: Vec<&str> = built
            .diagnostics
            .iter()
            .filter(|d| d["kind"] == "edgeOpFailed" && d["feature_id"] == op_id)
            .filter_map(|d| d["reason"].as_str())
            .collect();
        if reasons.contains(&"per-edge") {
            r.per_edge += 1;
        } else if reasons.contains(&"combination") {
            r.combination += 1;
        } else {
            r.other += 1;
        }
    } else {
        let mut checks: Vec<String> = Vec::new();
        let shapes: Vec<_> = built.bodies.iter().map(|b| &b.shape).collect();
        let part = match shapes.len() {
            0 => None,
            1 => Some(shapes[0].clone()),
            _ => Some(kernel::compound(shapes.iter().copied())),
        };
        match part {
            None => checks.push("no-body".into()),
            Some(part) => {
                if !(ops::is_valid(&part) && kernel::count(&part, Kind::Solid) == 1) {
                    checks.push("not-single-valid-solid".into());
                }
                let n = |k: &str| case[k].as_u64().unwrap_or(0) as usize;
                let min_faces = match n("min_faces") {
                    0 => n("pre_op_faces") + n("n_edges"),
                    m => m,
                };
                let faces = kernel::count(&part, Kind::Face);
                if faces < min_faces {
                    checks.push(format!("facecount({faces}<{min_faces})"));
                }
                let removed = case["pre_op_volume"].as_f64().unwrap_or(0.0) - kernel::volume(&part);
                let (reference, kind) = match case["expected_removed"].as_f64() {
                    Some(e) => (e, "analytic"),
                    None => (case["ref_removed"].as_f64().unwrap_or(0.0), "ref"),
                };
                if std::env::var_os("FILLET_EVAL_VERBOSE").is_some() {
                    eprintln!("  removed {removed} reference {reference} faces {faces}");
                }
                if removed <= 0.0 {
                    checks.push("removed<=0".into());
                } else if reference != 0.0
                    && (removed - reference).abs() > VOLUME_TOL * reference.abs()
                {
                    checks.push(format!("volume-{kind}"));
                }
            }
        }
        if !checks.is_empty() {
            failed = true;
            r.other += 1;
            *r.messages
                .entry(format!("invariant:{}", checks.join("+")))
                .or_default() += 1;
        }
    }
    if failed {
        r.failed += 1;
        r.failed_ids.push(id.clone());
        r.by_band.entry(band).or_default().1 += 1;
    }
    r.outcomes.push((id, if failed { "fail" } else { "pass" }));
    Ok(())
}

pub fn run(corpus: &Value, mut progress: impl FnMut(&str)) -> Result<Report, String> {
    let cases = corpus["cases"]
        .as_array()
        .ok_or("the corpus has no cases")?;
    let mut r = Report {
        count: cases.len(),
        ..Report::default()
    };
    for case in cases {
        score(case, &mut r)?;
        progress(case["id"].as_str().unwrap_or("?"));
    }
    Ok(r)
}

/// The Python tool's report, ending in its exact last line.
pub fn render(path: &str, corpus: &Value, r: &Report, show_ids: bool) -> String {
    let mut out = vec![format!(
        "corpus {path}: {} cases, seed {}",
        r.count, corpus["seed"]
    )];
    out.push("per-band failure:".into());
    for (band, (total, failed)) in &r.by_band {
        let rate = if *total > 0 {
            *failed as f64 / *total as f64 * 100.0
        } else {
            0.0
        };
        out.push(format!("  {band:>8}  {failed:3}/{total:<3}  {rate:5.1}%"));
    }
    out.push("taxonomy:".into());
    out.push(format!("  per-edge     {}", r.per_edge));
    out.push(format!("  combination  {}", r.combination));
    out.push(format!(
        "  other        {}  (invariant failures + errors w/o edge probe)",
        r.other
    ));
    out.push(format!(
        "  selector-miss {}  (separate from headline)",
        r.selector_miss
    ));
    if !r.messages.is_empty() {
        out.push("  top messages:".into());
        let mut top: Vec<(&String, &usize)> = r.messages.iter().collect();
        top.sort_by(|a, b| b.1.cmp(a.1));
        for (msg, n) in top.into_iter().take(10) {
            out.push(format!("    {n:4}  {msg}"));
        }
    }
    if show_ids && !r.failed_ids.is_empty() {
        out.push(format!("  failed ids: {}", r.failed_ids.join(", ")));
    }
    let rate = if r.count > 0 {
        r.failed as f64 / r.count as f64 * 100.0
    } else {
        0.0
    };
    out.push(format!(
        "failed={}/{} rate={rate:.2}% selector-miss={}",
        r.failed, r.count, r.selector_miss
    ));
    out.join("\n")
}
