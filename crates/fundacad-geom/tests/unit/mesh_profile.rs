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

#[test]
fn a_body_of_many_faces_meshes_coarser() {
    let one = viewport_profile(1);
    assert_eq!(one.for_faces(19_999), one);
    assert_eq!(one.for_faces(20_000).size_scale, 4.0);
    assert_eq!(one.for_faces(20_000).angular, 0.35);
    assert_eq!(one.for_faces(89_776).size_scale, 8.0);
    assert_eq!(one.for_faces(89_776).angular, 0.5);
    assert!(!one.for_faces(20_000).display_normals());
    assert_eq!(viewport_profile(2200).for_faces(20_000), viewport_profile(2200));
    assert_eq!(viewport_profile(2200).for_faces(50_000).size_scale, 8.0);
}

const MIB: usize = 1 << 20;

/// The profiles `fit` meshed, with whether each was a clean remesh, and the one it kept.
fn fitted(faces: usize, size_at: impl Fn(f64) -> usize) -> (Vec<(f64, bool)>, ViewportProfile) {
    let mut meshed = Vec::new();
    let kept = fit(viewport_profile(1), faces, 112 * MIB, &|| false, |p, clean| {
        meshed.push((p.size_scale, clean));
        (p, size_at(p.size_scale))
    });
    (meshed, kept)
}

#[test]
fn a_body_past_the_face_tier_that_surely_fits_finer_climbs_back_to_full_quality() {
    let (meshed, kept) = fitted(20_000, |_| 2 * MIB);
    assert_eq!(meshed, vec![(4.0, false), (1.0, true)]);
    assert_eq!(kept, viewport_profile(1));
}

#[test]
fn a_body_that_fits_its_tier_but_not_surely_the_next_stays_on_it() {
    let (meshed, kept) = fitted(89_776, |s| if s >= 8.0 { 80 * MIB } else { 150 * MIB });
    assert_eq!(meshed, vec![(8.0, false)]);
    assert_eq!(kept, ViewportProfile { size_scale: 8.0, angular: 0.5 });
}

#[test]
fn a_finer_step_that_comes_out_past_the_budget_is_dropped() {
    let (meshed, kept) = fitted(20_000, |s| if s >= 4.0 { 10 * MIB } else { 130 * MIB });
    assert_eq!(meshed, vec![(4.0, false), (1.0, true)]);
    assert_eq!(kept, ViewportProfile { size_scale: 4.0, angular: 0.35 });
}

#[test]
fn a_body_past_the_budget_steps_coarser_until_it_fits() {
    let (meshed, kept) = fitted(130_000, |s| if s >= 16.0 { 100 * MIB } else { 150 * MIB });
    assert_eq!(meshed, vec![(8.0, false), (16.0, true)]);
    assert_eq!(kept, ViewportProfile { size_scale: 16.0, angular: 0.6 });
}

#[test]
fn a_small_body_past_the_budget_steps_coarser_and_the_coarsest_is_kept_when_none_fits() {
    let (meshed, kept) = fitted(5_000, |_| 300 * MIB);
    assert_eq!(meshed, vec![(1.0, false), (4.0, true), (8.0, true), (16.0, true)]);
    assert_eq!(kept, ViewportProfile { size_scale: 16.0, angular: 0.6 });
}

#[test]
fn a_small_body_that_fits_meshes_once_at_the_reply_profile() {
    let (meshed, kept) = fitted(5_000, |_| MIB);
    assert_eq!(meshed, vec![(1.0, false)]);
    assert_eq!(kept, viewport_profile(1));
}

#[test]
fn a_stopped_pass_meshes_no_further_profile() {
    let mut meshed = Vec::new();
    fit(viewport_profile(1), 5_000, 112 * MIB, &|| true, |p, _| {
        meshed.push(p.size_scale);
        (p, 300 * MIB)
    });
    assert_eq!(meshed, vec![1.0]);
}
