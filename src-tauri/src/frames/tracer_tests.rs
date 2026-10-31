use super::*;

fn frame(t: &TracerSource) -> u32 {
    let mut out = vec![0; 32 * 24 * 4];
    t.render(&mut out, 32, 24, 0);
    with(|t| t.samples()).unwrap()
}

/// The tracer is one per process, so its tests take turns.
fn one_at_a_time() -> MutexGuard<'static, ()> {
    static TURN: Mutex<()> = Mutex::new(());
    TURN.lock().unwrap_or_else(|p| p.into_inner())
}

#[test]
fn a_tracer_start_the_driver_never_answers_is_refused_with_the_reason() {
    let start = std::time::Instant::now();
    let slow = within(Duration::from_millis(100), || std::thread::sleep(Duration::from_secs(5)));
    assert!(start.elapsed() < Duration::from_secs(2), "the start waited {:?}", start.elapsed());
    let Err(Refusal::Device(why)) = slow else { panic!("a stuck start was not refused") };
    assert!(why.contains("did not make a device within 0 s"), "{why}");
    assert!(matches!(within(Duration::from_secs(5), || 7), Ok(7)));
}

#[test]
fn a_frame_the_gpu_does_not_finish_in_time_greys_path_traced_with_the_reason() {
    let _turn = one_at_a_time();
    let Ok(t) = tracer() else {
        eprintln!("skipped: no native tracer");
        return;
    };
    t.lock().tracer.stall_gpu_for_test();
    let mut out = vec![1; 256 * 192 * 4];
    t.render(&mut out, 256, 192, 0);
    let fault = pt_status().unwrap().fault.expect("a frame past the wait limit left no fault");
    assert!(fault.contains("did not finish a frame within 10 s"), "{fault}");
    t.render(&mut out, 256, 192, 1);
    assert!(out.iter().all(|&b| b == 0), "a faulted tracer drew a frame");
    drop(t);
    release();
    let t = tracer().expect("the tracer did not come back after a release");
    assert_eq!(pt_status().unwrap().fault, None, "a reopened tracer kept the old fault");
    drop(t);
    release();
}

#[test]
fn a_cancelled_picture_leaves_the_viewport_tracing_and_the_next_one_saves() {
    let _turn = one_at_a_time();
    let Ok(t) = tracer() else {
        eprintln!("skipped: no native tracer");
        return;
    };
    with(|t| t.set_cap(4096)).unwrap();
    let before = frame(&t);
    let run = std::thread::spawn(|| picture(1024, 1024, 1_000_000));
    while pt_status().unwrap().picture.is_none() {
        assert!(!run.is_finished(), "{:?}", run.join().unwrap());
        std::thread::yield_now();
    }
    assert_eq!(frame(&t), before, "the viewport traced while the picture held the tracer");
    pt_picture_cancel().unwrap();
    assert_eq!(run.join().unwrap(), Err(PICTURE_CANCELLED.to_string()));
    assert!(pt_status().unwrap().picture.is_none());
    assert!(frame(&t) > before, "the viewport stopped tracing after a cancelled picture");

    let png = picture(64, 48, 4).expect("the picture after a cancel failed");
    assert_eq!(&png[1..4], b"PNG");
    assert!(frame(&t) > before);
    assert_eq!(pt_status().unwrap().fault, None);
    drop(t);
    release();
}

#[test]
fn a_camera_sent_during_a_frame_answers_at_once_and_the_next_frame_traces_with_it() {
    let _turn = one_at_a_time();
    let Ok(t) = tracer() else {
        eprintln!("skipped: no native tracer");
        return;
    };
    with(|t| t.set_cap(4096)).unwrap();
    t.opened();
    let camera = Camera {
        eye: [3.5, -12.0, 4.25],
        target: [0.5, 1.5, -0.75],
        up: [0.0, 0.0, 1.0],
        fov: 38.0,
        ortho: None,
        lens: None,
    };
    assert_eq!(pt_camera(Camera { eye: [-6.0, 9.5, 2.0], ..camera }), Ok(0));
    let mut out = vec![0; 32 * 24 * 4];
    for seq in 1..=2 {
        t.render(&mut out, 32, 24, seq);
    }
    assert!(pt_status().unwrap().samples > 0);
    let in_progress = t.state.lock().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || tx.send(pt_camera(camera)));
    let answer = rx.recv_timeout(Duration::from_secs(2));
    drop(in_progress);
    assert_eq!(answer, Ok(Ok(2)), "pt_camera waited for the frame in progress");
    assert_eq!(pt_status().unwrap().samples, 0, "a status after the camera counted the old camera's samples");
    t.render(&mut out, 32, 24, 3);
    let fresh = pt_status().unwrap().samples;
    assert!(fresh > 0, "the frame after the camera traced nothing");
    assert_eq!(pt_camera(camera), Ok(3));
    t.render(&mut out, 32, 24, 4);
    assert!(pt_status().unwrap().samples > fresh, "the same camera again restarted the trace");
    drop(t);
    release();
}

