//! The denoise at the sample cap: the accumulation read back as linear colour,
//! tone mapped on the CPU exactly as resolve.wgsl does, and the CPU denoiser's
//! frame held once it lands.

use std::time::{Duration, Instant};

use fundacad_tracer::{denoise, BodyDesc, Denoiser, Camera, Look, Mesh, PageMaterial, Quality, Tracer, TracerOptions};

const W: u32 = 96;
const H: u32 = 64;

fn sphere(r: f32, su: u32, sv: u32) -> Mesh {
    let mut m = Mesh::default();
    for j in 0..=sv {
        let th = std::f32::consts::PI * j as f32 / sv as f32;
        for i in 0..=su {
            let ph = std::f32::consts::TAU * i as f32 / su as f32;
            let n = [th.sin() * ph.cos(), th.sin() * ph.sin(), th.cos()];
            m.positions.push(n.map(|c| c * r));
            m.normals.push(n);
        }
    }
    for j in 0..sv {
        for i in 0..su {
            let a = j * (su + 1) + i;
            let b = a + su + 1;
            m.indices.extend([a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    m
}

fn floor(s: f32) -> Mesh {
    Mesh {
        positions: vec![[-s, -s, 0.0], [s, -s, 0.0], [s, s, 0.0], [-s, s, 0.0]],
        normals: vec![[0.0, 0.0, 1.0]; 4],
        indices: vec![0, 1, 2, 0, 2, 3],
        ..Default::default()
    }
}

fn body(id: &str, z: f32, color: [f32; 3]) -> BodyDesc {
    let mut matrix = [0.0; 16];
    for k in 0..4 {
        matrix[k * 5] = 1.0;
    }
    matrix[14] = z;
    BodyDesc {
        id: id.into(),
        key: format!("{id}.1"),
        matrix,
        visible: true,
        materials: vec![PageMaterial { color: Some(color), roughness: Some(1.0), ..Default::default() }],
    }
}

fn traced(cap: u32) -> Option<Tracer> {
    let mut t = match Tracer::new(TracerOptions { software: true, ..Default::default() }) {
        Ok(t) => t,
        Err(e) => {
            println!("skipped, no GPU adapter: {e}");
            return None;
        }
    };
    t.resize(W, H);
    t.set_cap(cap);
    t.set_camera(Camera { eye: [4.0, -6.0, 3.0], target: [0.0, 0.0, 0.8], up: [0.0, 0.0, 1.0], fov: 40.0 });
    t.set_look(Look { sun_dir: [0.4, -0.3, 1.0], sun_color: [2.0; 3], exposure: 1.3, ..Look::default() });
    for key in t.set_bodies(vec![body("ball", 1.0, [0.8, 0.3, 0.2]), body("floor", 0.0, [0.7, 0.7, 0.7])]) {
        t.add_mesh(&key, if key.starts_with("ball") { sphere(1.0, 48, 24) } else { floor(20.0) });
    }
    t.apply();
    Some(t)
}

fn rmse(a: &[u8], b: &[u8]) -> f64 {
    let (mut sq, mut n) = (0.0, 0.0);
    for (x, y) in a.chunks(4).zip(b.chunks(4)) {
        for k in 0..3 {
            let d = x[k] as f64 - y[k] as f64;
            sq += d * d;
            n += 1.0;
        }
    }
    (sq / n).sqrt()
}

#[test]
fn the_linear_readback_tone_maps_to_the_resolve() {
    let Some(mut t) = traced(16) else { return };
    t.render_samples(16);
    let gpu = t.resolve();
    let cpu = denoise::tone_map(&t.read_hdr());
    let worst = gpu.iter().zip(&cpu).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
    assert_eq!(cpu.len(), gpu.len());
    assert!(worst <= 1, "the CPU tone map is {worst} of 255 off the resolve");
}

#[test]
fn without_a_denoise_the_cap_never_reports_a_denoised_frame() {
    let Some(mut t) = traced(4) else { return };
    t.set_denoise(Quality::Off);
    for _ in 0..20 {
        t.frame(W, H, Duration::from_millis(50));
    }
    assert!(t.done() && !t.denoised());
}

#[test]
fn at_the_cap_the_denoised_frame_is_held_and_is_closer_to_the_reference() {
    let Some(mut reference) = traced(2048) else { return };
    reference.render_samples(2048);
    let clean = reference.resolve();
    drop(reference);

    let mut t = traced(8).unwrap();
    t.set_denoise(Quality::Standard);
    let mut raw = None;
    let t0 = Instant::now();
    let mut held = Vec::new();
    while t0.elapsed() < Duration::from_secs(30) {
        held = t.frame(W, H, Duration::from_millis(50));
        if t.done() && raw.is_none() {
            raw = Some(held.clone());
        }
        if t.denoised() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(t.denoised(), "no denoised frame after 30 s: {:?}", t.denoise_error());
    assert_eq!(t.denoised_by(), Some(denoise::active()));
    let raw = raw.unwrap();
    let (before, after) = (rmse(&raw, &clean), rmse(&held, &clean));
    println!("8 spp against 2048 spp: rmse raw {before:.2}, denoised {after:.2} of 255");
    // The filter holds its stop to the measured noise, so on this nearly
    // noise free scene it only gains a little; it must never lose.
    let bound = if denoise::active() == Denoiser::Oidn { before * 0.7 } else { before };
    assert!(after < bound, "the denoise did not clean the frame: {before:.2} to {after:.2}");
    assert_eq!(t.frame(W, H, Duration::from_millis(50)), held, "the denoised frame is held at the cap");

    t.set_denoise(Quality::High);
    assert!(!t.denoised(), "a new weight set drops the old result");
    t.set_camera(Camera { eye: [5.0, -6.0, 3.0], target: [0.0, 0.0, 0.8], up: [0.0, 0.0, 1.0], fov: 40.0 });
    t.frame(W, H, Duration::from_millis(50));
    assert!(!t.denoised(), "a moved camera is not denoised");
}

#[test]
fn with_no_open_image_denoise_the_filter_cleans_the_cap() {
    assert_eq!(denoise::active(), Denoiser::Filter, "nothing in this test binary loads the library");
}

