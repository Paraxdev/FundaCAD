use std::time::Duration;

use serde_json::json;

use super::wire;
use crate::cache::CacheStats;

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn doc() -> serde_json::Value {
    json!({"features": [{"type": "sketch"}, {"type": "extrude"}, {"type": "fillet"}]})
}

#[test]
fn the_stages_add_up_to_the_engine_total_and_name_the_slowest_feature() {
    let stats = CacheStats {
        copy: ms(2840),
        replay: ms(137),
        slowest: Some((2, ms(121))),
        mesh_time: ms(8),
        meshed: 3,
        ..CacheStats::default()
    };
    assert_eq!(
        wire(&stats, &doc(), ms(3400)),
        json!({"copy": 2840.0, "replay": 137.0, "slow": "fillet", "post": 415.0, "mesh": 8.0, "meshed": 3})
    );
}

#[test]
fn a_feature_the_document_lacks_names_nothing_and_post_never_goes_negative() {
    let stats = CacheStats { copy: ms(70), replay: ms(31), slowest: Some((9, ms(31))), ..CacheStats::default() };
    assert_eq!(
        wire(&stats, &doc(), ms(90)),
        json!({"copy": 70.0, "replay": 31.0, "slow": null, "post": 0.0, "mesh": 0.0, "meshed": 0})
    );
    let none = wire(&CacheStats::default(), &doc(), Duration::from_micros(1234));
    assert_eq!(none["slow"], json!(null));
    assert_eq!(none["post"], json!(1.234));
}
