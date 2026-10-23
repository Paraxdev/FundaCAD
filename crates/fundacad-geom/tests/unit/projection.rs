use fundacad_geom::projection::*;
use serde_json::{json, Value};
use std::collections::HashMap;

#[test]
fn silhouette_assignment_consumes_nearest_pairs_first() {
    let line = |y: f64| json!({"kind": "line", "x1": -1.0, "y1": y, "x2": 1.0, "y2": y});
    let e1 = json!({"id": "a", "curve": line(0.0)});
    let e2 = json!({"id": "bb", "curve": line(5.0)});
    let fresh = vec![line(5.5), line(0.5), line(9.0)];
    let got: HashMap<String, Option<Value>> = assign_silhouette(&[&e1, &e2], Some(&fresh)).into_iter().collect();
    assert_eq!(got["a"], Some(line(0.5)));
    assert_eq!(got["bb"], Some(line(5.5)));
    let stale: HashMap<_, _> = assign_silhouette(&[&e1], None).into_iter().collect();
    assert_eq!(stale["a"], None);
}
