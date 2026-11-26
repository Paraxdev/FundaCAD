use serde_json::{Map, Value};

/// A build problem of one feature, for History to mark its step.
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureIssue {
    pub feature_id: String,
    pub message: String,
    /// The feature built, but not all of it: a mesh pass left faces plain, or the engine skipped an unknown type.
    pub warning: bool,
}

/// The issues a rebuild reported, from its `featureErrors` and `skippedFeatures`.
pub fn of_result(result: &Map<String, Value>) -> Vec<FeatureIssue> {
    let list = |key| result.get(key).and_then(Value::as_array).into_iter().flatten();
    let issue = |e: &Value, warning: bool| {
        Some(FeatureIssue {
            feature_id: e.get("feature_id")?.as_str()?.to_owned(),
            message: e.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
            warning,
        })
    };
    let errors =
        list("featureErrors").filter_map(|e| issue(e, e.get("code").and_then(Value::as_str) == Some("mesh-pass")));
    let skipped = list("skippedFeatures").filter_map(|e| issue(e, true));
    errors.chain(skipped).collect()
}

/// A failed rebuild keeps the last mesh, so the issues it had stay and the failing feature gets an error.
pub fn failed(issues: &mut Vec<FeatureIssue>, feature_id: &str, message: &str) {
    issues.retain(|i| i.feature_id != feature_id);
    issues.push(FeatureIssue { feature_id: feature_id.to_owned(), message: message.to_owned(), warning: false });
}

#[cfg(test)]
mod tests {
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
        let mut issues = vec![FeatureIssue { feature_id: "f1".into(), message: "old".into(), warning: true }];
        failed(&mut issues, "f1", "boom");
        assert_eq!(issues, [FeatureIssue { feature_id: "f1".into(), message: "boom".into(), warning: false }]);
    }
}
