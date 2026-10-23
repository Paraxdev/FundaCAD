//! Tracer::self_check on every path the machine has: it passes against the
//! committed reference, and flags a reference that is not the scene's.

mod common;

use fundacad_tracer::{Path, Reference, Tracer, TracerOptions};

fn tracer(software: bool) -> Option<Tracer> {
    match common::tracer(TracerOptions { software, ..Default::default() }) {
        Ok(t) => Some(t),
        Err(e) => {
            println!("skipped, no GPU adapter: {e}");
            None
        }
    }
}

fn each_path(f: impl Fn(&Tracer)) {
    for software in [true, false] {
        let Some(t) = tracer(software) else { return };
        if !software && t.path() == Path::Software {
            continue;
        }
        f(&t);
    }
}

#[test]
fn the_check_passes_on_every_path() {
    each_path(|t| {
        let c = t.self_check().unwrap();
        println!(
            "{:?}: diff {:.3}, noise {:.3}, threshold {:.3}, {:.0} ms",
            c.path, c.diff, c.noise, c.threshold, c.ms
        );
        assert_eq!(c.path, t.path());
        assert!(c.passed && c.diff <= c.threshold, "{:?} failed its own check: {c:?}", c.path);
    });
}

#[test]
fn the_check_flags_a_reference_that_is_not_the_scene() {
    each_path(|t| {
        let mut r = Reference::golden();
        for v in &mut r.rgb {
            *v *= 0.8;
        }
        let c = t.self_check_against(&r).unwrap();
        println!("{:?}: diff {:.3}, threshold {:.3}", c.path, c.diff, c.threshold);
        assert!(!c.passed && c.diff > c.threshold, "{:?} took a dimmed reference: {c:?}", c.path);
    });
}
