//! Phase timings for the benchmarks, the Rust side of `_timed` in
//! sidecar/tools/bench_import.py.
//!
//! Recording is off unless `FUNDACAD_BENCH_PHASES` is set, so the shipped
//! engine pays one relaxed atomic load per phase and nothing else.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static ON: AtomicBool = AtomicBool::new(false);
static READ: OnceLock<()> = OnceLock::new();

fn table() -> &'static Mutex<BTreeMap<&'static str, (f64, u64)>> {
    static T: OnceLock<Mutex<BTreeMap<&'static str, (f64, u64)>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn on() -> bool {
    READ.get_or_init(|| {
        let set = std::env::var_os("FUNDACAD_BENCH_PHASES").is_some_and(|v| v != "0");
        ON.store(set, Ordering::Relaxed);
    });
    ON.load(Ordering::Relaxed)
}

/// Time `f` under `name`, summing calls. Nested phases each keep their own
/// total, so an outer phase includes the inner ones, as bench_import.py's do.
pub fn phase<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
    if !on() {
        return f();
    }
    let began = Instant::now();
    let out = f();
    let secs = began.elapsed().as_secs_f64();
    if let Ok(mut t) = table().lock() {
        let e = t.entry(name).or_insert((0.0, 0));
        e.0 += secs;
        e.1 += 1;
    }
    out
}

/// `phase` for a name only known at runtime, a feature type say. The name is
/// interned (leaked once) so the table stays keyed by `&'static str`; nothing
/// is interned while recording is off.
pub fn phase_named<T>(name: &str, f: impl FnOnce() -> T) -> T {
    if !on() {
        return f();
    }
    static NAMES: OnceLock<Mutex<std::collections::HashSet<&'static str>>> = OnceLock::new();
    let names = NAMES.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let interned = match names.lock() {
        Ok(mut set) => match set.get(name) {
            Some(s) => *s,
            None => {
                let s: &'static str = Box::leak(name.to_owned().into_boxed_str());
                set.insert(s);
                s
            }
        },
        Err(_) => return f(),
    };
    phase(interned, f)
}

/// Every phase recorded so far, as `{"name": [seconds, calls]}`.
pub fn report() -> serde_json::Value {
    let Ok(t) = table().lock() else {
        return serde_json::Value::Null;
    };
    serde_json::Value::Object(
        t.iter()
            .map(|(k, (s, n))| {
                (
                    (*k).to_string(),
                    serde_json::json!([(s * 1000.0).round() / 1000.0, n]),
                )
            })
            .collect(),
    )
}

pub fn reset() {
    if let Ok(mut t) = table().lock() {
        t.clear();
    }
}
