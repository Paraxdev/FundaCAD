mod common;

use fundacad_tracer::{Camera, Lens, Look, Ortho, Path, Tracer, TracerOptions};

fn tracers() -> Vec<Tracer> {
    let mut out = Vec::new();
    for software in [true, false] {
        match Tracer::new(TracerOptions { software, ..Default::default() }) {
            Ok(t) if software || t.path() == Path::RayQuery => out.push(t),
            Ok(_) => {}
            Err(e) => eprintln!("skipped, no GPU adapter: {e}"),
        }
    }
    out
}

/// Matte boxes under a uniform sky over a black background, so every face of
/// a box shades alike and a box's silhouette is a step from 0 to one level.
fn boxes(t: &mut Tracer, size: (u32, u32), boxes: &[([f32; 3], [f32; 3])]) {
    t.resize(size.0, size.1);
    let mut look = Look::default();
    look.sky_top = [1.0; 3];
    look.sky_bottom = [1.0; 3];
    look.env_intensity = 1.0;
    look.sun_dir = [0.0; 3];
    look.exposure = 1.0;
    look.bounces = 4;
    look.background = Some([0.0; 3]);
    look.lights = None;
    t.set_look(look);
    let m = common::matte([0.8, 0.8, 0.8]);
    let bodies = boxes.iter().enumerate().map(|(i, (at, _))| common::place(&format!("b{i}"), &format!("box{i}"), 1.0, *at, m.clone())).collect();
    for key in t.set_bodies(bodies) {
        let i: usize = key[3..].parse().unwrap();
        let h = boxes[i].1;
        t.add_mesh(&key, common::cuboid(h[0], h[1], h[2]));
    }
    t.apply();
}

fn render(t: &mut Tracer, camera: Camera, spp: u32) {
    t.set_camera(camera);
    t.set_cap(spp);
    t.render_samples(spp);
}

/// Mean luminance per column over the middle eight rows.
fn profile(t: &Tracer) -> Vec<f32> {
    let (w, h) = t.size();
    let hdr = t.read_hdr();
    let rows = h / 2 - 4..h / 2 + 4;
    (0..w)
        .map(|x| rows.clone().map(|y| hdr[(y * w + x) as usize]).map(|v| (v[0] + v[1] + v[2]) / 3.0).sum::<f32>() / rows.len() as f32)
        .collect()
}

fn mean(p: &[f32], around: usize, half: usize) -> f32 {
    p[around - half..around + half].iter().sum::<f32>() / (2 * half) as f32
}

/// Pixels between the 10% and 90% crossings of a rising edge near `at`.
/// Over a step the box filtered pixels alone give up to 2.
fn rise(p: &[f32], at: usize, level: f32) -> f32 {
    let cross = |f: f32| {
        let lo = at.saturating_sub(16);
        (lo..(at + 16).min(p.len() - 1))
            .find(|&x| p[x + 1] >= f * level)
            .map(|x| x as f32 + 1.0 - ((p[x + 1] - f * level) / (p[x + 1] - p[x]).max(1e-6)).clamp(0.0, 1.0))
            .unwrap_or(f32::NAN)
    };
    cross(0.9) - cross(0.1)
}

#[test]
fn an_ortho_front_view_keeps_near_and_far_widths_equal() {
    // 2 unit cubes beside each other at 10, 70 and -10 units in front of
    // the eye, the last one behind it, 16 px per unit.
    let (w, h) = (128u32, 96u32);
    let cubes = [([-2.5, 0.0, 0.0], [1.0; 3]), ([0.0, -20.0, 0.0], [1.0; 3]), ([2.5, 60.0, 0.0], [1.0; 3])];
    let cam = Camera { eye: [0.0, -10.0, 0.0], target: [0.0; 3], up: [0.0, 0.0, 1.0], ortho: Some(Ortho { half_height: 3.0 }), ..Default::default() };
    for mut t in tracers() {
        boxes(&mut t, (w, h), &cubes);
        render(&mut t, cam, 64);
        let p = profile(&t);
        let width = |lo: usize, hi: usize, mid: usize| p[lo..hi].iter().sum::<f32>() / mean(&p, mid, 6);
        let got = [width(0, 44, 24), width(44, 84, 64), width(84, 128, 104)];
        let aov = t.read_aovs();
        let depth = |x: u32| aov[((h / 2 * w + x) * 2) as usize][3];
        let d = [depth(24), depth(64), depth(104)];
        eprintln!("{:?}: widths {got:?} px, want 32 each; depth {d:?}", t.path());
        for g in got {
            assert!((g - 32.0).abs() < 0.5, "{:?}: an ortho cube is {g} px wide, want 32: {got:?}", t.path());
        }
        // From a view plane behind every body, so the denoiser's relative
        // depth test sees steps of the model's size.
        assert!(d.iter().all(|&x| x > 0.0 && x < 100.0), "{:?}: ortho depth {d:?}", t.path());
        assert!((d[2] - d[0] - 60.0).abs() < 0.1 && (d[0] - d[1] - 20.0).abs() < 0.1, "{:?}: ortho depth {d:?}", t.path());
    }
}

