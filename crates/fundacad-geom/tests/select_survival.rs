//! The selector survival gate on this engine: sidecar/tools/corpus/corpus_selectors.json
//! scored as sidecar/tools/eval_selector_survival.py scores it, at the Python gate.

use fundacad_geom::select::{eval, Tuning};
use serde_json::Value;

const CORPUS: &str = include_str!("../../../sidecar/tools/corpus/corpus_selectors.json");

#[test]
fn survival_rate_meets_the_python_gate() {
    let corpus: Value = serde_json::from_str(CORPUS).expect("corpus is JSON");
    let mut missed = Vec::new();
    let (metrics, _) = eval::run(&corpus, Tuning::shipped(), |line| missed.push(line.to_owned()));
    let rate = metrics["v2_rate"].as_f64().unwrap_or(0.0);
    assert!(rate >= 0.990, "v2_rate {rate}, {missed:?}");
    assert_eq!(metrics["invalid_count"], serde_json::json!(0.0), "{missed:?}");
    // Exactly the two cases the Python resolver misses under the shipped tuning.
    assert_eq!(
        missed,
        ["  case moved_007 missed", "  case moved_027 missed"],
        "the misses differ from the Python engine's"
    );
}
