//! The engine's share of the app's one-line timing per edit (src/diagnostics/editTiming.ts).

use std::time::Duration;

use serde_json::{json, Value};

use super::CacheStats;

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1e6).round() / 1e3
}

/// `copy` is everything before the replay (the snapshot copy or the checkpoint read), `post` what the engine did
/// beyond the replay and the meshing itself, so the four add up to `total`.
pub fn wire(s: &CacheStats, raw: &Value, total: Duration) -> Value {
    let post = total.saturating_sub(s.copy + s.replay + s.mesh_time);
    let slow = s.slowest.and_then(|(i, _)| raw.get("features")?.get(i)?.get("type")?.as_str());
    json!({
        "copy": ms(s.copy),
        "replay": ms(s.replay),
        "slow": slow,
        "post": ms(post),
        "mesh": ms(s.mesh_time),
        "meshed": s.meshed,
    })
}

#[cfg(test)]
#[path = "timing_tests.rs"]
mod tests;