#[test]
fn a_lens_keeps_the_focus_plane_sharp_and_blurs_with_distance() {
    // Edges at 9 (in focus), 19 and 39 units along the view, each where the
    // box's side face stays hidden: the near box's left, the others' right.
    let (w, h) = (256u32, 192u32);
    let cubes = [([-2.5, 0.0, 0.0], [1.0, 1.0, 3.0]), ([0.0, 10.0, 0.0], [1.0, 1.0, 3.0]), ([9.0, 30.0, 0.0], [2.0, 1.0, 3.0])];
    let pin = Camera { eye: [0.0, -10.0, 0.0], target: [0.0; 3], up: [0.0, 0.0, 1.0], fov: 40.0, ..Default::default() };
    let r = 0.3;
    let lens = Camera { lens: Some(Lens { focus_distance: 9.0, aperture_radius: r }), ..pin };
    // Where each edge projects, a window inside its box, and whether it falls.
    let edges = [(25usize, 55usize, false), (142, 128, true), (202, 190, true)];
    let spread = |t: &mut Tracer, cam: Camera| {
        render(t, cam, 256);
        let p = profile(t);
        let back: Vec<f32> = p.iter().rev().copied().collect();
        let n = p.len() - 1;
        edges.map(|(e, inside, falls)| if falls { rise(&back, n - e, mean(&p, inside, 4)) } else { rise(&p, e, mean(&p, inside, 4)) })
    };
    for mut t in tracers() {
        boxes(&mut t, (w, h), &cubes);
        let sharp = spread(&mut t, pin);
        let soft = spread(&mut t, lens);
        // The blur disc's diameter in pixels, 2 r |z - f| / z on the focus plane.
        let px = h as f32 / (2.0 * 9.0 * 20f32.to_radians().tan());
        let disc = [19.0f32, 39.0].map(|z| 2.0 * r * (z - 9.0) / z * px);
        eprintln!("{:?}: 10-90 rise pinhole {sharp:?} lens {soft:?}, blur discs {disc:?} px", t.path());
        assert!(sharp.iter().all(|&s| s < 2.0), "{:?}: pinhole edges {sharp:?}", t.path());
        assert!(soft[0] < 2.0, "{:?}: the focus plane blurs, {soft:?}", t.path());
        assert!(soft[1] > 0.3 * disc[0] && soft[1] < disc[0], "{:?}: mid edge {soft:?}, disc {disc:?}", t.path());
        assert!(soft[2] > 0.3 * disc[1] && soft[2] < disc[1], "{:?}: far edge {soft:?}, disc {disc:?}", t.path());
        assert!(soft[2] > 1.2 * soft[1], "{:?}: the far edge is no softer, {soft:?}", t.path());
    }
}

#[test]
fn a_camera_payload_without_ortho_or_lens_still_parses() {
    let old: Camera = serde_json::from_str(r#"{"eye":[1,2,3],"target":[0,0,0],"up":[0,0,1],"fov":40}"#).unwrap();
    assert_eq!((old.ortho, old.lens, old.fov), (None, None, 40.0));
    let new: Camera = serde_json::from_str(
        r#"{"eye":[1,2,3],"target":[0,0,0],"up":[0,0,1],"fov":40,"ortho":{"halfHeight":2.5},"lens":{"focusDistance":120,"apertureRadius":1.5}}"#,
    )
    .unwrap();
    assert_eq!(new.ortho, Some(Ortho { half_height: 2.5 }));
    assert_eq!(new.lens, Some(Lens { focus_distance: 120.0, aperture_radius: 1.5 }));
    let nulls: Camera = serde_json::from_str(r#"{"eye":[1,2,3],"target":[0,0,0],"up":[0,0,1],"fov":40,"ortho":null,"lens":null}"#).unwrap();
    assert_eq!((nulls.ortho, nulls.lens), (None, None));
}
