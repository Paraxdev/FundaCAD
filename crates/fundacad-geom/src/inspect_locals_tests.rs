use opencascade::primitives::Shape;
use serde_json::{json, Value};

use super::{inspect_bodies_at, locals_held, InspectBody, Level};
use crate::kernel;

// Far above the uids a build hands out, so a body built by another test never shares one.
const UID: u64 = 1 << 60;

fn inspected(shape: &Shape, identity: (u64, u64)) -> Value {
    let body = InspectBody { id: json!("body1"), name: json!("Body1"), shape: Some(shape), identity: Some(identity) };
    inspect_bodies_at(&[body], Level::Summary, 0, 0).expect("inspected").remove(0)
}

fn tilted_box(size: [f64; 3]) -> Shape {
    let b = kernel::make_box(size[0], size[1], size[2]).unwrap();
    kernel::translated(&kernel::rotated(&b, [0.0, 0.0, 30.0]).unwrap(), [12.0, -4.0, 7.5]).unwrap()
}

#[test]
fn a_copy_of_a_built_body_under_its_identity_is_not_measured_again() {
    let first = tilted_box([10.0, 20.0, 30.0]);
    let want = inspected(&first, (UID + 1, 1));
    // Another test releasing the cache between the two inspects drops the measurement, so try again then.
    let measured_again = (0..5).all(|_| {
        inspected(&first, (UID + 1, 1));
        let copy = kernel::copy_topology(&first).unwrap();
        assert_eq!(inspected(&copy, (UID + 1, 1)), want);
        locals_held(&[&copy]) == 1
    });
    assert!(!measured_again, "every copy was measured again");
}

#[test]
fn a_body_with_a_new_generation_is_measured_for_its_new_shape() {
    let small = tilted_box([10.0, 10.0, 10.0]);
    let big = tilted_box([10.0, 10.0, 20.0]);
    assert_eq!(inspected(&small, (UID + 2, 1))["volume"], json!(1000.0));
    assert_eq!(inspected(&big, (UID + 2, 2))["volume"], json!(2000.0));
}
