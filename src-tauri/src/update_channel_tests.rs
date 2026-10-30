use super::*;
use semver::Version;

const STABLE_URL: &str = "https://github.com/Paraxdev/fundacad/releases/latest/download/latest.json";
const BETA_URL: &str = "https://github.com/Paraxdev/fundacad/releases/download/beta/latest.json";
const DEV_URL: &str = "https://github.com/Paraxdev/fundacad/releases/download/development/latest.json";

fn v(s: &str) -> Version {
    Version::parse(s).unwrap()
}

#[test]
fn each_channel_has_the_endpoint_of_its_release_config() {
    assert_eq!(Channel::Stable.endpoint(), STABLE_URL);
    assert_eq!(Channel::Beta.endpoint(), BETA_URL);
    assert_eq!(Channel::Development.endpoint(), DEV_URL);
}

#[test]
fn channel_names_parse_and_round_trip() {
    for ch in [Channel::Stable, Channel::Beta, Channel::Development] {
        assert_eq!(Channel::parse(ch.as_str()), Some(ch));
    }
    assert_eq!(Channel::parse("beta"), Some(Channel::Beta));
    assert_eq!(Channel::parse("nightly"), None);
    assert_eq!(Channel::parse(""), None);
}

#[test]
fn the_build_channel_reads_back_from_its_configured_endpoint() {
    assert_eq!(Channel::from_endpoint(STABLE_URL), Some(Channel::Stable));
    assert_eq!(Channel::from_endpoint(BETA_URL), Some(Channel::Beta));
    assert_eq!(Channel::from_endpoint(DEV_URL), Some(Channel::Development));
    assert_eq!(Channel::from_endpoint("https://example.com/latest.json"), None);
}

#[test]
fn switching_beta_to_stable_and_back_changes_the_endpoint_the_next_check_uses() {
    assert_eq!(plan(Channel::Beta, Channel::Stable).unwrap().endpoint, STABLE_URL);
    assert_eq!(plan(Channel::Beta, Channel::Beta).unwrap().endpoint, BETA_URL);
    assert_eq!(plan(Channel::Stable, Channel::Beta).unwrap().endpoint, BETA_URL);
    assert_eq!(plan(Channel::Stable, Channel::Stable).unwrap().endpoint, STABLE_URL);
}

#[test]
fn a_downgrade_is_only_allowed_off_the_build_channel() {
    assert!(!plan(Channel::Beta, Channel::Beta).unwrap().allow_downgrade);
    assert!(!plan(Channel::Stable, Channel::Stable).unwrap().allow_downgrade);
    assert!(!plan(Channel::Development, Channel::Development).unwrap().allow_downgrade);
    assert!(plan(Channel::Beta, Channel::Stable).unwrap().allow_downgrade);
    assert!(plan(Channel::Stable, Channel::Beta).unwrap().allow_downgrade);
}

#[test]
fn development_is_another_product_and_never_replaces_fundacad() {
    assert_eq!(Channel::Stable.product(), Product::FundaCad);
    assert_eq!(Channel::Beta.product(), Product::FundaCad);
    assert_eq!(Channel::Development.product(), Product::FundaCadDev);
    assert!(plan(Channel::Beta, Channel::Development).is_err());
    assert!(plan(Channel::Stable, Channel::Development).is_err());
    assert!(plan(Channel::Development, Channel::Beta).is_err());
    assert!(plan(Channel::Development, Channel::Stable).is_err());
}

#[test]
fn a_newer_release_is_accepted_whether_or_not_a_downgrade_is_allowed() {
    assert!(accepts(&v("1.0.120"), &v("1.0.121"), false));
    assert!(accepts(&v("1.0.120"), &v("1.1.0"), true));
}

#[test]
fn an_older_release_is_accepted_only_when_a_downgrade_is_allowed() {
    assert!(!accepts(&v("1.0.121"), &v("1.0.120"), false));
    assert!(accepts(&v("1.0.121"), &v("1.0.120"), true));
}

#[test]
fn the_same_version_is_never_an_update() {
    assert!(!accepts(&v("1.0.120"), &v("1.0.120"), false));
    assert!(!accepts(&v("1.0.120"), &v("1.0.120"), true));
}

#[test]
fn only_a_lower_remote_version_counts_as_a_downgrade() {
    assert!(is_downgrade(&v("1.1.0"), &v("1.0.200")));
    assert!(!is_downgrade(&v("1.0.200"), &v("1.1.0")));
    assert!(!is_downgrade(&v("1.0.200"), &v("1.0.200")));
}

fn updater_section(conf: &str) -> serde_json::Value {
    let json: serde_json::Value = serde_json::from_str(conf).unwrap();
    json["plugins"]["updater"].clone()
}

#[test]
fn each_release_config_names_its_own_build_channel() {
    let beta = updater_section(include_str!("../tauri.conf.json"));
    let dev = updater_section(include_str!("../tauri.dev.conf.json"));
    let stable = updater_section(include_str!("../tauri.stable.conf.json"));
    assert_eq!(build_channel(Some(&beta)), Some(Channel::Beta));
    assert_eq!(build_channel(Some(&dev)), Some(Channel::Development));
    assert_eq!(build_channel(Some(&stable)), Some(Channel::Stable));
}

#[test]
fn a_missing_or_unknown_updater_endpoint_has_no_build_channel() {
    assert_eq!(build_channel(None), None);
    assert_eq!(build_channel(Some(&serde_json::json!({}))), None);
    assert_eq!(build_channel(Some(&serde_json::json!({ "endpoints": [] }))), None);
    assert_eq!(build_channel(Some(&serde_json::json!({ "endpoints": ["https://example.com/latest.json"] }))), None);
}
