//! Scenes, 16 bit references and the RMSE helper shared by the image tests and
//! examples/bench.rs. Included with `mod common;` or `#[path]`.
#![allow(dead_code)]

use fundacad_tracer::env::direction;
use fundacad_tracer::{BodyDesc, Camera, Environment, Look, Mesh, PageMaterial, Refusal, Tracer, TracerOptions, Up};
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const REF_SCENES: [&str; 6] = ["golden", "studio", "hdr-sun", "emitter", "glass", "metal"];
pub const REF_SPP: u32 = 16384;

/// How long a test exe may go on after its last tracer was made. One test may run
/// long on a single tracer: the environment NEE check takes about 77 s on lavapipe.
pub const HANG_LIMIT: Duration = Duration::from_secs(300);

/// Tracer::new with the hang watchdog armed first.
pub fn tracer(opts: TracerOptions) -> Result<Tracer, Refusal> {
    watchdog();
    Tracer::new(opts)
}

/// Aborts the exe with a message once HANG_LIMIT passes after the last call.
/// A Vulkan driver stuck on the Windows loader lock blocks every thread start
/// and exit, process::exit included, so the thread is started before the first
/// device and ends the exe with abort. libtest captures eprintln! from it.
pub fn watchdog() {
    static ARMED: Mutex<Option<Instant>> = Mutex::new(None);
    let mut armed = ARMED.lock().unwrap_or_else(|p| p.into_inner());
    if armed.replace(Instant::now()).is_some() {
        return;
    }
    std::thread::Builder::new()
        .name("hang watchdog".into())
        .spawn(|| loop {
            std::thread::sleep(Duration::from_millis(500));
            let at = *ARMED.lock().unwrap_or_else(|p| p.into_inner());
            if at.is_some_and(|t| t.elapsed() > HANG_LIMIT) {
                let msg = format!(
                    "
hang watchdog: nothing finished within {} s of the last tracer, a GPU or driver call never returned
",
                    HANG_LIMIT.as_secs()
                );
                let _ = std::io::stderr().write_all(msg.as_bytes());
                std::process::abort();
            }
        })
        .expect("the hang watchdog thread");
}

pub fn dims(name: &str) -> (u32, u32) {
    if name == "golden" {
        (96, 64)
    } else {
        (64, 48)
    }
}

pub fn ref_path(name: &str) -> String {
    format!("{}/tests/refs/{name}.png", env!("CARGO_MANIFEST_DIR"))
}

pub use fundacad_tracer::selfcheck::{floor, sphere};

/// An axis aligned box with flat faces, centred on the origin.
pub fn cuboid(hx: f32, hy: f32, hz: f32) -> Mesh {
    let mut m = Mesh::default();
    let h = [hx, hy, hz];
    for axis in 0..3 {
        for sign in [-1.0f32, 1.0] {
            let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
            let base = m.positions.len() as u32;
            for (a, b) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
                let mut p = [0.0; 3];
                p[axis] = sign * h[axis];
                p[u] = a * h[u];
                p[v] = b * h[v];
                let mut n = [0.0; 3];
                n[axis] = sign;
                m.positions.push(p);
                m.normals.push(n);
            }
            let q = if sign > 0.0 { [0, 1, 2, 0, 2, 3] } else { [0, 2, 1, 0, 3, 2] };
            m.indices.extend(q.map(|i| base + i));
        }
    }
    m
}

pub fn place(id: &str, key: &str, scale: f32, at: [f32; 3], mat: PageMaterial) -> BodyDesc {
    let mut matrix = [0.0; 16];
    for k in 0..3 {
        matrix[k * 5] = scale;
    }
    matrix[15] = 1.0;
    matrix[12..15].copy_from_slice(&at);
    BodyDesc { id: id.into(), key: key.into(), matrix, visible: true, materials: vec![mat] }
}

pub fn matte(color: [f32; 3]) -> PageMaterial {
    PageMaterial { color: Some(color), roughness: Some(1.0), ..Default::default() }
}

fn mesh_for(key: &str) -> Mesh {
    match key {
        k if k.starts_with("floor") => floor(20.0),
        k if k.starts_with("part") => cuboid(1.0, 0.7, 0.5),
        k if k.starts_with("lamp") => sphere(0.4, 24, 12),
        k if k.starts_with("ball") => sphere(1.0, 48, 24),
        k if k.starts_with("dot") => sphere(0.3, 16, 8),
        other => panic!("no mesh for {other}"),
    }
}

