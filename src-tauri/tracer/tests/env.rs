//! The environment map as a light: which side of a ball it lights, the light
//! sample against bounce rays alone, a small bright disc, and the viewport's
//! hemisphere folded into a map.

mod common;

use common::{ball_alone, build, env_of, floor, matte, place, rmse_to_ref, sphere, BALL_EYE, BALL_TARGET};
use fundacad_tracer::{Camera, Estimator, Look, PageMaterial, Tracer, TracerOptions, Up};

const W: u32 = 128;
const H: u32 = 96;
const PI: f32 = std::f32::consts::PI;

fn tracer() -> Option<Tracer> {
    match common::tracer(TracerOptions::default()) {
        Ok(t) => Some(t),
        Err(e) => {
            println!("skipped, no GPU adapter: {e}");
            None
        }
    }
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt();
    a.map(|x| x / l)
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn lum(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// The normal of the unit ball at (0, 0, 1) under pixel (x, y), if it is on it.
fn normal_at(x: f32, y: f32) -> Option<[f32; 3]> {
    let fwd = norm([0, 1, 2].map(|k| BALL_TARGET[k] - BALL_EYE[k]));
    let right = norm(cross(fwd, [0.0, 0.0, 1.0]));
    let up = cross(right, fwd);
    let th = 20f32.to_radians().tan();
    let px = x / W as f32 * 2.0 - 1.0;
    let py = 1.0 - y / H as f32 * 2.0;
    let d = norm([0, 1, 2].map(|k| fwd[k] + px * right[k] * th * W as f32 / H as f32 + py * up[k] * th));
    let oc = [BALL_EYE[0], BALL_EYE[1], BALL_EYE[2] - 1.0];
    let b = dot(oc, d);
    let disc = b * b - (dot(oc, oc) - 1.0);
    if disc < 0.0 {
        return None;
    }
    let t = -b - disc.sqrt();
    let p = [0, 1, 2].map(|k| BALL_EYE[k] + d[k] * t);
    Some(norm([p[0], p[1], p[2] - 1.0]))
}

/// Mean luminance of the ball's pixels whose normal is within 12 degrees of n.
fn facing(hdr: &[[f32; 3]], n: [f32; 3]) -> f32 {
    let n = norm(n);
    let (mut s, mut k) = (0.0, 0);
    for y in 0..H {
        for x in 0..W {
            if normal_at(x as f32 + 0.5, y as f32 + 0.5).is_some_and(|m| dot(m, n) > 12f32.to_radians().cos()) {
                s += lum(hdr[(y * W + x) as usize]);
                k += 1;
            }
        }
    }
    assert!(k > 4, "no pixels face {n:?}");
    s / k as f32
}

fn dark() -> Look {
    Look { sky_top: [0.0; 3], sky_bottom: [0.0; 3], bounces: 8, ..Look::default() }
}

/// Lit from +X by half the sphere: a Lambert face of normal n gets the view
/// factor (1 + n.x) / 2 of it. Both layouts, so a swapped axis lights the
/// wrong face.
#[test]
fn a_room_lights_from_its_bright_side() {
    let Some(mut t) = tracer() else { return };
    let white = matte([1.0; 3]);
    let (bright, dim) = ([0.9, -0.8, 0.3], [-0.3, -1.0, 0.4]);
    for up in [Up::Y, Up::Z] {
        ball_alone(&mut t, dark(), white.clone(), (W, H));
        t.set_environment(Some(env_of("half", (256, 128), up, |d| [if d[0] > 0.0 { 1.0 } else { 0.0 }; 3])));
        t.set_cap(512);
        t.render_samples(512);
        let hdr = t.read_hdr();
        let (a, b) = (facing(&hdr, bright), facing(&hdr, dim));
        let want = |n: [f32; 3]| (1.0 + norm(n)[0]) / 2.0;
        println!("{up:?}: facing +X {a:.3} (view factor {:.3}), facing -X {b:.3} ({:.3})", want(bright), want(dim));
        assert!((a / want(bright) - 1.0).abs() < 0.08, "{up:?}: the bright side reads {a}");
        assert!((b / want(dim) - 1.0).abs() < 0.15, "{up:?}: the dim side reads {b}");
    }
}

/// Light samples only, bounce rays only and both weighted agree under a map
/// with a patch a bounce ray finds often enough, over a disc light as well.
#[test]
fn nee_only_and_bsdf_only_agree_under_an_environment() {
    let Some(mut t) = tracer() else { return };
    let patch = norm([0.6, -0.5, 0.6]);
    let map = env_of("patch", (256, 128), Up::Z, |d| {
        if dot(d, patch) > 10f32.to_radians().cos() {
            [12.0, 11.0, 9.0]
        } else if d[2] > 0.0 {
            [0.3, 0.35, 0.45]
        } else {
            [0.08; 3]
        }
    });
    let m = PageMaterial { color: Some([0.95, 0.75, 0.4]), metalness: Some(1.0), roughness: Some(0.3), ..Default::default() };
    let disc = fundacad_tracer::LightDesc { direction: [-0.5, -0.4, 1.0], color: [0.8; 3], angular_radius: 10.0 };
    let look = Look { lights: Some(fundacad_tracer::Lights::new(&[disc])), ..dark() };
    t.resize(64, 48);
    t.set_camera(Camera { eye: BALL_EYE, target: BALL_TARGET, up: [0.0, 0.0, 1.0], fov: 40.0, ..Default::default() });
    t.set_look(look);
    t.set_environment(Some(map));
    let bodies = vec![place("ball", "ball.1", 1.0, [0.0, 0.0, 1.0], m), place("floor", "floor.1", 1.0, [0.0; 3], matte([0.7; 3]))];
    for key in t.set_bodies(bodies) {
        t.add_mesh(&key, if key.starts_with("floor") { floor(20.0) } else { sphere(1.0, 48, 24) });
    }
    t.apply();
    let mut runs = vec![];
    for e in [Estimator::Mis, Estimator::Nee, Estimator::Bsdf] {
        t.set_estimator(e);
        t.set_cap(4096);
        t.render_samples(4096);
        let hdr = t.read_hdr();
        let mean = hdr.iter().map(|c| lum(*c) as f64).sum::<f64>() / hdr.len() as f64;
        runs.push((e, mean, blocks(&hdr, 64, 8)));
    }
    for (e, m, b) in &runs[1..] {
        let rel = b.iter().zip(&runs[0].2).map(|(x, y)| (x - y).abs() / y.max(1e-3)).sum::<f64>() / b.len() as f64;
        println!("{e:?} against Mis: mean luminance {m:.4} and {:.4}, 8x8 blocks differ by {:.2} percent on average", runs[0].1, rel * 100.0);
        assert!((m / runs[0].1 - 1.0).abs() < 0.01 && rel < 0.03, "{e:?} differs from Mis: {m} against {}, blocks {rel}", runs[0].1);
    }
}

fn blocks(hdr: &[[f32; 3]], w: usize, n: usize) -> Vec<f64> {
    let h = hdr.len() / w;
    let mut out = vec![];
    for by in 0..h / n {
        for bx in 0..w / n {
            let s: f64 = (0..n * n).map(|i| lum(hdr[(by * n + i / n) * w + bx * n + i % n]) as f64).sum();
            out.push(s / (n * n) as f64);
        }
    }
    out
}

/// A 1.5 degree sun in a map: the light sample finds it in 64 samples, bounce
/// rays alone do not.
#[test]
fn a_small_bright_disc_converges_with_the_light_sample() {
    let Some(mut t) = tracer() else { return };
    let mut rmse = vec![];
    for e in [Estimator::Default, Estimator::Bsdf] {
        t.set_estimator(e);
        build(&mut t, "hdr-sun", None);
        t.set_cap(64);
        t.render_samples(64);
        rmse.push(rmse_to_ref(&t.resolve(), "hdr-sun"));
    }
    println!("hdr-sun at 64 spp: rmse {:.2} of 255 with the light sample, {:.2} with bounce rays alone", rmse[0], rmse[1]);
    assert!(rmse[0] < 5.0, "the light sample leaves {:.2}", rmse[0]);
    assert!(rmse[1] > 4.0 * rmse[0], "bounce rays alone reach {:.2}", rmse[1]);
}

/// The viewport's hemisphere light folded into a map as FRAGMENT folds it,
/// radiance mix(ground, sky, d.up / 2 + 1/2) I / pi. A white Lambert face
/// of normal n integrates that to (g + (s - g)(1/2 + n.up / 3)) I / pi;
/// three's HemisphereLight shades mix(g, s, n.up / 2 + 1/2) I / pi, the
/// same at the horizon and (s - g) / 6 I / pi apart at the poles.
#[test]
fn a_furnace_under_the_hemisphere_alone() {
    let Some(mut t) = tracer() else { return };
    // The default rig, lightRig.ts: sky and ground in linear, intensity 0.6.
    let (s, g, i) = (0.654f32, 0.0172f32, 0.6f32);
    let map = env_of("hemi", (512, 256), Up::Y, |d| [(g + (s - g) * (d[2] * 0.5 + 0.5)) * i / PI; 3]);
    ball_alone(&mut t, dark(), matte([1.0; 3]), (W, H));
    t.set_environment(Some(map));
    t.set_cap(1024);
    t.render_samples(1024);
    let hdr = t.read_hdr();
    for n in [[0.3, -0.5, 0.8], [0.5, -0.8, 0.3], [0.3, -0.9, -0.3]] {
        let up = norm(n)[2];
        let want = (g + (s - g) * (0.5 + up / 3.0)) * i / PI;
        let three = (g + (s - g) * (0.5 + up / 2.0)) * i / PI;
        let got = facing(&hdr, n);
        println!("n.up {up:.2}: {got:.4}, integral {want:.4}, three's hemisphere light {three:.4}");
        assert!((got / want - 1.0).abs() < 0.05, "n.up {up}: {got} against {want}");
    }
}
