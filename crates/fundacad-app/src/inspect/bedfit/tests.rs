use super::*;

#[test]
fn fits_as_it_sits() {
    assert_eq!(fit([120.0, 80.5, 30.0], [220.0, 220.0, 250.0]), (true, 1.0));
    assert_eq!(verdict([120.0, 80.5, 30.0], [220.0, 220.0, 250.0]), "Fits the 220 x 220 x 250 mm bed");
}

#[test]
fn exactly_the_bed_fits() {
    assert_eq!(fit([180.0, 180.0, 180.0], [180.0, 180.0, 180.0]), (true, 1.0));
}

#[test]
fn too_big_names_the_scale_rounded_down() {
    let (fits, scale) = fit([300.0, 100.0, 40.0], [256.0, 256.0, 256.0]);
    assert!(!fits);
    assert!((scale - 256.0 / 300.0).abs() < 1e-12);
    assert_eq!(
        verdict([300.0, 100.0, 40.0], [256.0, 256.0, 256.0]),
        "Too big for the 256 x 256 x 256 mm bed, scale it to 85 %"
    );
}

#[test]
fn the_tightest_axis_sets_the_scale() {
    let (fits, scale) = fit([200.0, 400.0, 500.0], [220.0, 220.0, 250.0]);
    assert!(!fits);
    assert!((scale - 0.5).abs() < 1e-12);
}

#[test]
fn a_flat_model_ignores_its_zero_axis() {
    assert_eq!(fit([10.0, 0.0, 5.0], [180.0, 180.0, 180.0]), (true, 1.0));
    assert_eq!(label([220.0, 220.0, 250.0]), "220 x 220 x 250");
    assert_eq!(PRESETS.iter().map(|b| b.id).collect::<Vec<_>>(), ["180", "220x250", "256", "300", "350"]);
}