/// Sizes the tracer (the scene's own size when `size` is None), builds the
/// scene and commits it. The sample cap is the caller's.
pub fn build(t: &mut Tracer, name: &str, size: Option<(u32, u32)>) {
    let (w, h) = size.unwrap_or_else(|| dims(name));
    t.resize(w, h);
    let cam = |eye: [f32; 3], target: [f32; 3]| Camera { eye, target, up: [0.0, 0.0, 1.0], fov: 40.0, ..Default::default() };
    let sun = [0.4, -0.3, 1.0];
    let ground = matte([0.7; 3]);
    let (look, camera, bodies) = match name {
        "golden" => (
            Look { sun_dir: sun, sun_color: [2.0; 3], ..Look::default() },
            cam([4.0, -6.0, 3.0], [0.0, 0.0, 0.8]),
            vec![
                place("ball", "ball.1", 1.0, [0.0, 0.0, 1.0], matte([0.8, 0.3, 0.2])),
                place("floor", "floor.1", 1.0, [0.0; 3], ground),
            ],
        ),
        "studio" => (
            Look {
                sun_dir: [0.5, -0.4, 1.0],
                sun_color: [1.2; 3],
                ..Look::default()
            },
            cam([3.6, -5.0, 2.6], [0.0, 0.0, 0.5]),
            vec![
                place("part", "part.1", 1.0, [0.0, 0.0, 0.5], matte([0.35, 0.5, 0.7])),
                place("floor", "floor.1", 1.0, [0.0; 3], matte([0.8; 3])),
            ],
        ),
        "hdr-sun" => (
            Look::default(),
            cam([4.0, -6.0, 3.0], [0.0, 0.0, 0.8]),
            vec![
                place("ball", "ball.1", 1.0, [0.0, 0.0, 1.0], matte([0.8; 3])),
                place("floor", "floor.1", 1.0, [0.0; 3], ground),
            ],
        ),
        "emitter" => (
            Look { sky_top: [0.02; 3], sky_bottom: [0.02; 3], ..Look::default() },
            cam([4.0, -6.0, 3.0], [0.0, 0.0, 0.8]),
            vec![
                place("ball", "ball.1", 1.0, [0.0, 0.0, 1.0], matte([0.8; 3])),
                place(
                    "lamp",
                    "lamp.1",
                    1.0,
                    [1.6, -0.6, 2.2],
                    PageMaterial {
                        color: Some([0.0; 3]),
                        emissive: Some([1.0, 0.9, 0.7]),
                        emissive_intensity: Some(12.0),
                        ..Default::default()
                    },
                ),
                place("floor", "floor.1", 1.0, [0.0; 3], ground),
            ],
        ),
        "glass" => (
            Look { sun_dir: sun, sun_color: [2.0; 3], ..Look::default() },
            cam([4.0, -6.0, 3.0], [0.0, 0.0, 0.8]),
            vec![
                place(
                    "ball",
                    "ball.1",
                    1.0,
                    [0.0, 0.0, 1.0],
                    PageMaterial {
                        color: Some([0.9, 0.95, 1.0]),
                        transmission: Some(1.0),
                        roughness: Some(0.0),
                        ior: Some(1.5),
                        ..Default::default()
                    },
                ),
                place("floor", "floor.1", 1.0, [0.0; 3], ground),
            ],
        ),
        "metal" => (
            Look { sun_dir: sun, sun_color: [2.0; 3], ..Look::default() },
            cam([4.0, -6.0, 3.0], [0.0, 0.0, 0.8]),
            vec![
                place(
                    "ball",
                    "ball.1",
                    1.0,
                    [0.0, 0.0, 1.0],
                    PageMaterial {
                        color: Some([0.95, 0.75, 0.4]),
                        metalness: Some(1.0),
                        roughness: Some(0.25),
                        ..Default::default()
                    },
                ),
                place("floor", "floor.1", 1.0, [0.0; 3], ground),
            ],
        ),
        "assembly" => {
            let mut v = vec![place("floor", "floor.1", 1.0, [0.0; 3], ground)];
            for i in 0..300u32 {
                let (x, y) = ((i % 20) as f32 * 0.9 - 8.55, (i / 20) as f32 * 0.9 - 6.3);
                let tint = [0.3 + 0.05 * (i % 7) as f32, 0.4 + 0.04 * (i % 5) as f32, 0.7 - 0.03 * (i % 9) as f32];
                v.push(place(&format!("dot{i}"), "dot.1", 1.0, [x, y, 0.3], matte(tint)));
            }
            (
                Look { sun_dir: sun, sun_color: [1.5; 3], ..Look::default() },
                cam([0.0, -17.0, 11.0], [0.0, 0.0, 0.0]),
                v,
            )
        }
        other => panic!("unknown scene {other}"),
    };
    t.set_camera(camera);
    t.set_look(look);
    t.set_environment(match name {
        "studio" => Some(studio_room()),
        "hdr-sun" => Some(sun_sky()),
        _ => None,
    });
    for key in t.set_bodies(bodies) {
        t.add_mesh(&key, mesh_for(&key));
    }
    t.apply();
}

pub use fundacad_tracer::display16;

pub fn write_ref(name: &str, hdr: &[[f32; 3]], w: u32, h: u32) {
    let path = ref_path(name);
    std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
    let mut data = Vec::with_capacity(hdr.len() * 6);
    for px in hdr {
        for v in display16(*px) {
            data.extend(v.to_be_bytes());
        }
    }
    let mut enc = png::Encoder::new(std::fs::File::create(path).unwrap(), w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Sixteen);
    enc.write_header().unwrap().write_image_data(&data).unwrap();
}

