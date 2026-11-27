//! What a History row says beside its name: the marks it carries and the lines its tooltip reads.

use serde_json::{Map, Value};

use super::labels::type_label;
use super::{features, id_of, ops};
use crate::i18n::{t, tr};
use crate::viewport::FeatureIssue;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Marks {
    pub failed: Option<String>,
    /// Built, with something to say: an engine advisory, a pass that left faces plain, or a type this build skips.
    pub warning: Option<String>,
    /// The warning is an advisory, worded as a note.
    pub advisory: bool,
    pub suppressed: bool,
    /// The file an import read.
    pub file: Option<String>,
    /// The note someone wrote on the step.
    pub note: Option<String>,
}

/// The marks of each row, in order. An error wins over any warning of the same step.
pub fn marks(doc: &Map<String, Value>, issues: &[FeatureIssue]) -> Vec<Marks> {
    let suppressed: Vec<&str> =
        doc.get("suppressed").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    features(doc)
        .into_iter()
        .map(|f| {
            let id = id_of(f);
            let mine = || issues.iter().filter(|i| i.feature_id == id);
            let failed = mine().find(|i| !i.warning).map(|i| i.message.clone());
            let warned = mine().find(|i| i.warning).filter(|_| failed.is_none());
            Marks {
                failed,
                warning: warned.map(|i| i.message.clone()),
                advisory: warned.is_some_and(|i| i.note),
                suppressed: suppressed.contains(&id),
                file: file_of(f),
                note: ops::note(doc, id),
            }
        })
        .collect()
}

fn file_of(f: &Map<String, Value>) -> Option<String> {
    if f.get("type").and_then(Value::as_str) != Some("import") {
        return None;
    }
    let source = f.get("source").and_then(Value::as_str)?;
    source.rsplit(['/', '\\']).next().filter(|n| !n.is_empty()).map(str::to_owned)
}

/// FundaCAD 1's hintPlain, until a double click opens the inspector and hintEdit applies.
pub const HINT: &str = "history.chip.hintPlain";

/// The tooltip of row `i`: its place and type, then each mark as a line, then the hint.
pub fn tooltip(f: &Map<String, Value>, i: usize, m: &Marks) -> String {
    let mut lines = vec![format!("{} · {}", i + 1, type_label(f))];
    if let Some(file) = &m.file {
        lines.push(tr!("history.chip.file", name = file));
    }
    match (&m.failed, &m.warning) {
        (Some(why), _) => lines.push(tr!("history.chip.failed", message = why)),
        (None, Some(why)) if m.advisory => lines.push(tr!("history.chip.note", message = why)),
        (None, Some(why)) => lines.push(tr!("history.chip.warning", message = why)),
        (None, None) => {}
    }
    if m.suppressed {
        lines.push(t("history.chip.suppressed"));
    }
    if let Some(note) = &m.note {
        lines.push(tr!("history.chip.yourNote", note = note));
    }
    lines.push(t(HINT));
    lines.join("\n")
}

#[cfg(test)]
mod tests;
