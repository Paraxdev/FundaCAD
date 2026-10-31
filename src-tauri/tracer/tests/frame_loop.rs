//! The frame loop the app's transport drives, fed the way the page feeds it.

mod common;

mod t {
    use fundacad_tracer::*;
    use std::time::Duration;

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

    #[test]
    fn a_page_scene_traces_to_the_cap_through_partial_bands_then_holds() {
        let Ok(tracer) = super::common::tracer(TracerOptions { software: true, ..Default::default() }) else {
            eprintln!("skipped: no adapter");
            return;
        };
        let mut s = tracer;
        let bodies: Vec<BodyDesc> = serde_json::from_str(
            r#"[{"id":"body1","key":"body1:e1:7:0:0","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                 "materials":[{"color":[0.8,0.2,0.2],"roughness":0.4}]}]"#,
        )
        .unwrap();
        assert_eq!(s.set_bodies(bodies), vec!["body1:e1:7:0:0".to_string()]);
        let (key, mesh) = decode_mesh(&quad_frame("body1:e1:7:0:0")).unwrap();
        s.add_mesh(&key, mesh);
        let camera: Camera =
            serde_json::from_str(r#"{"eye":[0,-8,6],"target":[0,0,0],"up":[0,0,1],"fov":50}"#).unwrap();
        s.set_camera(camera);
        let look: Look = serde_json::from_str(r#"{"sunDir":[0.3,-0.4,1],"sunColor":[3,3,3]}"#).unwrap();
        s.set_look(look);
        s.set_cap(4);
        s.set_frame_budget(64 * 8);

        let mut frames = 0;
        let mut px = Vec::new();
        while !s.done() {
            px = s.frame(64, 48, Duration::from_millis(12));
            frames += 1;
            assert!(frames < 200, "stuck at {} samples", s.samples());
        }
        assert_eq!(s.samples(), 4);
        let centre = &px[(24 * 64 + 32) * 4..][..3];
        assert!(centre[0] > centre[2], "the red quad fills the centre, got {centre:?}");
        let held = s.frame(64, 48, Duration::from_millis(12));
        assert_eq!(held, px);
        s.set_cap(5);
        s.frame(64, 48, Duration::from_millis(12));
        assert!(s.samples() > 4);
    }

    fn red_quad_at_cap(cap: u32) -> Option<Tracer> {
        let Ok(mut s) = super::common::tracer(TracerOptions { software: true, ..Default::default() }) else {
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
        s.set_camera(serde_json::from_str(r#"{"eye":[0,-8,6],"target":[0,0,0],"up":[0,0,1],"fov":50}"#).unwrap());
        s.set_look(serde_json::from_str(r#"{"sunDir":[0.3,-0.4,1],"sunColor":[3,3,3]}"#).unwrap());
        s.set_cap(cap);
        let mut frames = 0;
        while !s.done() {
            s.frame(64, 48, Duration::from_millis(12));
            frames += 1;
            assert!(frames < 200, "stuck at {} samples", s.samples());
        }
        Some(s)
    }

    fn moved_camera() -> Camera {
        serde_json::from_value(
            serde_json::json!({ "eye": [0.3, 0, 6], "target": [0.3, 0, 0], "up": [0, 1, 0], "fov": 50 }),
        )
        .unwrap()
    }

    /// The budget stands in for a slow adapter: a band of 8 rows in 48 leaves a sample far over one dispatch.
    #[test]
    fn a_sample_over_the_budget_sends_a_coarse_whole_picture_first() {
        let Some(mut s) = red_quad_at_cap(1) else { return };
        let Some(mut plain) = red_quad_at_cap(1) else { return };
        s.set_camera(moved_camera());
        s.set_frame_budget(64 * 8);
        let coarse = s.advance(64, 48, Duration::ZERO).expect("a picture of the new camera leaves at once");
        assert_eq!(s.samples(), 0, "a coarse pass is not a sample");
        assert!(coarse.chunks(4).all(|p| p[3] != 0), "a coarse picture has no unsampled pixel");
        assert!(coarse[3] != 255, "the page tells a coarse picture by its first alpha");
        let rgb = |x: usize, y: usize| &coarse[(y * 64 + x) * 4..][..3];
        for (x, y) in [(0, 0), (30, 12), (60, 45)] {
            assert_eq!(rgb(x, y), rgb(x + 1, y + 1), "a coarse block is one colour at {x}, {y}");
        }

        let whole = s.frame(64, 48, Duration::from_millis(12));
        assert_eq!(s.samples(), 1);
        assert!(whole.chunks(4).all(|p| p[3] == 255), "the sample after it is a plain frame");
        plain.set_camera(moved_camera());
        plain.set_frame_budget(64 * 48);
        let direct = plain.frame(64, 48, Duration::from_millis(12));
        assert!(whole == direct, "the coarse pass left something in the first sample");
        assert!(whole != coarse, "the first sample replaces the coarse picture");
    }

    #[test]
    fn a_first_sample_that_fits_sends_no_coarse_picture() {
        let Some(mut s) = red_quad_at_cap(1) else { return };
        s.set_camera(moved_camera());
        s.set_frame_budget(64 * 48);
        assert_eq!(s.advance(64, 48, Duration::ZERO), None, "nothing traced with no budget");
        let px = s.frame(64, 48, Duration::from_millis(12));
        assert_eq!(px[3], 255);
    }

    /// The quad fills the view from above, so a row without light was never traced.
    #[test]
    fn a_frame_after_a_camera_move_has_no_unsampled_rows() {
        let Some(mut s) = red_quad_at_cap(2) else { return };
        for (i, budget) in [Duration::from_millis(1), Duration::ZERO].into_iter().enumerate() {
            let x = 0.1 * (i + 1) as f32;
            let camera: Camera = serde_json::from_value(
                serde_json::json!({ "eye": [x, 0, 6], "target": [x, 0, 0], "up": [0, 1, 0], "fov": 50 }),
            )
            .unwrap();
            s.set_camera(camera);
            s.set_frame_budget(64 * 8);
            let px = s.frame(64, 48, budget);
            let black: Vec<usize> =
                px.chunks(64 * 4).enumerate().filter(|(_, r)| r.chunks(4).all(|p| p[0] == 0)).map(|(y, _)| y).collect();
            assert!(
                black.is_empty(),
                "budget {budget:?}: {} of 48 rows are black, from row {:?}",
                black.len(),
                black.first()
            );
        }
    }

    #[test]
    fn no_frame_leaves_until_every_pixel_has_a_sample() {
        let Some(mut s) = red_quad_at_cap(2) else { return };
        s.frame(64, 48, Duration::from_millis(1));
        let camera: Camera = serde_json::from_value(
            serde_json::json!({ "eye": [0.3, 0, 6], "target": [0.3, 0, 0], "up": [0, 1, 0], "fov": 50 }),
        )
        .unwrap();
        s.set_camera(camera);
        assert!(!s.sample_under_way(), "a reset starts no sample");
        assert_eq!(s.advance(64, 48, Duration::ZERO), None, "nothing traced yet");
        s.set_frame_budget(64 * 8);
        assert!(s.step());
        assert!(s.sample_under_way());
        assert_eq!(s.advance(64, 48, Duration::ZERO), None, "only the top band has light");
        let partial = s.resolve();
        let alpha = |row: usize, px: &[u8]| px[row * 64 * 4 + 3];
        assert_eq!((alpha(0, &partial), alpha(47, &partial)), (255, 0), "an unsampled pixel is marked");
        let whole = loop {
            if let Some(px) = s.advance(64, 48, Duration::from_millis(1)) {
                break px;
            }
        };
        assert!(!s.sample_under_way());
        assert!(whole.chunks(4).all(|p| p[3] == 255), "a whole frame has no marked pixel");
    }

    fn frames_until_denoised(s: &mut Tracer) {
        let start = std::time::Instant::now();
        while !s.denoised() {
            assert!(start.elapsed() < Duration::from_secs(30), "no denoise: {:?}", s.denoise_error());
            s.frame(64, 48, Duration::from_millis(12));
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// The page steps the budget from frame times, at the cap too, where the held frames come back fast.
    #[test]
    fn a_budget_change_keeps_the_samples_and_the_denoise() {
        let Some(mut s) = red_quad_at_cap(4) else { return };
        s.set_frame_budget(64 * 16);
        assert_eq!(s.samples(), 4);
        assert!(s.done());
        frames_until_denoised(&mut s);
        let denoised = s.frame(64, 48, Duration::from_millis(12));
        s.set_frame_budget(64 * 8);
        assert_eq!(s.samples(), 4);
        assert!(s.denoised());
        assert_eq!(s.frame(64, 48, Duration::from_millis(12)), denoised);
    }

    #[test]
    fn a_denoise_level_change_while_the_cap_denoises_denoises_again() {
        let Some(mut s) = red_quad_at_cap(2) else { return };
        assert!(s.denoising());
        s.set_denoise(Quality::High);
        frames_until_denoised(&mut s);
        assert_eq!(s.samples(), 2);
    }

    /// The page opens frames before its scene lands, and a body's mesh comes
    /// after the body list, so the loop traces with no instance at all first.
    #[test]
    fn frames_before_the_scene_and_before_its_meshes_trace_the_sky() {
        for software in [true, false] {
            let Ok(mut s) = super::common::tracer(TracerOptions { software, ..Default::default() }) else {
                eprintln!("skipped: no adapter");
                return;
            };
            if !software && s.path() != Path::RayQuery {
                continue;
            }
            s.frame(32, 24, Duration::from_millis(12));
            let bodies: Vec<BodyDesc> = serde_json::from_str(
                r#"[{"id":"body1","key":"body1:e1:7:0:0","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]"#,
            )
            .unwrap();
            s.set_bodies(bodies);
            let px = s.frame(32, 24, Duration::from_millis(12));
            assert_eq!(px.len(), 32 * 24 * 4);
        }
    }
    fn emitter(sky: f32, env: f32) -> Option<Tracer> {
        let mut s = super::common::tracer(TracerOptions { software: true, ..Default::default() }).ok()?;
        let bodies: Vec<BodyDesc> = serde_json::from_str(
            r#"[{"id":"body1","key":"lamp","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                 "materials":[{"color":[0,0,0],"emissive":[1,1,1],"emissiveIntensity":4}]}]"#,
        )
        .unwrap();
        s.set_bodies(bodies);
        let (key, mesh) = decode_mesh(&quad_frame("lamp")).unwrap();
        s.add_mesh(&key, mesh);
        s.set_camera(serde_json::from_str(r#"{"eye":[0,0,200],"target":[0,0,0],"up":[0,1,0],"fov":50}"#).unwrap());
        let look = format!(r#"{{"skyTop":[{sky},{sky},{sky}],"skyBottom":[{sky},{sky},{sky}],"envIntensity":{env}}}"#);
        s.set_look(serde_json::from_str(&look).unwrap());
        s.set_denoise(Quality::Off);
        s.set_cap(2);
        Some(s)
    }

    const W: u32 = 320;
    const H: u32 = 240;

    fn at(px: &[u8], x: u32, y: u32) -> u8 {
        px[((y * W + x) * 4) as usize]
    }

    fn to_cap(s: &mut Tracer) -> Vec<u8> {
        let mut px = Vec::new();
        for _ in 0..64 {
            px = s.frame(W, H, Duration::from_millis(50));
            if s.done() {
                break;
            }
        }
        assert!(s.done());
        px
    }

    #[test]
    fn bloom_at_the_cap_glows_around_an_emitter_and_keeps_the_samples_and_the_sky() {
        let Some(mut s) = emitter(0.2, 1.0) else {
            eprintln!("skipped: no adapter");
            return;
        };
        let a = to_cap(&mut s);
        let samples = s.samples();
        s.set_bloom(Some(Bloom { strength: 0.7, radius: 0.6, threshold: 0.8, side: 0 }));
        let b = s.frame(W, H, Duration::from_millis(50));
        assert_eq!(s.samples(), samples, "a bloom change restarted the samples");
        let (near, corner) = ((W / 2 + 10, H / 2), (2, 2));
        eprintln!(
            "near {} -> {}, corner {} -> {}",
            at(&a, near.0, near.1),
            at(&b, near.0, near.1),
            at(&a, corner.0, corner.1),
            at(&b, corner.0, corner.1)
        );
        assert!(at(&b, near.0, near.1) > at(&a, near.0, near.1) + 8, "no glow next to the emitter");
        assert!(at(&b, corner.0, corner.1).abs_diff(at(&a, corner.0, corner.1)) <= 1, "the sky bloomed");
        assert_eq!(s.frame(W, H, Duration::from_millis(50)), b, "the held bloomed frame changed");
        s.set_bloom(None);
        assert_eq!(s.frame(W, H, Duration::from_millis(50)), a, "bloom off is not the plain frame");
    }

    #[test]
    fn a_sky_brighter_than_the_threshold_never_blooms() {
        // The native sky is the background times the brightness, the page only
        // raised the threshold above the background itself.
        let Some(mut s) = emitter(0.9, 1.2) else {
            eprintln!("skipped: no adapter");
            return;
        };
        let a = to_cap(&mut s);
        s.set_bloom(Some(Bloom { strength: 0.7, radius: 0.6, threshold: 0.95, side: 0 }));
        let b = s.frame(W, H, Duration::from_millis(50));
        eprintln!("corner {} -> {}", at(&a, 2, 2), at(&b, 2, 2));
        assert!(at(&b, 2, 2).abs_diff(at(&a, 2, 2)) <= 1, "the sky bloomed");
    }

    #[test]
    fn a_lost_device_leaves_a_fault_and_no_panic() {
        for software in [true, false] {
            let Ok(mut t) = super::common::tracer(TracerOptions { software, ..Default::default() }) else {
                eprintln!("skipped: no adapter");
                return;
            };
            t.frame(32, 24, Duration::from_millis(12));
            assert_eq!(t.fault(), None);
            t.lose_device_for_test();
            let px =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.frame(32, 24, Duration::from_millis(12))));
            let px = px.expect("a lost device panicked");
            assert_eq!(px.len(), 32 * 24 * 4);
            let fault = t.fault().expect("no fault after the loss");
            assert!(fault.contains("lost"), "{fault}");
            let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                t.set_frame_budget(65_536);
                t.set_cap(8);
                t.frame(48, 24, Duration::from_millis(12))
            }));
            assert!(again.is_ok(), "a call after the loss panicked");
        }
    }

    #[test]
    fn a_ray_query_frame_traces_in_bands_under_the_budget() {
        let Ok(mut t) = super::common::tracer(TracerOptions::default()) else {
            eprintln!("skipped: no adapter");
            return;
        };
        if t.path() != Path::RayQuery {
            eprintln!("skipped: no ray queries on {}", t.adapter());
            return;
        }
        t.resize(1024, 512);
        t.set_frame_budget(65_536);
        assert_eq!(t.band(), 64);
        assert!(t.step());
        assert_eq!(t.samples(), 0, "one dispatch traced the whole sample");
    }
}
