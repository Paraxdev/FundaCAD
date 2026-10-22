use std::time::{Duration, Instant};

use fundacad_tracer::{Tracer, TracerOptions};

mod adapter;
mod picture;

#[test]
fn the_tracer_never_asks_for_the_opengl_backend() {
    assert!(!TracerOptions::default().backends.contains(wgpu::Backends::GL));
}

fn impatient(w: u32, h: u32) -> Option<Tracer> {
    let Ok(mut t) = Tracer::new(TracerOptions { software: true, ..Default::default() }) else {
        eprintln!("skipped: no adapter");
        return None;
    };
    t.resize(w, h);
    t.set_cap(64);
    t.stall_gpu_for_test();
    Some(t)
}

#[test]
fn a_readback_the_gpu_never_finishes_returns_a_timeout_fault() {
    let Some(mut t) = impatient(512, 512) else { return };
    let start = Instant::now();
    let px = t.resolve();
    assert!(start.elapsed() < Duration::from_secs(1), "the readback waited {:?}", start.elapsed());
    assert!(px.iter().all(|&b| b == 0));
    let f = t.fault().expect("a readback past the limit is a fault");
    assert!(f.contains("did not finish a frame within 10 s"), "{f}");
    t.render_samples(64);
    assert_eq!(t.samples(), 0, "a faulted tracer traced on");
}

#[test]
fn a_trace_the_gpu_does_not_finish_in_time_stops_with_the_reason() {
    let Some(mut t) = impatient(512, 512) else { return };
    let start = Instant::now();
    t.render_samples(64);
    assert!(start.elapsed() < Duration::from_secs(1), "the trace waited {:?}", start.elapsed());
    assert!(t.samples() < 64, "the trace ran to the cap past its limit");
    let f = t.fault().expect("a band past the limit is a fault");
    assert!(f.contains("did not finish a frame"), "{f}");
    assert_eq!(t.frame(512, 512, Duration::from_millis(50)), vec![0; 512 * 512 * 4]);
}

#[test]
fn a_stalled_gpu_times_out_even_when_its_work_is_long_done() {
    let Ok(mut t) = Tracer::new(TracerOptions { software: true, ..Default::default() }) else {
        eprintln!("skipped: no adapter");
        return;
    };
    t.resize(96, 40);
    t.set_cap(64);
    t.render_samples(3);
    assert_eq!((t.samples(), t.fault()), (3, None));
    assert!(t.resolve().iter().any(|&b| b != 0), "an answering GPU read back black");
    t.stall_gpu_for_test();
    assert!(t.step());
    std::thread::sleep(Duration::from_millis(50));
    let e = t.wait().expect_err("a stalled GPU answered");
    assert!(e.contains("did not finish a frame within 10 s"), "{e}");
    assert!(t.resolve().iter().all(|&b| b == 0), "a stalled GPU read back a frame");
    assert_eq!(t.fault(), Some(e));
}
