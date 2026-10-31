use super::*;
use crate::gpu::Estimator;
use crate::{decode_mesh, BodyDesc, Camera, Quality, TracerOptions};

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[test]
fn a_software_band_follows_the_dispatch_time() {
    assert_eq!(adapt_rows(272, 1920, 1080, ms(30), ms(10)), 96);
    assert_eq!(adapt_rows(96, 1920, 1080, ms(10), ms(10)), 96);
    assert_eq!(adapt_rows(96, 1920, 1080, ms(1), ms(10)), 192);
    assert_eq!(adapt_rows(1080, 1920, 1080, ms(1), ms(10)), 1080);
    assert_eq!(adapt_rows(100, 1920, 1080, Duration::ZERO, ms(10)), 200);
    // 65536 paths at 1920 wide is 34 rows, 40 on the workgroup grid.
    assert_eq!(adapt_rows(48, 1920, 1080, ms(400), ms(10)), 40);
    assert_eq!(adapt_rows(8, 64, 48, ms(400), ms(10)), 48);
}

#[test]
fn a_coarse_picture_needs_two_bands_and_a_sample_timed_at_40_ms_or_more() {
    let cases = [
        (0, 48, None),
        (16, 31, None),
        (16, 32, None),
        (16, 48, None),
        (16, 31, Some(ms(500))),
        (16, 48, Some(ms(40) - Duration::from_nanos(1))),
        (16, 48, Some(ms(40))),
        (8, 1080, Some(ms(1000))),
    ];
    assert_eq!(
        cases.map(|(rows, height, cost)| coarse_block(rows, height, cost)),
        [None, None, Some(2), Some(2), None, None, Some(2), Some(8)]
    );
}

/// The floor keeps a band at 104 rows of 360 however long it takes, so only the time tells these two apart.
#[test]
fn a_small_canvas_on_a_slow_adapter_keeps_its_coarse_picture() {
    let rows = adapt_rows(104, 640, 360, ms(50), ms(10));
    assert_eq!(rows, 104);
    assert_eq!(coarse_block(rows, 360, Some(ms(175))), Some(2));
    assert_eq!(coarse_block(rows, 360, Some(ms(15))), None);
}

fn quad_frame(key: &str) -> Vec<u8> {
    let head = format!(r#"{{"key":"{key}","vertices":4,"indices":6,"normals":true}}"#);
    let mut b = (head.len() as u32).to_le_bytes().to_vec();
    b.extend_from_slice(head.as_bytes());
    b.resize(b.len().next_multiple_of(4), 0);
    let p = [-5f32, -5., 0., 5., -5., 0., 5., 5., 0., -5., 5., 0.];
    let n = [0f32, 0., 1.].repeat(4);
    p.iter().chain(&n).for_each(|f| b.extend_from_slice(&f.to_le_bytes()));
    [0u32, 1, 2, 0, 2, 3].iter().for_each(|i| b.extend_from_slice(&i.to_le_bytes()));
    b
}

fn camera(x: f32) -> Camera {
    serde_json::from_value(serde_json::json!({ "eye": [x, -8, 6], "target": [x, 0, 0], "up": [0, 0, 1], "fov": 50 }))
        .unwrap()
}

fn new_look() -> crate::Look {
    serde_json::from_str(r#"{"sunDir":[0.3,-0.4,1],"sunColor":[3,3,3]}"#).unwrap()
}

/// A finished sample of a quad, 64 by 48.
fn traced_quad() -> Option<Tracer> {
    let Ok(mut s) = Tracer::new(TracerOptions { software: true, ..Default::default() }) else {
        eprintln!("skipped: no adapter");
        return None;
    };
    let bodies: Vec<BodyDesc> = serde_json::from_str(
        r#"[{"id":"body1","key":"body1:e1:7:0:0","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
             "materials":[{"color":[0.8,0.2,0.2],"roughness":0.4}]}]"#,
    )
    .unwrap();
    s.set_bodies(bodies);
    let (key, mesh) = decode_mesh(&quad_frame("body1:e1:7:0:0")).unwrap();
    s.add_mesh(&key, mesh);
    s.set_camera(camera(0.0));
    s.set_cap(4096);
    s.frame(64, 48, ms(12));
    Some(s)
}

