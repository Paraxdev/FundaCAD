use std::cmp::Ordering::*;

use super::*;

#[test]
fn versions_compare_by_semver() {
    assert_eq!(compare("2.0.1", "2.0.0"), Some(Greater));
    assert_eq!(compare("v2.0.0", "2.0.0"), Some(Equal));
    assert_eq!(compare("2.0.0", "2.0.0-indev.0"), Some(Greater));
    assert_eq!(compare("2.0.0-indev.1", "2.0.0-indev.0"), Some(Greater));
    assert_eq!(compare("2.0.0-beta", "2.0.0-alpha.9"), Some(Greater));
    assert_eq!(compare("2.0.0-alpha.10", "2.0.0-alpha.9"), Some(Greater));
    assert_eq!(compare("2.0.0-alpha", "2.0.0-alpha.1"), Some(Less));
    assert_eq!(compare("2.0.0-1", "2.0.0-alpha"), Some(Less));
    assert_eq!(compare("1.9.12", "2.0.0-indev.0"), Some(Less));
    assert_eq!(compare("10.0.0", "9.9.9"), Some(Greater));
    assert_eq!(compare("2.0.0+build.5", "2.0.0"), Some(Equal));
    assert_eq!(compare("2.0", "2.0.0"), None);
    assert_eq!(compare("latest", "2.0.0"), None);
}

#[test]
fn the_feed_is_judged_honestly() {
    let now = "2.0.0-indev.0";
    assert_eq!(judge(now, Some(200), r#"{"version":"2.0.1"}"#, ""), Outcome::Newer("2.0.1".into()));
    assert_eq!(judge(now, Some(200), r#"{"version":"v2.1.0"}"#, ""), Outcome::Newer("2.1.0".into()));
    assert_eq!(judge(now, Some(200), r#"{"version":"1.4.0"}"#, ""), Outcome::UpToDate);
    assert_eq!(judge(now, Some(404), "Not Found", ""), Outcome::NoRelease);
    assert_eq!(judge(now, None, "", "Could not resolve host"), Outcome::Offline("Could not resolve host".into()));
    assert!(matches!(judge(now, Some(200), "<html>", ""), Outcome::Failed(_)));
    assert!(matches!(judge(now, Some(500), "", ""), Outcome::Failed(_)));
}

#[test]
fn a_newer_version_names_both() {
    assert_eq!(Outcome::Newer("2.0.1".into()).message("2.0.0"), "FundaCAD 2.0.1 is out, this is 2.0.0");
}
