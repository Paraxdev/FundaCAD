//! The committed 16 bit references. `TRACER_REF_WRITE=1` rewrites them at 16k
//! spp (TRACER_REF_ONLY=name for one); otherwise a short render of every scene
//! has to sit near its reference on each path the machine has.

mod common;

use common::{build, display16, dims, read_ref, ref_write_wanted_for, rmse_to_ref, write_ref, REF_SCENES, REF_SPP};
use fundacad_tracer::{Tracer, TracerOptions};

const SPP: u32 = 64;

fn tracer(software: bool) -> Option<Tracer> {
    match common::tracer(TracerOptions { software, ..Default::default() }) {
        Ok(t) => Some(t),
        Err(e) => {
            println!("skipped, no GPU adapter: {e}");
            None
        }
    }
}

#[test]
fn write_references() {
    let Some(only) = ref_write_wanted_for() else { return };
    let Some(mut t) = tracer(false) else { return };
    println!("{:?} on {}", t.path(), t.adapter());
    for name in REF_SCENES.iter().filter(|n| only.as_deref().is_none_or(|o| o == **n)) {
        build(&mut t, name, None);
        t.set_cap(REF_SPP);
        t.render_samples(REF_SPP);
        let (w, h) = dims(name);
        write_ref(name, &t.read_hdr(), w, h);
        println!("wrote {name}");
    }
}

#[test]
fn the_cpu_tone_map_is_the_shaders() {
    let Some(mut t) = tracer(true) else { return };
    build(&mut t, "golden", None);
    t.set_cap(SPP);
    t.render_samples(SPP);
    let shader = t.resolve();
    let cpu: Vec<u16> = t.read_hdr().into_iter().flat_map(display16).collect();
    let worst = shader
        .chunks_exact(4)
        .zip(cpu.chunks_exact(3))
        .flat_map(|(a, b)| (0..3).map(move |k| (a[k] as f32 - b[k] as f32 / 257.0).abs()))
        .fold(0.0f32, f32::max);
    assert!(worst <= 1.0, "tone map differs from resolve.wgsl by {worst} of 255");
}

#[test]
fn a_short_render_sits_near_each_reference_on_every_path() {
    for software in [true, false] {
        let Some(mut t) = tracer(software) else { return };
        if !software && t.path() == fundacad_tracer::Path::Software {
            continue;
        }
        for name in REF_SCENES {
            let (_, w, h) = read_ref(name);
            assert_eq!((w, h), dims(name), "{name}: reference size");
            build(&mut t, name, None);
            t.set_cap(SPP);
            t.render_samples(SPP);
            let rmse = rmse_to_ref(&t.resolve(), name);
            println!("{name} on {:?}: rmse {rmse:.3} of 255 at {SPP} spp", t.path());
            assert!(rmse < limit(name), "{name} on {:?}: rmse {rmse:.3}", t.path());
        }
    }
}

/// 45.04 at 32 spp when only bounce rays found the lamp.
#[test]
fn glowing_faces_converge_four_times_faster() {
    for software in [true, false] {
        let Some(mut t) = tracer(software) else { return };
        if !software && t.path() == fundacad_tracer::Path::Software {
            continue;
        }
        build(&mut t, "emitter", None);
        t.set_cap(32);
        t.render_samples(32);
        let rmse = rmse_to_ref(&t.resolve(), "emitter");
        println!("emitter on {:?}: rmse {rmse:.3} of 255 at 32 spp", t.path());
        assert!(rmse <= 45.042 / 4.0, "emitter on {:?}: rmse {rmse:.3}", t.path());
    }
}

/// Measured at 64 spp: 1.5 to 4.0 on the lit scenes, 5.5 on the studio room
/// (halving with every 4x the samples, so noise), 5.9 on the emitter.
fn limit(name: &str) -> f64 {
    match name {
        "emitter" | "studio" => 8.0,
        _ => 5.0,
    }
}
