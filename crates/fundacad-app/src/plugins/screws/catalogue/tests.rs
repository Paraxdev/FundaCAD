use serde_json::{json, Value};

use super::*;

fn choice(family: &str, size: &str, length: Option<f64>) -> ItemChoice {
    ItemChoice { family: family.into(), size: size.into(), length, ..Default::default() }
}

#[test]
fn a_socket_cap_screw_expands_as_fundacad_1_stored_it() {
    // The spec FundaCAD 1 wrote for this choice, from crates/fundacad-core/tests/fixtures/plugin_tests.json.
    let want = json!({"drive":{"depth":0.7,"size":1.5,"type":"hex"},"head":{"diameter":3,"height":1.6,"type":"socketCap"},
        "kind":"screw","length":2.5,"name":"ISO 4762 M1.6x2.5","point":{"type":"chamfer"},"standard":"ISO 4762",
        "thread":{"designation":"M1.6","diameter":1.6,"hand":"right","length":2.5,"modelled":false,"pitch":0.35,
        "type":"metric"},"units":"mm"});
    let got = expand(&choice("iso4762", "M1.6", None)).unwrap();
    assert_eq!(got, want);
    let keys: Vec<&String> = got.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["kind", "units", "name", "standard", "head", "drive", "point", "thread", "length"]);
}

#[test]
fn a_long_screw_has_a_partial_thread_by_its_rule() {
    // ISO 4762 b = 2d + 12, full when within 5 pitches: M5x50 threads 22.
    let spec = expand(&choice("iso4762", "M5", Some(50.))).unwrap();
    assert_eq!(spec["thread"]["length"], json!(22));
    assert_eq!(spec["name"], "ISO 4762 M5x50");
    let short = expand(&choice("iso4762", "M5", Some(20.))).unwrap();
    assert_eq!(short["thread"]["length"], json!(20));
}

#[test]
fn a_length_off_the_series_falls_back_to_the_first() {
    let spec = expand(&choice("iso4762", "M3", Some(7.))).unwrap();
    assert_eq!(spec["length"], json!(lengths(family("iso4762").unwrap(), "M3")[0] as i64));
}

#[test]
fn a_fine_pitch_names_itself() {
    let f = family("iso4762").unwrap();
    assert_eq!(designation(f, "M8", 1.25), "M8");
    assert_eq!(designation(f, "M8", 1.0), "M8x1");
    let spec = expand(&ItemChoice { pitch: Some(1.0), ..choice("iso4762", "M8", Some(20.)) }).unwrap();
    assert_eq!(spec["name"], "ISO 4762 M8x1x20");
    assert_eq!(spec["thread"]["pitch"], json!(1));
}

#[test]
fn inch_lengths_read_in_fractions() {
    assert_eq!(format_inch(0.25), "1/4");
    assert_eq!(format_inch(1.5), "1-1/2");
    assert_eq!(format_inch(2.0), "2");
    assert_eq!(format_inch(0.3), "0.3");
}

#[test]
fn every_catalogue_item_expands() {
    let mut n = 0;
    for f in families() {
        for size in sizes(f) {
            let ls = lengths(f, size);
            let picks: Vec<Option<f64>> = if ls.is_empty() { vec![None] } else { ls.into_iter().map(Some).collect() };
            for l in picks {
                let spec = expand(&choice(family_id(f), size, l)).unwrap_or_else(|e| panic!("{}: {e}", family_id(f)));
                assert!(spec["name"].as_str().is_some_and(|s| !s.is_empty()));
                assert!(spec["thread"].is_object(), "{}", spec["name"]);
                n += 1;
            }
        }
    }
    assert!(n > 500, "only {n} items");
    assert!(families().iter().all(|f| CATEGORY_ORDER.contains(&category(f))));
}

#[test]
fn a_nut_has_no_length() {
    let nut = families().iter().find(|f| kind(f) == "nut").unwrap();
    let spec = expand(&choice(family_id(nut), sizes(nut)[0], None)).unwrap();
    assert_eq!(spec.get("length"), None);
    assert!(spec["thread"].get("length").is_none());
    assert!(matches!(spec["thread"]["diameter"], Value::Number(_)));
}
