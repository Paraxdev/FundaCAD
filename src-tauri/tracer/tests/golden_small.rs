//! A sphere on a floor at 96x64, traced on every path the machine has. Both
//! paths walk the same seeds, so they agree to rounding, and each stays near
//! the committed picture. Without an adapter (GitHub's Windows runners) the
//! test says so and passes.

mod common;

use fundacad_tracer::{BodyDesc, PageMaterial, Path, Tracer, TracerOptions};

const W: u32 = 96;
const H: u32 = 64;
const SPP: u32 = 64;
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/small.png");

fn body(id: &str, z: f32, color: [f32; 3]) -> BodyDesc {
    common::place(id, &format!("{id}.1"), 1.0, [0.0, 0.0, z], common::matte(color))
}

fn scene(t: &mut Tracer) {
    t.set_cap(SPP);
    common::build(t, "golden", Some((W, H)));
}

fn trace(software: bool) -> Option<(Path, Vec<u8>, Tracer)> {
    let mut t = match Tracer::new(TracerOptions { software, ..Default::default() }) {
        Ok(t) => t,
        Err(e) => {
            println!("skipped, no GPU adapter: {e}");
            return None;
        }
    };
    println!("{:?} on {}", t.path(), t.adapter());
    scene(&mut t);
    t.render_samples(SPP);
    assert_eq!(t.samples(), SPP);
    Some((t.path(), t.resolve(), t))
}

fn rgb_diff(a: &[u8], b: &[u8]) -> (f64, f64) {
    let (mut sq, mut abs, mut n) = (0.0, 0.0, 0.0);
    for (x, y) in a.chunks(4).zip(b.chunks(4)) {
        for k in 0..3 {
            let d = x[k] as f64 - y[k] as f64;
            sq += d * d;
            abs += d.abs();
            n += 1.0;
        }
    }
    ((sq / n).sqrt(), abs / n)
}

fn read_png(path: &str) -> Vec<u8> {
    let dec = png::Decoder::new(std::fs::File::open(path).expect("golden missing, run with TRACER_GOLDEN_WRITE=1"));
    let mut r = dec.read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    assert_eq!((info.width, info.height), (W, H));
    buf.truncate(info.buffer_size());
    buf
}

fn write_png(path: &str, rgba: &[u8]) {
    let mut enc = png::Encoder::new(std::fs::File::create(path).unwrap(), W, H);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(rgba).unwrap();
}

#[test]
fn both_paths_agree_and_match_the_golden() {
    let Some((sw_path, sw, _)) = trace(true) else { return };
    assert_eq!(sw_path, Path::Software);
    if std::env::var_os("TRACER_GOLDEN_WRITE").is_some() {
        write_png(GOLDEN, &sw);
    }
    let (_, mad) = rgb_diff(&sw, &read_png(GOLDEN));
    println!("software vs golden: mean abs {mad:.3} of 255");
    assert!(mad <= 2.0, "software path drifted from the golden: mean abs {mad:.3}");

    let (hw_path, hw, _) = trace(false).unwrap();
    if hw_path != Path::RayQuery {
        println!("no ray queries on this adapter, the hardware path is not compared");
        return;
    }
    let (rmse, mad) = rgb_diff(&hw, &sw);
    println!("ray query vs software: rmse {rmse:.3}, mean abs {mad:.3} of 255");
    assert!(rmse < 1.0, "ray query and software disagree: rmse {rmse:.3} of 255");
}

#[test]
fn aovs_and_a_move_without_a_blas_rebuild() {
    let Some((_, before, mut t)) = trace(false) else { return };
    let aov = t.read_aovs();
    let px = |x: u32, y: u32| (y * W + x) as usize * 2;
    let ball = px(W / 2, H / 2 - 4);
    assert!((aov[ball][0] - 0.8).abs() < 1e-3 && (aov[ball][1] - 0.3).abs() < 1e-3, "albedo {:?}", aov[ball]);
    assert!(aov[ball][3] > 1.0 && aov[ball][3] < 20.0, "depth {}", aov[ball][3]);
    let n = aov[ball + 1];
    assert!((n[0] * n[0] + n[1] * n[1] + n[2] * n[2] - 1.0).abs() < 1e-3 && n[3] == 1.0);
    assert!(aov[px(0, 0)][3] >= 1e29, "the top corner is sky");

    let g = t.generation();
    let missing = t.set_bodies(vec![body("ball", 2.5, [0.8, 0.3, 0.2]), body("floor", 0.0, [0.7, 0.7, 0.7])]);
    assert!(missing.is_empty());
    let c = t.apply();
    assert_eq!((c.blas_built, c.tlas_built, c.geometry), (0, true, false));
    assert!(t.generation() > g && t.samples() == 0);
    t.render_samples(SPP);
    let (_, mad) = rgb_diff(&before, &t.resolve());
    assert!(mad > 2.0, "the moved ball changed the picture, mean abs {mad:.3}");
}

fn finishes(t: &mut Tracer) -> fundacad_tracer::Commit {
    let mut ball = body("ball", 1.0, [0.9, 0.95, 1.0]);
    ball.materials[0] = PageMaterial {
        transmission: Some(1.0),
        roughness: Some(0.05),
        ior: Some(1.5),
        dispersion: Some(1.0),
        attenuation_color: Some([0.4, 0.7, 1.0]),
        attenuation_distance: Some(1.5),
        ..Default::default()
    };
    let mut ground = body("floor", 0.0, [0.9, 0.8, 0.5]);
    ground.materials[0] = PageMaterial {
        color: Some([0.9, 0.8, 0.5]),
        metalness: Some(1.0),
        roughness: Some(0.3),
        clearcoat: Some(1.0),
        emissive: Some([0.1, 0.0, 0.0]),
        emissive_intensity: Some(2.0),
        ..Default::default()
    };
    assert!(t.set_bodies(vec![ball, ground]).is_empty());
    t.apply()
}

#[test]
fn glass_metal_coat_and_emission_trace_alike_on_both_paths() {
    let Some((_, matte, mut sw)) = trace(true) else { return };
    let c = finishes(&mut sw);
    assert_eq!((c.blas_built, c.tlas_built, c.instances, sw.samples()), (0, false, true, 0), "materials only");
    sw.render_samples(SPP);
    let a = sw.resolve();
    let (_, mad) = rgb_diff(&a, &matte);
    assert!(mad > 5.0, "the finishes changed the picture, mean abs {mad:.3}");
    let (hw_path, _, mut hw) = trace(false).unwrap();
    if hw_path != Path::RayQuery {
        return;
    }
    finishes(&mut hw);
    hw.render_samples(SPP);
    let (rmse, mad) = rgb_diff(&hw.resolve(), &a);
    println!("finishes, ray query vs software: rmse {rmse:.3}, mean abs {mad:.3} of 255");
    assert!(rmse < 4.0 && mad < 1.0, "rmse {rmse:.3}, mean abs {mad:.3}");
    if let Ok(p) = std::env::var("TRACER_DUMP") {
        write_png(&p, &a);
    }
}
