//! The geometry engine's jobs, what `fundacad --engine` runs.

use fundacad_engine::{error_result, JobContext, Jobs};
use fundacad_protocol::JobResult;
use serde_json::{Map, Value};

#[derive(Default)]
pub struct GeomJobs;

impl Jobs for GeomJobs {
    fn rebuild(
        &mut self,
        _doc: &Value,
        _tolerance: f64,
        _known: &Map<String, Value>,
        _fresh: bool,
        _ctx: &JobContext,
    ) -> JobResult {
        error_result("rebuild is not ported to the Rust engine yet")
    }
}
