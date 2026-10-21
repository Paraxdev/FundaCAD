//! The light sample against the BSDF it should carry: a lone ball under one
//! light, where every pixel's direct term is known in closed form, and a white
//! furnace, where every pixel should read 1.

mod common;

use common::{ball_alone, floor, furnace, matte, place, sphere, BALL_EYE, BALL_TARGET};
use fundacad_tracer::{Estimator, LightDesc, Lights, Look, PageMaterial, Tracer, TracerOptions};

const W: u32 = 128;
const H: u32 = 96;
const SUN: [f32; 3] = [0.4, -0.3, 1.0];

fn tracer() -> Option<Tracer> {
    match common::tracer(TracerOptions::default()) {
        Ok(t) => Some(t),
        Err(e) => {
            println!("skipped, no GPU adapter: {e}");
            None
        }
    }
}

fn norm(a: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt();
    a.map(|x| x / l)
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn lum(c: [f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// Where the camera ray through (`x`, `y`) in pixels meets the unit ball at
/// (0, 0, 1): its normal and the direction back to the eye.
fn hit(x: f32, y: f32) -> Option<([f32; 3], [f32; 3])> {
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
    Some((norm([p[0], p[1], p[2] - 1.0]), d.map(|x| -x)))
}

/// GGX specular with Smith masking and Schlick Fresnel (F90 1), and
/// diffuse, each times n.l: the base layer's response to a unit delta light
/// along `l`.
fn bsdf_cos(m: &PageMaterial, n: [f32; 3], v: [f32; 3], l: [f32; 3]) -> [f32; 2] {
    let (nv, nl) = (dot(n, v), dot(n, l));
    if nv <= 0.0 || nl <= 0.0 {
        return [0.0; 2];
    }
    let h = norm([0, 1, 2].map(|k| v[k] + l[k]));
    let (nh, vh) = (dot(n, h), dot(v, h));
    let a = m.roughness.unwrap().powi(2).max(1e-4);
    let a2 = a * a;
    let d = a2 / (std::f32::consts::PI * (nh * nh * (a2 - 1.0) + 1.0).powi(2));
    let g1 = |c: f32| 2.0 * c / (c + (a2 + (1.0 - a2) * c * c).sqrt());
    let metal = m.metalness.unwrap_or(0.0);
    let base = lum(m.color.unwrap());
    let f0 = 0.04 * (1.0 - metal) + base * metal;
    let f = |c: f32| f0 + (1.0 - f0) * (1.0 - c).powi(5);
    let spec = f(vh) * d * g1(nv) * g1(nl) / (4.0 * nv * nl);
    let diffuse = base * (1.0 - metal) * (1.0 - f(nv)) / std::f32::consts::PI;
    [spec * nl, diffuse * nl]
}

/// The analytic sun term of each pixel wholly on the ball, specular and
/// diffuse, averaged over the pixel like the tracer's jitter.
fn expected(m: &PageMaterial, irradiance: f32) -> Vec<Option<[f32; 2]>> {
    const S: u32 = 6;
    let l = norm(SUN);
    (0..W * H)
        .map(|i| {
            let (x, y) = ((i % W) as f32, (i / W) as f32);
            let mut sum = [0.0; 2];
            for k in 0..S * S {
                let (sx, sy) = ((k % S) as f32 + 0.5, (k / S) as f32 + 0.5);
                let (n, v) = hit(x + sx / S as f32, y + sy / S as f32)?;
                let f = bsdf_cos(m, n, v, l);
                sum = [0, 1].map(|j| sum[j] + f[j] * irradiance / (S * S) as f32);
            }
            Some(sum)
        })
        .collect()
}

fn render(t: &mut Tracer, look: Look, m: &PageMaterial, spp: u32) -> Vec<[f32; 3]> {
    ball_alone(t, look, m.clone(), (W, H));
    t.set_cap(spp);
    t.render_samples(spp);
    t.read_hdr()
}

fn sun(color: f32) -> Look {
    Look { sky_top: [0.02; 3], sky_bottom: [0.02; 3], sun_dir: SUN, sun_color: [color; 3], ..Look::default() }
}

fn metal() -> PageMaterial {
    PageMaterial { color: Some([0.95, 0.75, 0.4]), metalness: Some(1.0), roughness: Some(0.25), ..Default::default() }
}

fn gloss() -> PageMaterial {
    PageMaterial { color: Some([0.8; 3]), metalness: Some(0.0), roughness: Some(0.2), ..Default::default() }
}

#[test]
fn a_metal_ball_has_its_brightest_pixel_at_the_mirror_direction() {
    let Some(mut t) = tracer() else { return };
    let m = metal();
    let on = render(&mut t, sun(2.0), &m, 64);
    let off = render(&mut t, sun(0.0), &m, 64);
    let l = norm(SUN);
    let mirror = |i: u32| {
        let (n, v) = hit((i % W) as f32 + 0.5, (i / W) as f32 + 0.5)?;
        let r = [0, 1, 2].map(|k| 2.0 * dot(n, v) * n[k] - v[k]);
        (dot(n, v) > 0.2).then_some(dot(r, l))
    };
    let on_ball: Vec<u32> = (0..W * H).filter(|i| mirror(*i).is_some()).collect();
    let want = *on_ball.iter().max_by(|a, b| mirror(**a).partial_cmp(&mirror(**b)).unwrap()).unwrap();
    let got = *on_ball.iter().max_by(|a, b| lum(on[**a as usize]).total_cmp(&lum(on[**b as usize]))).unwrap();
    let at = |i: u32| ((i % W) as i32, (i / W) as i32);
    let (w, g) = (at(want), at(got));
    let term = lum(on[want as usize]) - lum(off[want as usize]);
    println!("mirror pixel {w:?}, brightest {g:?}, sun term at the mirror pixel {term:.3}");
    assert!((w.0 - g.0).abs() <= 2 && (w.1 - g.1).abs() <= 2, "brightest {g:?}, mirror {w:?}");
    assert!(term > 10.0, "the sun adds {term:.3} at the mirror pixel");
}

#[test]
fn the_light_sample_carries_the_specular_lobe() {
    let Some(mut t) = tracer() else { return };
    for m in [gloss(), metal()] {
        let on = render(&mut t, sun(2.0), &m, 256);
        let off = render(&mut t, sun(0.0), &m, 256);
        let want = expected(&m, 2.0);
        // Over the highlight, where the specular lobe is most of the sun's term.
        let (mut got_sum, mut want_sum, mut n) = (0f64, 0f64, 0);
        for (i, w) in want.iter().enumerate() {
            let Some([spec, diffuse]) = w else { continue };
            if spec < diffuse {
                continue;
            }
            got_sum += (lum(on[i]) - lum(off[i])) as f64;
            want_sum += (spec + diffuse) as f64;
            n += 1;
        }
        let ratio = got_sum / want_sum;
        println!("roughness {:?} metalness {:?}: over {n} highlight pixels the sun adds {got_sum:.1}, the BSDF says {want_sum:.1}, ratio {ratio:.4}", m.roughness, m.metalness);
        assert!(n > 10 && (ratio - 1.0).abs() < 0.05, "the sun term over the highlight is {ratio:.4} of diffuse plus GGX");
    }
}

/// Every view angle of the ball against the n.v bins `bins` reads 1 within
/// `tol`, for a material that loses no energy to single scattering.
#[test]
fn white_furnace() {
    let Some(mut t) = tracer() else { return };
    let cases = [
        ("lambert", PageMaterial { color: Some([1.0; 3]), roughness: Some(1.0), specular_intensity: Some(0.0), ..Default::default() }),
        ("mirror metal", PageMaterial { color: Some([1.0; 3]), metalness: Some(1.0), roughness: Some(0.05), ..Default::default() }),
    ];
    for (name, m) in cases {
        furnace(&mut t, m, (W, H));
        t.set_cap(512);
        t.render_samples(512);
        let hdr = t.read_hdr();
        let mut bins = [(0f64, 0u32); 5];
        for (i, c) in hdr.iter().enumerate() {
            let Some((n, v)) = hit((i as u32 % W) as f32 + 0.5, (i as u32 / W) as f32 + 0.5) else { continue };
            let k = ((dot(n, v) * 5.0) as usize).min(4);
            bins[k].0 += lum(*c) as f64;
            bins[k].1 += 1;
        }
        let means: Vec<f64> = bins.iter().map(|b| b.0 / b.1.max(1) as f64).collect();
        println!("{name}: by n.v 0-0.2 .. 0.8-1 {means:.3?}");
        for (k, m) in means.iter().enumerate().skip(1) {
            assert!((m - 1.0).abs() < 0.02, "{name}: n.v bin {k} reads {m:.4}");
        }
    }
}

const FILL: [f32; 3] = [-50.0, 40.0, 20.0];

fn light(direction: [f32; 3], color: f32, angular_radius: f32) -> LightDesc {
    LightDesc { direction, color: [color; 3], angular_radius }
}

fn lit(lights: &[LightDesc], sky: f32) -> Look {
    Look { sky_top: [sky; 3], sky_bottom: [sky; 3], lights: Some(Lights::new(lights)), ..Look::default() }
}

/// The golden scene's ball and floor, `ball` the ball's material.
fn on_floor(t: &mut Tracer, look: Look, ball: PageMaterial, spp: u32) -> Vec<[f32; 3]> {
    t.resize(64, 48);
    t.set_camera(fundacad_tracer::Camera { eye: BALL_EYE, target: BALL_TARGET, up: [0.0, 0.0, 1.0], fov: 40.0, ..Default::default() });
    t.set_look(look);
    let bodies = vec![place("ball", "ball.1", 1.0, [0.0, 0.0, 1.0], ball), place("floor", "floor.1", 1.0, [0.0; 3], matte([0.7; 3]))];
    for key in t.set_bodies(bodies) {
        t.add_mesh(&key, if key.starts_with("floor") { floor(20.0) } else { sphere(1.0, 48, 24) });
    }
    t.apply();
    t.set_cap(spp);
    t.render_samples(spp);
    t.read_hdr()
}

/// Mean luminance of each `n` by `n` block.
fn blocks(hdr: &[[f32; 3]], w: usize, n: usize) -> Vec<f64> {
    let h = hdr.len() / w;
    let mut out = vec![];
    for by in 0..h / n {
        for bx in 0..w / n {
            let mut s = 0.0;
            for y in 0..n {
                for x in 0..n {
                    s += lum(hdr[(by * n + y) * w + bx * n + x]) as f64;
                }
            }
            out.push(s / (n * n) as f64);
        }
    }
    out
}

fn mean(hdr: &[[f32; 3]]) -> f64 {
    hdr.iter().map(|c| lum(*c) as f64).sum::<f64>() / hdr.len() as f64
}

/// Root mean square of the difference of two block lists, over the mean of the first.
fn relative_rmse(a: &[f64], b: &[f64]) -> f64 {
    let sq: f64 = a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum();
    (sq / a.len() as f64).sqrt() / (a.iter().sum::<f64>() / a.len() as f64)
}

#[test]
fn two_lights_equal_the_sum_of_one_light_renders() {
    let Some(mut t) = tracer() else { return };
    let (key, fill) = (light(SUN, 2.0, 1.0), light(FILL, 0.6, 1.0));
    let ball = matte([0.8, 0.3, 0.2]);
    let both = on_floor(&mut t, lit(&[key, fill], 0.0), ball.clone(), 1024);
    let a = on_floor(&mut t, lit(&[key], 0.0), ball.clone(), 1024);
    let b = on_floor(&mut t, lit(&[fill], 0.0), ball, 1024);
    let sum: Vec<[f32; 3]> = a.iter().zip(&b).map(|(x, y)| [0, 1, 2].map(|k| x[k] + y[k])).collect();
    let fill_share = mean(&b) / mean(&sum);
    let e = relative_rmse(&blocks(&sum, 64, 4), &blocks(&both, 64, 4));
    let mean = (mean(&both), mean(&sum));
    println!("fill {:.1} percent of the picture; 4x4 blocks differ by {:.2} percent rms, means {:.4} and {:.4}", 100.0 * fill_share, 100.0 * e, mean.0, mean.1);
    assert!(fill_share > 0.03, "the fill adds {fill_share:.4}");
    assert!(e < 0.01 && (mean.0 / mean.1 - 1.0).abs() < 0.003, "two lights against the sum: {e:.4} rms, means {mean:?}");
}

/// Mean of each 8 by 8 block of an RGBA8 picture `w` wide, per channel.
fn display_blocks(rgba: &[u8], w: usize) -> Vec<f64> {
    let h = rgba.len() / 4 / w;
    let mut out = vec![];
    for by in 0..h / 8 {
        for bx in 0..w / 8 {
            for k in 0..3 {
                let mut s = 0.0;
                for y in 0..8 {
                    for x in 0..8 {
                        s += rgba[((by * 8 + y) * w + bx * 8 + x) * 4 + k] as f64;
                    }
                }
                out.push(s / 64.0);
            }
        }
    }
    out
}

/// The same picture three ways, light samples only, bounce rays only and
/// both weighted, has to come out the same: a light whose disc a bounce can
/// find, so the bounce only estimator sees it too.
#[test]
fn nee_bsdf_and_mis_agree() {
    let Some(mut t) = tracer() else { return };
    let m = PageMaterial { color: Some([0.95, 0.75, 0.4]), metalness: Some(1.0), roughness: Some(0.3), ..Default::default() };
    let look = lit(&[light(SUN, 2.0, 10.0), light(FILL, 0.6, 10.0)], 0.05);
    let mut runs = vec![];
    for e in [Estimator::Mis, Estimator::Nee, Estimator::Bsdf] {
        t.set_estimator(e);
        let hdr = on_floor(&mut t, look, m.clone(), 4096);
        runs.push((e, mean(&hdr), display_blocks(&t.resolve(), 64)));
    }
    t.set_estimator(Estimator::Default);
    for (e, m, d) in &runs[1..] {
        let mad = d.iter().zip(&runs[0].2).map(|(a, b)| (a - b).abs()).sum::<f64>() / d.len() as f64;
        println!("{e:?} against Mis: mean luminance {m:.4} and {:.4}, 8x8 blocks differ by {mad:.3} of 255 on average", runs[0].1);
        assert!(mad < 1.0 && (m / runs[0].1 - 1.0).abs() < 0.005, "{e:?} differs from Mis by {mad:.3} of 255");
    }
}

#[test]
fn the_page_look_carries_its_lights_and_background() {
    let page = r#"{"skyTop":[0.2,0.2,0.2],"sunDir":[0,0,1],"sunColor":[3,3,3],"background":[0.1,0.2,0.3],
        "lights":[{"direction":[-50,40,20],"color":[0.6,0.6,0.6],"angularRadius":1},{"direction":[0.4,-0.3,1],"color":[2,2,2],"angularRadius":1}]}"#;
    let l: Look = serde_json::from_str(page).unwrap();
    assert_eq!(l.background, Some([0.1, 0.2, 0.3]));
    let lights = l.light_list();
    let lights = lights.as_slice();
    assert_eq!(lights.len(), 2);
    assert_eq!(lights[0].color, [2.0; 3], "the strongest first");
    assert_eq!(lights[1].angular_radius, 1.0);
    let old: Look = serde_json::from_str(r#"{"sunDir":[0,0,1],"sunColor":[3,3,3]}"#).unwrap();
    let sun = old.light_list();
    assert_eq!(sun.as_slice(), &[LightDesc { direction: [0.0, 0.0, 1.0], color: [3.0; 3], angular_radius: 0.0 }]);
    assert!(Look::default().light_list().as_slice().is_empty());
    let dark = Lights::new(&[LightDesc { direction: [0.0, 0.0, 1.0], color: [0.0; 3], angular_radius: 1.0 }]);
    assert!(dark.as_slice().is_empty(), "a light sample would divide by its zero chance");
}

const LAMP_AT: [f32; 3] = [0.0, 0.0, 1.2];

fn glowing(color: [f32; 3]) -> PageMaterial {
    PageMaterial { color: Some([0.0; 3]), emissive: Some(color), emissive_intensity: Some(12.0), ..Default::default() }
}

/// A lamp ball over a plate, stretched by `stretch` along x so its world
/// area is not its mesh's, lit by nothing else.
fn lamp_bodies(lamp: PageMaterial, at: [f32; 3], stretch: f32) -> Vec<fundacad_tracer::BodyDesc> {
    let mut l = place("lamp", "lamp.1", 1.0, at, lamp);
    l.matrix[0] = stretch;
    vec![l, place("floor", "floor.1", 1.0, [0.0; 3], matte([0.7; 3]))]
}

const LAMP_EYE: [f32; 3] = [3.0, -4.0, 2.5];
const LAMP_TARGET: [f32; 3] = [0.0, 0.0, 0.5];

/// Whether pixel `i` of the 64 x 48 lamp scene may see the unstretched lamp
/// at LAMP_AT, its outline widened by a pixel and a half.
fn on_lamp(i: usize) -> bool {
    let (w, h) = (64.0, 48.0);
    let (x, y) = ((i % 64) as f32 + 0.5, (i / 64) as f32 + 0.5);
    let fwd = norm([0, 1, 2].map(|k| LAMP_TARGET[k] - LAMP_EYE[k]));
    let right = norm(cross(fwd, [0.0, 0.0, 1.0]));
    let up = cross(right, fwd);
    let th = 20f32.to_radians().tan();
    let (px, py) = (x / w * 2.0 - 1.0, 1.0 - y / h * 2.0);
    let d = norm([0, 1, 2].map(|k| fwd[k] + px * right[k] * th * w / h + py * up[k] * th));
    let c = [0, 1, 2].map(|k| LAMP_AT[k] - LAMP_EYE[k]);
    let dist = dot(c, c).sqrt();
    let angle = (dot(d, c) / dist).clamp(-1.0, 1.0).acos();
    angle < (0.4 / dist).asin() + 1.5 * 2.0 * th / h
}

fn lamp_scene(t: &mut Tracer, bodies: Vec<fundacad_tracer::BodyDesc>, spp: u32) -> Vec<[f32; 3]> {
    t.resize(64, 48);
    t.set_camera(fundacad_tracer::Camera { eye: LAMP_EYE, target: LAMP_TARGET, up: [0.0, 0.0, 1.0], fov: 40.0, ..Default::default() });
    t.set_look(Look { sky_top: [0.02; 3], sky_bottom: [0.02; 3], ..Look::default() });
    for key in t.set_bodies(bodies) {
        t.add_mesh(&key, if key.starts_with("floor") { floor(20.0) } else { sphere(0.4, 24, 12) });
    }
    t.apply();
    t.set_cap(spp);
    t.render_samples(spp);
    t.read_hdr()
}

/// The lamp found by light samples only, by bounce rays only and both
/// weighted comes out the same picture.
#[test]
fn emitter_nee_bsdf_and_mis_agree() {
    let Some(mut t) = tracer() else { return };
    let mut runs = vec![];
    for e in [Estimator::Mis, Estimator::Nee, Estimator::Bsdf] {
        t.set_estimator(e);
        let hdr = lamp_scene(&mut t, lamp_bodies(glowing([1.0, 0.9, 0.7]), LAMP_AT, 1.5), 4096);
        runs.push((e, mean(&hdr), display_blocks(&t.resolve(), 64)));
    }
    t.set_estimator(Estimator::Default);
    for (e, m, d) in &runs[1..] {
        let mad = d.iter().zip(&runs[0].2).map(|(a, b)| (a - b).abs()).sum::<f64>() / d.len() as f64;
        println!("{e:?} against Mis: mean luminance {m:.4} and {:.4}, 8x8 blocks differ by {mad:.3} of 255 on average", runs[0].1);
        assert!(mad < 1.0 && (m / runs[0].1 - 1.0).abs() < 0.005, "{e:?} differs from Mis by {mad:.3} of 255, means {m:.4} and {:.4}", runs[0].1);
    }
}

/// A lamp marked noLight shows its glow to the camera and lights nothing:
/// every other pixel is the picture of the same lamp switched off.
#[test]
fn a_no_light_emitter_glows_and_lights_nothing() {
    let Some(mut t) = tracer() else { return };
    let glow: PageMaterial = serde_json::from_str(r#"{"color":[0,0,0],"emissive":[1,0.9,0.7],"emissiveIntensity":12,"noLight":true}"#).unwrap();
    assert!(glow.no_light);
    let pic = |t: &mut Tracer, m: PageMaterial| {
        lamp_scene(t, lamp_bodies(m, LAMP_AT, 1.0), 64);
        t.resolve()
    };
    let lit = pic(&mut t, glowing([1.0, 0.9, 0.7]));
    let off = pic(&mut t, glowing([0.0; 3]));
    let only = pic(&mut t, glow);
    let px = |rgba: &[u8], i: usize| (rgba[i * 4] as f64 + rgba[i * 4 + 1] as f64 + rgba[i * 4 + 2] as f64) / 3.0;
    let (mut glowing_px, mut plate_lit, mut plate_off) = (0, 0.0, 0.0);
    for i in 0..lit.len() / 4 {
        if on_lamp(i) {
            glowing_px += (px(&only, i) > 200.0) as usize;
            continue;
        }
        assert_eq!(&only[i * 4..i * 4 + 3], &off[i * 4..i * 4 + 3], "pixel {i} is lit by a noLight lamp");
        plate_lit += px(&lit, i);
        plate_off += px(&off, i);
    }
    println!("{glowing_px} glowing pixels, the plate sums to {plate_lit:.0} lit and {plate_off:.0} with the lamp off");
    assert!(glowing_px > 20, "the noLight lamp shows {glowing_px} glowing pixels");
    assert!(plate_lit > 3.0 * plate_off, "the lamp lights the plate when it may: {plate_lit} against {plate_off}");
}

/// The emitter table is built with the instance rows: a camera move uploads
/// neither, a moved lamp brings its table along.
#[test]
fn a_camera_move_uploads_nothing() {
    let Some(mut t) = tracer() else { return };
    lamp_scene(&mut t, lamp_bodies(glowing([1.0, 0.9, 0.7]), LAMP_AT, 1.0), 4);
    let n = t.instance_uploads();
    t.set_camera(fundacad_tracer::Camera { eye: [3.5, -4.0, 2.5], target: [0.0, 0.0, 0.5], up: [0.0, 0.0, 1.0], fov: 40.0, ..Default::default() });
    t.apply();
    assert_eq!(t.instance_uploads(), n, "a camera move uploaded the instances");
    let moved = [1.2, 0.6, 0.9];
    let mut means = vec![];
    for e in [Estimator::Nee, Estimator::Bsdf] {
        t.set_estimator(e);
        means.push(mean(&lamp_scene(&mut t, lamp_bodies(glowing([1.0, 0.9, 0.7]), moved, 1.0), 1024)));
    }
    t.set_estimator(Estimator::Default);
    assert_eq!(t.instance_uploads(), n + 1, "one upload for the moved lamp");
    println!("moved lamp: light samples only {:.4}, bounce rays only {:.4}", means[0], means[1]);
    assert!((means[0] / means[1] - 1.0).abs() < 0.02, "the light samples miss the moved lamp: {means:?}");
}
