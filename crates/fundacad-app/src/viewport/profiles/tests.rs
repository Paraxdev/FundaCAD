use glam::DVec2;
use serde_json::json;

use super::{areas, names, Area, Plane};

/// A 10 by 6 rectangle at (12, 4) on XY, the area a region point inside it names.
fn area(sketch: &str) -> Area {
    let ring = vec![DVec2::new(12.0, 4.0), DVec2::new(22.0, 4.0), DVec2::new(22.0, 10.0), DVec2::new(12.0, 10.0)];
    areas::of_outlines(sketch, Plane::named("XY").unwrap(), &[ring]).remove(0)
}

#[test]
fn a_held_entry_names_its_area_by_region_point_profile_or_sketch_id() {
    let a = area("s1");
    assert!(names(&a, &json!([13.0, 5.0, 0.0]), Some("s1")));
    assert!(!names(&a, &json!([13.0, 5.0, 0.0]), Some("s2")), "a point of another sketch");
    assert!(!names(&a, &json!([30.0, 5.0, 0.0]), Some("s1")), "a point outside the area");
    assert!(!names(&a, &json!([13.0, 5.0, 0.0]), None), "a point with no sketch named");
    assert!(!names(&a, &json!([13.0, 5.0]), Some("s1")));
    assert!(names(&a, &json!({"sketch": "s1", "region": [21.0, 9.0, 0.0]}), None));
    assert!(!names(&a, &json!({"sketch": "s2", "region": [21.0, 9.0, 0.0]}), Some("s1")));
    assert!(!names(&a, &json!({"sketch": "s1"}), Some("s1")));
    assert!(names(&a, &json!("s1"), None));
    assert!(!names(&a, &json!("s2"), Some("s1")));
    assert!(!names(&a, &json!(null), Some("s1")));
}