#[test]
fn a_newer_camera_drops_the_sample_behind_a_coarse_picture_at_the_next_frame() {
    let _turn = one_at_a_time();
    let Ok(t) = tracer() else {
        eprintln!("skipped: no native tracer");
        return;
    };
    with(|t| t.set_cap(4096)).unwrap();
    let camera = Camera {
        eye: [3.5, -12.0, 4.25],
        target: [0.5, 1.5, -0.75],
        up: [0.0, 0.0, 1.0],
        fov: 38.0,
        ortho: None,
        lens: None,
    };
    let mut out = vec![0; 256 * 192 * 4];
    t.render(&mut out, 256, 192, 1);
    pt_camera(camera).unwrap();
    with(|t| t.set_frame_budget(256 * 8)).unwrap();
    t.render(&mut out, 256, 192, 2);
    assert_eq!(out[3], 128, "a first sample over the budget sends a coarse picture first");
    assert!(out.chunks(4).all(|p| p[3] != 0), "a coarse picture left with a pixel no sample reached");
    {
        let mut s = t.lock();
        s.tracer.set_frame_budget(256 * 8);
        assert!(s.tracer.step());
        assert!(s.tracer.sample_under_way() && s.tracer.coarse_out());
    }
    pt_camera(Camera { eye: [-6.0, 9.5, 2.0], ..camera }).unwrap();
    assert!(t.lock().tracer.sample_under_way(), "only a frame may drop the sample, a status counts it");
    assert!(t.aim().camera.is_some());
    drop(t.lock_for(Some(3)));
    assert!(t.aim().camera.is_none(), "the next frame did not take the newer camera");
    drop(t);
    release();
}

#[test]
fn a_newer_camera_mid_sample_behind_a_coarse_picture_sends_nothing_and_the_next_seq_shows_it() {
    let _turn = one_at_a_time();
    let Ok(t) = tracer() else {
        eprintln!("skipped: no native tracer");
        return;
    };
    with(|t| t.set_cap(4096)).unwrap();
    let camera = Camera {
        eye: [3.5, -12.0, 4.25],
        target: [0.5, 1.5, -0.75],
        up: [0.0, 0.0, 1.0],
        fov: 38.0,
        ortho: None,
        lens: None,
    };
    let (w, h) = (256, 192);
    let mut out = vec![0; w as usize * h as usize * 4];
    t.render(&mut out, w, h, 1);
    pt_camera(camera).unwrap();
    with(|t| t.set_frame_budget(w * 8)).unwrap();
    assert!(t.render(&mut out, w, h, 2));
    assert_eq!(out[3], 128, "a first sample over the budget sends a coarse picture first");
    assert!(with(|t| {
        t.set_frame_budget(w * 8);
        t.step()
    })
    .unwrap());

    // No budget, so the frame traces nothing and the first sample cannot end before the camera lands.
    let sent = std::thread::scope(|scope| {
        let camera_mid_frame = scope.spawn(|| {
            while t.aim().drawn != 3 {
                std::thread::yield_now();
            }
            pt_camera(Camera { eye: [-6.0, 9.5, 2.0], ..camera }).unwrap()
        });
        let sent = t.render_for(&mut out, w, h, 3, Duration::ZERO);
        assert_eq!(camera_mid_frame.join().unwrap(), 3, "the camera answered another seq than the frame under way");
        sent
    });
    assert!(!sent, "a frame went out for a seq the page tied to the older camera");

    assert!(t.render(&mut out, w, h, 4));
    assert_eq!(out[3], 128, "the next seq did not restart on the newer camera");
    assert!(t.aim().camera.is_none());
    drop(t);
    release();
}

#[test]
fn a_fault_sends_an_all_zero_frame_that_the_page_drops() {
    let _turn = one_at_a_time();
    let Ok(t) = tracer() else {
        eprintln!("skipped: no native tracer");
        return;
    };
    t.lock().fault = Some("a test fault".into());
    let mut out = vec![9; 32 * 24 * 4];
    assert!(t.render(&mut out, 32, 24, 1));
    assert!(out.iter().all(|b| *b == 0), "a fault frame left a pixel the page could show");
    t.lock().fault = None;
    drop(t);
    release();
}

#[test]
fn a_camera_waits_for_the_first_sample_under_way_and_a_picture_does_not() {
    let _turn = one_at_a_time();
    let Ok(t) = tracer() else {
        eprintln!("skipped: no native tracer");
        return;
    };
    with(|t| t.set_cap(4096)).unwrap();
    let camera = Camera {
        eye: [3.5, -12.0, 4.25],
        target: [0.5, 1.5, -0.75],
        up: [0.0, 0.0, 1.0],
        fov: 38.0,
        ortho: None,
        lens: None,
    };
    let mut out = vec![0; 256 * 192 * 4];
    t.render(&mut out, 256, 192, 1);
    pt_camera(camera).unwrap();
    {
        let mut s = t.lock();
        s.tracer.set_frame_budget(256 * 8);
        assert!(s.tracer.step());
        assert!(s.tracer.sample_under_way());
    }
    pt_camera(Camera { eye: [-6.0, 9.5, 2.0], ..camera }).unwrap();
    assert!(t.lock().tracer.sample_under_way(), "a status restarted the first sample under way");
    t.render(&mut out, 256, 192, 2);
    assert!(out.chunks(4).all(|p| p[3] == 255), "a frame left with a pixel no sample reached");
    assert!(t.aim().camera.is_some(), "the frame that ended the first sample took the newer camera");
    assert_eq!(pt_status().unwrap().samples, 0, "the next status did not take the waiting camera");

    with(|t| {
        t.set_frame_budget(256 * 8);
        t.step()
    })
    .unwrap();
    pt_camera(camera).unwrap();
    let s = t.lock_for_picture();
    assert!(s.tracer.samples() == 0 && t.aim().camera.is_none(), "a picture left a camera waiting");
    drop(s);
    drop(t);
    release();
}
