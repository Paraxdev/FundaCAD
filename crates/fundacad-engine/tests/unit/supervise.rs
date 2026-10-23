use fundacad_engine::supervise::*;
use serde_json::json;
use serde_json::{Map, Value};
use std::time::{Duration, Instant};

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

#[test]
fn ops_get_the_clock_server_py_gives_them() {
    let c = Clocks::default();
    let empty = Map::new();
    assert_eq!(c.budget("rebuild", &empty), Budget::Stall(STALL_TIMEOUT));
    assert_eq!(c.budget("inspect", &empty), Budget::Stall(STALL_TIMEOUT));
    assert_eq!(c.budget("listFonts", &empty), Budget::Wall(JOB_TIMEOUT));
    assert_eq!(c.budget("migrateGeometry", &empty), Budget::Wall(JOB_TIMEOUT));
    assert_eq!(c.budget("generateShape", &empty), Budget::Wall(Duration::from_secs(180)));
    assert_eq!(c.budget("import", &obj(json!({"path": "/no/such/file"}))), Budget::Stall(Duration::from_secs(90)));
}

#[test]
fn an_export_budget_scales_with_its_bodies() {
    let c = Clocks::default();
    let small = obj(json!({"document": {"features": [{"id": "a"}]}}));
    assert_eq!(c.budget("export", &small), Budget::Stall(STALL_TIMEOUT));
    let parts: Vec<Value> = (0..3000).map(|i| json!({"id": i})).collect();
    let big = obj(json!({"document": {"features": [{"id": "im", "parts": parts}]}}));
    let Budget::Stall(d) = c.budget("export", &big) else { panic!("stall") };
    assert!((d.as_secs_f64() - 270.0).abs() < 1e-6, "{d:?}");
}

#[test]
fn beats_hold_off_a_stall_and_silence_does_not() {
    let t0 = Instant::now();
    let mut w = Watchdog::new(Budget::Stall(Duration::from_secs(1)), None);
    for i in 1..30u64 {
        assert_eq!(w.poll(i, false, t0 + Duration::from_millis(100 * i)), None);
    }
    let quiet = t0 + Duration::from_millis(2900) + Duration::from_millis(1001);
    assert_eq!(w.poll(29, false, quiet), Some(Breach::Stalled(Duration::from_secs(1))));
}

#[test]
fn a_wall_clock_ignores_beats() {
    let t0 = Instant::now();
    let mut w = Watchdog::new(Budget::Wall(Duration::from_secs(1)), None);
    assert_eq!(w.poll(1, false, t0 + Duration::from_millis(900)), None);
    assert_eq!(w.poll(2, false, t0 + Duration::from_millis(1100)), Some(Breach::TimedOut));
}

#[test]
fn a_cancel_is_given_its_grace_first() {
    let t0 = Instant::now();
    let mut w = Watchdog::new(Budget::Stall(STALL_TIMEOUT), Some(Duration::from_secs(2)));
    assert_eq!(w.poll(0, true, t0 + Duration::from_secs(1)), None);
    assert_eq!(w.poll(0, true, t0 + Duration::from_millis(2500)), None);
    assert_eq!(w.poll(0, true, t0 + Duration::from_millis(3100)), Some(Breach::IgnoredCancel));
    let mut deaf = Watchdog::new(Budget::Stall(STALL_TIMEOUT), None);
    assert_eq!(deaf.poll(0, true, t0 + Duration::from_secs(30)), None);
}

#[test]
fn breach_messages_match_server_py() {
    let m = Breach::Stalled(Duration::from_secs(60)).result();
    assert!(m["error"]["message"].as_str().unwrap().starts_with("one operation stalled for over 60 s"));
    assert_eq!(Breach::IgnoredCancel.result()["cancelled"], true);
}

#[test]
fn a_stall_names_where_it_was() {
    let m = Breach::Stalled(Duration::from_secs(60)).result_in(Some("chamfer > blend_section"));
    let text = m["error"]["message"].as_str().unwrap();
    assert!(text.starts_with("one operation stalled for over 60 s"));
    assert!(text.ends_with("(it was stuck in chamfer > blend_section)"), "{text}");
}