/// The reference as rgb in 0..255 floats, and its size.
pub fn read_ref(name: &str) -> (Vec<f32>, u32, u32) {
    let dec = png::Decoder::new(std::fs::File::open(ref_path(name)).expect("reference missing, run with TRACER_REF_WRITE=1"));
    let mut r = dec.read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size()];
    let info = r.next_frame(&mut buf).unwrap();
    assert_eq!((info.color_type, info.bit_depth), (png::ColorType::Rgb, png::BitDepth::Sixteen));
    let v = buf[..info.buffer_size()].chunks_exact(2).map(|b| u16::from_be_bytes([b[0], b[1]]) as f32 / 257.0).collect();
    (v, info.width, info.height)
}

/// Root mean square error of an 8 bit RGBA picture (resolve output) against
/// the committed reference, in units of 255, over rgb.
pub fn rmse_to_ref(rgba: &[u8], name: &str) -> f64 {
    let (reference, w, h) = read_ref(name);
    assert_eq!(rgba.len(), (w * h * 4) as usize, "{name}: the picture and the reference differ in size");
    let mut sq = 0.0;
    for (px, r) in rgba.chunks_exact(4).zip(reference.chunks_exact(3)) {
        for k in 0..3 {
            let d = px[k] as f64 - r[k] as f64;
            sq += d * d;
        }
    }
    (sq / (w * h * 3) as f64).sqrt()
}

/// None unless `TRACER_REF_WRITE=1`; then the scene named by TRACER_REF_ONLY, if any.
pub fn ref_write_wanted_for() -> Option<Option<String>> {
    std::env::var_os("TRACER_REF_WRITE")?;
    Some(std::env::var("TRACER_REF_ONLY").ok())
}

pub const BALL_EYE: [f32; 3] = [4.0, -6.0, 3.0];
pub const BALL_TARGET: [f32; 3] = [0.0, 0.0, 0.8];

/// A unit ball at (0, 0, 1) and nothing else, finely tessellated so its
/// shading normals sit on the analytic sphere's.
pub fn ball_alone(t: &mut Tracer, look: Look, mat: PageMaterial, (w, h): (u32, u32)) {
    t.resize(w, h);
    t.set_camera(Camera { eye: BALL_EYE, target: BALL_TARGET, up: [0.0, 0.0, 1.0], fov: 40.0, ..Default::default() });
    t.set_look(look);
    for key in t.set_bodies(vec![place("ball", "ball.fine", 1.0, [0.0, 0.0, 1.0], mat)]) {
        t.add_mesh(&key, sphere(1.0, 192, 96));
    }
    t.apply();
}

/// The white furnace: the lone ball in a uniform sky of 1 with no lights.
pub fn furnace(t: &mut Tracer, mat: PageMaterial, size: (u32, u32)) {
    let look = Look { sky_top: [1.0; 3], sky_bottom: [1.0; 3], bounces: 64, ..Look::default() };
    ball_alone(t, look, mat, size);
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn unit(a: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt();
    a.map(|x| x / l)
}

/// An equirect `up` laid out, radiance from the direction of each texel's centre.
pub fn env_of(key: &str, (w, h): (u32, u32), up: Up, f: impl Fn([f32; 3]) -> [f32; 3]) -> Environment {
    Environment::from_rgb(key, w, h, up, |c, r| f(direction(up, (c as f32 + 0.5) / w as f32, (r as f32 + 0.5) / h as f32)))
}

/// A room as traceEnvironment reads one back (Y up rows): soft grey walls, a
/// darker floor and two bright panels, one above the model, one to its side.
pub fn studio_room() -> Environment {
    let top = unit([0.2, -0.3, 1.0]);
    let side = unit([-1.0, -0.4, 0.3]);
    env_of("studio", (512, 256), Up::Y, |d| {
        if dot(d, top) > 0.97 {
            [6.0; 3]
        } else if dot(d, side) > 0.985 {
            [4.0, 3.8, 3.5]
        } else if d[2] < 0.0 {
            [0.25; 3]
        } else {
            [0.55, 0.58, 0.62]
        }
    })
}

/// The sun of an outdoor HDR (Z up rows): a dim sky and a 1.5 degree disc of
/// irradiance about 6.
pub fn sun_sky() -> Environment {
    let sun = unit([-0.5, -0.6, 0.45]);
    let cos_r = 1.5f32.to_radians().cos();
    let radiance = 6.0 / (2.0 * std::f32::consts::PI * (1.0 - cos_r));
    env_of("hdr-sun", (512, 256), Up::Z, |d| {
        if dot(d, sun) > cos_r {
            [radiance, radiance * 0.93, radiance * 0.83]
        } else if d[2] > 0.0 {
            [0.04, 0.05, 0.08]
        } else {
            [0.03; 3]
        }
    })
}
