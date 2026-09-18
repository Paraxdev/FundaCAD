//! The Python half's own numbers (tests/vectors.json, written by
//! tests/make_vectors.py on the legacy branch) against this crate's.

use serde_json::Value;

use crate::height::{hash01, height_field_smoothed, triplanar_field, wave_phases};
use crate::rng::permutation;
use crate::spec::Spec;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../tests/vectors.json")).expect("vectors parse")
}

fn floats(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

#[test]
fn noise_permutations_are_numpys() {
    let v = vectors();
    for (seed, want) in v["permutations"].as_object().unwrap() {
        let got = permutation(seed.parse().unwrap(), 256);
        let want: Vec<i64> = want.as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
        assert_eq!(got, want, "seed {seed}");
    }
}

#[test]
fn cell_hashes_and_wave_phases_are_pythons() {
    let v = vectors();
    for h in v["hashes"].as_array().unwrap() {
        let a: Vec<i64> = h.as_array().unwrap()[..4].iter().map(|x| x.as_i64().unwrap()).collect();
        assert_eq!(hash01(a[0], a[1], a[2], a[3]), h[4].as_f64().unwrap());
    }
    assert_eq!(wave_phases(), floats(&v["wave_phases"]));
}

#[test]
fn height_fields_match_the_python_half() {
    let v = vectors();
    let (u, w) = (floats(&v["u"]), floats(&v["v"]));
    let mut worst: f64 = 0.0;
    let mut differ = 0;
    for f in v["fields"].as_array().unwrap() {
        let spec = Spec::read(&f["spec"]);
        let got = height_field_smoothed(&spec.kind, &spec, &u, &w, None, None).unwrap();
        for (a, b) in got.iter().zip(floats(&f["h"])) {
            if *a != b {
                differ += 1;
                worst = worst.max((a - b).abs());
            }
        }
    }
    assert!(worst <= 1e-12, "{differ} values differ, the worst by {worst}");
    for f in v["triplanar"].as_array().unwrap() {
        let spec = Spec::read(&f["spec"]);
        let p: Vec<[f64; 3]> = v["P"].as_array().unwrap().iter().map(|r| {
            let r = floats(r);
            [r[0], r[1], r[2]]
        }).collect();
        let ww: Vec<[f64; 3]> = v["W"].as_array().unwrap().iter().map(|r| {
            let r = floats(r);
            [r[0], r[1], r[2]]
        }).collect();
        let got = triplanar_field(&spec.kind, &spec, &p, &ww, f["offset"].as_f64().unwrap()).unwrap();
        for (a, b) in got.iter().zip(floats(&f["h"])) {
            assert!((a - b).abs() <= 1e-12, "{} triplanar {a} vs {b}", spec.kind);
        }
    }
}
