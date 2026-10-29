use super::{latest_owners, Owners};

fn owners(pairs: &[(&str, &str)]) -> Owners {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[test]
fn the_latest_body_holding_a_fingerprint_owns_it() {
    let a = owners(&[("f1", "box"), ("f2", "box")]);
    let b = owners(&[("f3", "cut")]);
    let c = owners(&[("f1", "fillet")]);
    let latest = latest_owners(&[&a, &b, &c]);
    assert_eq!(latest.get("f1").map(|s| s.as_str()), Some("fillet"));
    assert_eq!(latest.get("f2").map(|s| s.as_str()), Some("box"));
    assert_eq!(latest.get("f3").map(|s| s.as_str()), Some("cut"));
    assert_eq!(latest.get("f4"), None);
}

#[test]
fn many_bodies_index_once() {
    let bodies: Vec<Owners> =
        (0..8192).map(|b| (0..6).map(|f| (format!("k{b}_{f}"), "dup".to_string())).collect()).collect();
    let all: Vec<&Owners> = bodies.iter().collect();
    let started = std::time::Instant::now();
    let latest = latest_owners(&all);
    let hits = (0..60_000).filter(|i| latest.contains_key(format!("k{}_{}", i % 9000, i % 6).as_str())).count();
    assert_eq!(hits, (0..60_000).filter(|i| i % 9000 < 8192).count());
    assert!(started.elapsed().as_secs_f64() < 2.0, "{:?}", started.elapsed());
}
