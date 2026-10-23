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
