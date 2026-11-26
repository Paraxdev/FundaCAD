use super::*;
use serde_json::json;

#[test]
fn errors_and_skips_become_issues_and_a_mesh_pass_is_a_warning() {
    let result = json!({
        "featureErrors": [
            {"feature_id": "f1", "message": "no profile"},
            {"feature_id": null, "message": "the document"},
            {"feature_id": "tex", "message": "texture left plain", "code": "mesh-pass"},
        ],
        "skippedFeatures": [{"feature_id": "w1", "type": "futureWidget", "message": "unknown feature type"}],
    });
    let issues = of_result(result.as_object().unwrap());
    let short: Vec<(&str, bool)> = issues.iter().map(|i| (i.feature_id.as_str(), i.warning)).collect();
    assert_eq!(short, [("f1", false), ("tex", true), ("w1", true)]);
    assert_eq!(issues[0].message, "no profile");
}

#[test]
fn a_failure_replaces_what_its_feature_had() {
    let mut issues = vec![FeatureIssue { feature_id: "f1".into(), message: "old".into(), warning: true, note: true }];
    failed(&mut issues, "f1", "boom");
    assert_eq!(issues, [FeatureIssue { feature_id: "f1".into(), message: "boom".into(), warning: false, note: false }]);
}

#[test]
fn an_advisory_with_a_reason_is_a_note_and_a_failed_feature_has_none() {
    let result = json!({
        "featureErrors": [{"feature_id": "cut", "message": "no profile"}],
        "diagnostics": [
            {"feature_id": "cut", "reason": "sealed a void"},
            {"feature_id": "rim", "reason": "matched loosely", "lossy": true},
            {"feature_id": "rim", "reason": "the fillet runs past by 0.4 mm", "code": "blendOverrun"},
            {"feature_id": "web", "reason": "first"},
            {"feature_id": "web", "reason": "second"},
            {"feature_id": "bare"},
            {"reason": "the document"},
        ],
    });
    let issues = of_result(result.as_object().unwrap());
    let note = |id: &str, message: &str| FeatureIssue {
        feature_id: id.into(),
        message: message.into(),
        warning: true,
        note: true,
    };
    assert_eq!(
        issues,
        [
            FeatureIssue { feature_id: "cut".into(), message: "no profile".into(), warning: false, note: false },
            note("rim", "the fillet runs past by 0.4 mm"),
            note("web", "first"),
        ]
    );
    assert!(of_result(json!({}).as_object().unwrap()).is_empty());
}
