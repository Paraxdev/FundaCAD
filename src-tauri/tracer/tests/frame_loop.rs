//! The frame loop the app's transport drives, fed the way the page feeds it.

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
        let Ok(tracer) = Tracer::new(TracerOptions { software: true, ..Default::default() }) else {
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

    /// The page opens frames before its scene lands, and a body's mesh comes
    /// after the body list, so the loop traces with no instance at all first.
    #[test]
    fn frames_before_the_scene_and_before_its_meshes_trace_the_sky() {
        for software in [true, false] {
            let Ok(mut s) = Tracer::new(TracerOptions { software, ..Default::default() }) else {
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
}
