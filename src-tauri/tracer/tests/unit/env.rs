use std::f32::consts::PI;

use fundacad_tracer::env::{direction, f16_to_f32, f32_to_f16, uv, Sampler};
use fundacad_tracer::{Environment, Up};

fn rng(seed: &mut u64) -> f32 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    ((*seed >> 40) as f32) / (1u64 << 24) as f32
}

#[test]
fn halves_round_trip() {
    for v in [0.0, 1.0, 0.5, 2.0, 100.0, 0.001, 1e-6, 65504.0, 0.333] {
        let back = f16_to_f32(f32_to_f16(v));
        assert!((back - v).abs() <= v * 1e-3 + 1e-7, "{v} -> {back}");
    }
}

#[test]
fn the_pdf_integrates_to_one() {
    for up in [Up::Y, Up::Z] {
        let mut s = 7u64;
        let vals: Vec<f32> = (0..64 * 32).map(|_| rng(&mut s) * 4.0 + 0.01).collect();
        let e = Environment::from_rgb("r", 64, 32, up, |c, r| [vals[(r * 64 + c) as usize]; 3]);
        let t = e.tables();
        let smp = Sampler { up, t: &t };
        let mut sum = 0f64;
        for row in 0..32 {
            for col in 0..64 {
                let (u, v) = ((col as f32 + 0.5) / 64.0, (row as f32 + 0.5) / 32.0);
                let omega = 2.0 * PI / 64.0 * PI / 32.0 * (v * PI).sin();
                sum += (smp.pdf(direction(up, u, v)) * omega) as f64;
            }
        }
        assert!((sum - 1.0).abs() < 1e-3, "{up:?}: {sum}");
    }
}

#[test]
fn directions_round_trip_the_fixture() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/env_directions.json");
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let pairs = doc["pairs"].as_array().unwrap();
    assert!(pairs.len() >= 8);
    for p in pairs {
        let up: Up = serde_json::from_value(p["layout"].clone()).unwrap();
        let (u, v) = (p["u"].as_f64().unwrap() as f32, p["v"].as_f64().unwrap() as f32);
        let want: Vec<f32> = p["dir"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
        let d = direction(up, u, v);
        for k in 0..3 {
            assert!((d[k] - want[k]).abs() < 1e-5, "{p}: {d:?}");
        }
        let (bu, bv) = uv(up, want.clone().try_into().unwrap());
        assert!((bu - u).abs() < 1e-5 && (bv - v).abs() < 1e-5, "{p}: back to {bu}, {bv}");
    }
}

#[test]
fn the_tables_leave_room_after_them() {
    let e = Environment::from_rgb("k", 8, 4, Up::Y, |_, _| [1.0; 3]);
    let t = e.tables();
    assert_eq!(t[1][1] as usize, t.len());
    assert!((t[1][0] - 1.0).abs() < 4e-2, "a white sphere has mean radiance 1, got {}", t[1][0]);
}

#[test]
fn the_up_irradiance_follows_the_layout() {
    for up in [Up::Y, Up::Z] {
        let white = Environment::from_rgb("w", 64, 32, up, |_, _| [1.0; 3]).tables()[1][2];
        assert!((white - PI).abs() < 1e-2, "{up:?}: a white sphere gives an up face pi, got {white}");
        let sky = Environment::from_rgb("s", 64, 32, up, |c, r| {
            if direction(up, (c as f32 + 0.5) / 64.0, (r as f32 + 0.5) / 32.0)[2] > 0.0 {
                [0.0; 3]
            } else {
                [1.0; 3]
            }
        });
        assert_eq!(sky.tables()[1][2], 0.0, "{up:?}: light from below reaches an up face");
    }
}
