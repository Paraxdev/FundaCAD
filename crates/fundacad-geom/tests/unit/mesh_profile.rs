use fundacad_geom::mesh::profile::*;

#[test]
fn tiers_follow_the_body_count() {
    assert_eq!(viewport_profile(1).size_scale, 1.0);
    assert_eq!(viewport_profile(1).angular, 0.18);
    assert_eq!(viewport_profile(1199).size_scale, 1.0);
    assert_eq!(viewport_profile(1200).size_scale, 2.0);
    assert_eq!(viewport_profile(1200).angular, 0.26);
    assert_eq!(viewport_profile(2200).size_scale, 4.0);
    assert_eq!(viewport_profile(5000).angular, 0.35);
    assert!(viewport_profile(1).display_normals());
    assert!(!viewport_profile(1200).display_normals());
}

#[test]
fn effective_tolerance_scales_the_default() {
    assert_eq!(effective_tolerance(0.1, 1.0), 0.002);
    assert!((effective_tolerance(0.05, 1.0) - 0.001).abs() < 1e-15);
    assert!((effective_tolerance(0.1, 4.0) - 0.008).abs() < 1e-15);
}