#[test]
fn a_restart_of_three_bands_goes_by_the_time_of_its_sample() {
    let Some(mut s) = traced_quad() else { return };
    s.set_camera(camera(0.5));
    s.set_frame_budget(64 * 16);
    s.sample_cost = Some(ms(20));
    assert_eq!(s.advance(64, 48, Duration::ZERO), None, "a short sample comes soon enough");
    assert_eq!(s.frame(64, 48, ms(12))[3], 255);

    s.set_camera(camera(1.0));
    s.set_frame_budget(64 * 16);
    s.sample_cost = Some(ms(200));
    let px = s.advance(64, 48, Duration::ZERO).expect("a long sample has a picture first");
    assert_eq!(px[3], COARSE_ALPHA);
    assert_ne!(s.sample_cost, Some(ms(200)), "the coarse pass times the sample again");
}

#[test]
fn a_scene_change_forgets_the_time_and_a_camera_keeps_it() {
    let Some(mut s) = traced_quad() else { return };
    s.sample_cost = Some(ms(20));
    s.set_camera(camera(0.5));
    assert_eq!(s.sample_cost, Some(ms(20)), "a camera is the same scene");

    s.set_frame_budget(64 * 8);
    assert_eq!(s.sample_cost, Some(ms(20)), "a budget changes the bands, not what they add up to");

    s.set_look(new_look());
    assert_eq!(s.sample_cost, None, "a look");

    s.sample_cost = Some(ms(20));
    s.set_estimator(Estimator::Nee);
    assert_eq!(s.sample_cost, None, "an estimator");

    s.sample_cost = Some(ms(20));
    s.set_environment(None);
    assert_eq!(s.sample_cost, None, "an environment");

    s.sample_cost = Some(ms(20));
    s.set_bodies(vec![]);
    s.apply();
    assert_eq!(s.sample_cost, None, "a scene commit");

    s.sample_cost = Some(ms(20));
    s.resize(32, 24);
    assert_eq!(s.sample_cost, None, "a size");
}

#[test]
fn the_first_sample_after_a_scene_change_has_its_coarse_picture() {
    let Some(mut s) = traced_quad() else { return };
    s.sample_cost = Some(ms(20));
    s.set_look(new_look());
    s.rows = 16;
    let px = s.advance(64, 48, Duration::ZERO).expect("no time is known for the new scene");
    assert_eq!(px[3], COARSE_ALPHA);
}

#[test]
fn the_bands_so_far_give_the_time_of_a_whole_sample() {
    let Some(mut s) = traced_quad() else { return };
    s.spent = Duration::ZERO;
    s.row0 = 12;
    s.time_band(ms(5));
    assert_eq!((s.sample_cost, s.spent), (Some(ms(20)), ms(5)), "a quarter of the rows");
    s.row0 = 0;
    s.time_band(ms(25));
    assert_eq!((s.sample_cost, s.spent), (Some(ms(30)), Duration::ZERO), "a wrap ends the sample");
}

#[test]
fn a_reset_drops_the_time_of_the_sample_under_way() {
    let Some(mut s) = traced_quad() else { return };
    s.spent = ms(9);
    s.set_camera(camera(0.5));
    assert_eq!(s.spent, Duration::ZERO);
}

#[test]
fn a_trace_times_its_sample() {
    let Some(s) = traced_quad() else { return };
    assert!(s.sample_cost.is_some_and(|c| c > Duration::ZERO), "{:?}", s.sample_cost);
    assert_eq!(s.spent, Duration::ZERO, "a finished sample leaves none under way");
}

#[test]
fn a_picture_leaves_the_viewport_its_time() {
    let Some(mut s) = traced_quad() else { return };
    s.sample_cost = Some(ms(20));
    s.spent = ms(3);
    s.picture(32, 32, 1, Quality::Off).unwrap();
    assert_eq!((s.sample_cost, s.spent), (Some(ms(20)), ms(3)));
}
