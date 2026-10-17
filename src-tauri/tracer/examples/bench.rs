//! Samples per second and time to a sample count, one JSON line per run.
//! BENCH_PATH rq|sw, BENCH_SCENE small|many|big, BENCH_W, BENCH_H, BENCH_SPP,
//! BENCH_BUDGET (software paths per dispatch).

use std::time::Instant;

use fundacad_tracer::{BodyDesc, Camera, Look, Mesh, PageMaterial, Tracer, TracerOptions};

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

fn sphere(su: u32, sv: u32) -> Mesh {
    let mut m = Mesh::default();
    for j in 0..=sv {
        let th = std::f32::consts::PI * j as f32 / sv as f32;
        for i in 0..=su {
            let ph = std::f32::consts::TAU * i as f32 / su as f32;
            let n = [th.sin() * ph.cos(), th.sin() * ph.sin(), th.cos()];
            m.positions.push(n);
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

fn body(id: &str, key: &str, s: f32, t: [f32; 3], mat: PageMaterial) -> BodyDesc {
    let mut matrix = [0.0; 16];
    matrix[0] = s;
    matrix[5] = s;
    matrix[10] = s;
    matrix[15] = 1.0;
    matrix[12..15].copy_from_slice(&t);
    BodyDesc { id: id.into(), key: key.into(), matrix, visible: true, materials: vec![mat] }
}

fn main() {
    let software = env("BENCH_PATH", "rq") == "sw";
    let name = env("BENCH_SCENE", "small");
    let w: u32 = env("BENCH_W", "1920").parse().unwrap();
    let h: u32 = env("BENCH_H", "1080").parse().unwrap();
    let spp: u32 = env("BENCH_SPP", "256").parse().unwrap();
    let t0 = Instant::now();
    let mut t = Tracer::new(TracerOptions { software, ..Default::default() }).expect("adapter");
    let init_ms = t0.elapsed().as_secs_f64() * 1e3;
    t.resize(w, h);
    t.set_cap(spp);
    if let Ok(b) = std::env::var("BENCH_BUDGET") {
        t.set_frame_budget(b.parse().unwrap());
    }
    let diffuse = PageMaterial { color: Some([0.8, 0.3, 0.2]), ..Default::default() };
    let glass = PageMaterial { transmission: Some(1.0), roughness: Some(0.0), ..Default::default() };
    let grey = PageMaterial { color: Some([0.7; 3]), ..Default::default() };
    let mut bodies = vec![body("floor", "floor", 40.0, [0.0, 0.0, -1.0], grey)];
    let (mesh, eye) = match name.as_str() {
        "many" => {
            for i in 0..64 {
                let (x, y) = ((i % 8) as f32 * 2.5 - 8.75, (i / 8) as f32 * 2.5 - 8.75);
                let m = if i % 3 == 0 { glass.clone() } else { diffuse.clone() };
                bodies.push(body(&format!("b{i}"), "ball", 1.0, [x, y, 0.0], m));
            }
            (sphere(128, 62), [14.0, -20.0, 12.0])
        }
        "big" => {
            bodies.push(body("b", "ball", 1.0, [0.0; 3], diffuse));
            (sphere(1000, 500), [3.0, -4.5, 2.0])
        }
        _ => {
            bodies.push(body("b", "ball", 1.0, [0.0; 3], diffuse));
            (sphere(128, 97), [3.0, -4.5, 2.0])
        }
    };
    let tris: usize = mesh.tri_count() * (bodies.len() - 1) + 2;
    t.set_camera(Camera { eye, target: [0.0; 3], up: [0.0, 0.0, 1.0], fov: 40.0 });
    t.set_look(Look { sun_dir: [0.4, -0.3, 1.0], sun_color: [2.0; 3], ..Look::default() });
    for k in t.set_bodies(bodies) {
        if k == "floor" {
            t.add_mesh(&k, Mesh {
                positions: vec![[-1.0, -1.0, 0.0], [1.0, -1.0, 0.0], [1.0, 1.0, 0.0], [-1.0, 1.0, 0.0]],
                normals: vec![[0.0, 0.0, 1.0]; 4],
                indices: vec![0, 1, 2, 0, 2, 3],
                ..Default::default()
            });
        } else {
            t.add_mesh(&k, mesh.clone());
        }
    }
    let ta = Instant::now();
    t.apply();
    t.wait();
    let accel_ms = ta.elapsed().as_secs_f64() * 1e3;
    // The first dispatch carries the pipeline's first use; time it apart.
    let tf = Instant::now();
    t.step();
    t.wait();
    let first_ms = tf.elapsed().as_secs_f64() * 1e3;
    // BENCH_LOOP=frame times what the app's transport asks for per frame:
    // tracing for 12 ms, the resolve and the readback.
    let frames = env("BENCH_LOOP", "dispatch") == "frame";
    let mut dispatch = vec![];
    let start = Instant::now();
    loop {
        let td = Instant::now();
        if frames {
            if t.done() {
                break;
            }
            t.frame(w, h, std::time::Duration::from_millis(12));
        } else {
            if !t.step() {
                break;
            }
            t.wait();
        }
        dispatch.push(td.elapsed().as_secs_f64() * 1e3);
    }
    let secs = start.elapsed().as_secs_f64();
    dispatch.sort_by(|a, b| a.total_cmp(b));
    let p = |q: f64| dispatch.get(((dispatch.len() as f64 - 1.0) * q) as usize).copied().unwrap_or(0.0);
    let samples = (t.samples() as f64 - 1.0).max(1.0) * w as f64 * h as f64;
    let tr = Instant::now();
    let img = t.resolve();
    let resolve_ms = tr.elapsed().as_secs_f64() * 1e3;
    if let Ok(out) = std::env::var("BENCH_OUT") {
        std::fs::write(out, &img).unwrap();
    }
    println!(
        "{{\"loop\":\"{}\",\"band\":{},\"path\":\"{:?}\",\"adapter\":\"{}\",\"scene\":\"{}\",\"tris\":{},\"w\":{},\"h\":{},\"spp\":{},\"init_ms\":{:.0},\"accel_ms\":{:.1},\"first_dispatch_ms\":{:.1},\"dispatch_p50_ms\":{:.2},\"dispatch_p95_ms\":{:.2},\"msamples_per_s\":{:.1},\"spp_per_s\":{:.1},\"time_to_spp_s\":{:.2},\"resolve_ms\":{:.1}}}",
        if frames { "frame" } else { "dispatch" }, t.band(), t.path(), t.adapter(), name, tris, w, h, t.samples(), init_ms, accel_ms, first_ms, p(0.5), p(0.95),
        samples / secs / 1e6, samples / secs / (w as f64 * h as f64), secs + first_ms / 1e3, resolve_ms
    );
}
