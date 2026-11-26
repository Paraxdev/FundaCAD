use glam::Vec3;
use serde_json::json;

use super::*;
use crate::inspect::tests::solid as block2;

fn row(k: &str, v: &str) -> Row {
    (k.to_string(), v.to_string())
}

#[test]
fn one_box_off_the_origin() {
    let b = block2(Vec3::new(3.0, -2.0, 5.0), Vec3::new(7.0, 5.0, 7.0));
    let p = of([&b]).unwrap();
    assert!((p.volume - 56.0).abs() < 1e-9);
    assert!((p.area - 2.0 * (28.0 + 8.0 + 14.0)).abs() < 1e-9);
    assert!((p.com - DVec3::new(5.0, 1.5, 6.0)).length() < 1e-9);
    assert_eq!((p.min, p.max), (DVec3::new(3.0, -2.0, 5.0), DVec3::new(7.0, 5.0, 7.0)));
    assert_eq!(
        rows(&p, true),
        vec![
            row("Volume", "56 mm³"),
            row("Surface area", "100 mm²"),
            row("Center of mass", "5, 1.5, 6"),
            row("Bounding box", "4 × 7 × 2 mm"),
        ]
    );
}

#[test]
fn many_bodies_weigh_the_centre() {
    let a = block2(Vec3::ZERO, Vec3::new(2.0, 2.0, 2.0));
    let b = block2(Vec3::new(10.0, 0.0, 0.0), Vec3::new(14.0, 2.0, 2.0));
    let p = of([&a, &b]).unwrap();
    assert!((p.volume - 24.0).abs() < 1e-9);
    // 8 at x=1, 16 at x=12
    assert!((p.com.x - (8.0 + 16.0 * 12.0) / 24.0).abs() < 1e-9);
    assert_eq!(p.size(), [14.0, 2.0, 2.0]);
}

#[test]
fn nothing_has_no_properties() {
    assert_eq!(of(std::iter::empty()), None);
    assert_eq!(of([&Body::default()]), None);
}

#[test]
fn a_faulty_body_drops_volume_and_centre() {
    let mut b = block2(Vec3::new(1.0, 1.0, 1.0), Vec3::new(2.0, 3.0, 4.0));
    assert_eq!(fault(&b), None);
    b.fields.insert("fault".into(), json!("open shell"));
    assert_eq!(fault(&b).as_deref(), Some("open shell"));
    let p = of([&b]).unwrap();
    assert_eq!(rows(&p, false), vec![row("Surface area", "22 mm²"), row("Bounding box", "1 × 2 × 3 mm")]);
    let mut c = Body::default();
    c.fields.insert("insideOut".into(), json!(true));
    assert_eq!(fault(&c).as_deref(), Some("its faces point inward"));
}

#[test]
fn titles() {
    assert_eq!(title(&[]), "All bodies");
    assert_eq!(title(&["Lid".into()]), "Lid");
    assert_eq!(title(&["Lid".into(), "Box".into(), "Pin".into()]), "3 bodies");
}
