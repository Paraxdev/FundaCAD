use fundacad_tracer::atrous::filter;
use fundacad_tracer::denoise::Input;

fn flat(w: usize, h: usize, noise: bool) -> Input {
    let mut color = Vec::new();
    let mut seed = 12345u32;
    for _ in 0..w * h {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let v = if noise { 0.1 + 0.8 * (seed >> 8) as f32 / (1u32 << 24) as f32 } else { 0.5 };
        color.extend([v, v, v]);
    }
    Input {
        width: w,
        height: h,
        color,
        albedo: vec![0.5; w * h * 3],
        normal: [0.0, 0.0, 1.0].repeat(w * h),
        depth: vec![5.0; w * h],
        samples: 64,
    }
}

#[test]
fn a_flat_surface_keeps_its_colour() {
    let out = filter(&flat(16, 12, false), 64);
    assert!(out.iter().all(|v| (v - 0.5).abs() < 1e-4), "{:?}", &out[..6]);
}

#[test]
fn noise_on_one_surface_is_smoothed_toward_its_mean() {
    let input = flat(32, 32, true);
    let out = filter(&input, 64);
    let rms = |v: &[f32]| (v.iter().map(|x| (x - 0.5) * (x - 0.5)).sum::<f32>() / v.len() as f32).sqrt();
    assert!(rms(&out) < rms(&input.color) * 0.5, "rms {} from {}", rms(&out), rms(&input.color));
}

#[test]
fn the_background_stays_as_traced() {
    let mut input = flat(16, 16, true);
    input.depth = vec![0.0; 16 * 16];
    assert_eq!(filter(&input, 64), input.color);
}
