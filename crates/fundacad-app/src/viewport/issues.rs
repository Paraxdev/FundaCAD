use serde_json::{Map, Value};

/// A build problem of one feature, for History to mark its step.
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureIssue {
    pub feature_id: String,
    pub message: String,
    /// The feature built, but not all of it: a mesh pass left faces plain, or the engine skipped an unknown type.
    pub warning: bool,
    /// A warning that is an engine advisory with a reason, shown as a note.
    pub note: bool,
}

/// The issues a rebuild reported, from its `featureErrors`, `skippedFeatures` and `diagnostics`.
pub fn of_result(result: &Map<String, Value>) -> Vec<FeatureIssue> {
    let list = |key| result.get(key).and_then(Value::as_array).into_iter().flatten();
    let issue = |e: &Value, warning: bool| {
        Some(FeatureIssue {
            feature_id: e.get("feature_id")?.as_str()?.to_owned(),
            message: e.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
            warning,
            note: false,
        })
    };
    let errors =
        list("featureErrors").filter_map(|e| issue(e, e.get("code").and_then(Value::as_str) == Some("mesh-pass")));
    let skipped = list("skippedFeatures").filter_map(|e| issue(e, true));
    let mut out: Vec<FeatureIssue> = errors.chain(skipped).collect();
    out.extend(advisories(result, &out));
    out
}

/// One advisory per feature with a reason, none for a failed one, as featureNotes in src/ui/featureNotes.ts: the
/// first reason wins, except that a coded advisory replaces one from a lossy match, since it says what was built.
fn advisories(result: &Map<String, Value>, issues: &[FeatureIssue]) -> Vec<FeatureIssue> {
    let mut out: Vec<(FeatureIssue, bool)> = Vec::new();
    for d in result.get("diagnostics").and_then(Value::as_array).into_iter().flatten() {
        let (Some(id), Some(reason)) =
            (d.get("feature_id").and_then(Value::as_str), d.get("reason").and_then(Value::as_str))
        else {
            continue;
        };
        if reason.is_empty() || issues.iter().any(|i| i.feature_id == id && !i.warning) {
            continue;
        }
        let coded = d.get("code").and_then(Value::as_str).is_some_and(|c| !c.is_empty());
        let lossy = d.get("lossy").and_then(Value::as_bool) == Some(true) && !coded;
        let issue = FeatureIssue { feature_id: id.to_owned(), message: reason.to_owned(), warning: true, note: true };
        match out.iter_mut().find(|(i, _)| i.feature_id == id) {
            Some(slot) if coded && slot.1 => *slot = (issue, lossy),
            Some(_) => {}
            None => out.push((issue, lossy)),
        }
    }
    out.into_iter().map(|(i, _)| i).collect()
}

/// A failed rebuild keeps the last mesh, so the issues it had stay and the failing feature gets an error.
pub fn failed(issues: &mut Vec<FeatureIssue>, feature_id: &str, message: &str) {
    issues.retain(|i| i.feature_id != feature_id);
    issues.push(FeatureIssue {
        feature_id: feature_id.to_owned(),
        message: message.to_owned(),
        warning: false,
        note: false,
    });
}

#[cfg(test)]
mod tests;
