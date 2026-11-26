//! A running tool as edits to the document: arming a target rolls the build back to just before the feature, as
//! FundaCAD 1's beginEditPreview, so a click lands on the model it applies to and the user's suppression is left alone.
//! OK hands back the one undo step it made, Cancel puts the document back.

#[cfg(test)]
mod tests;

use serde_json::{json, Value};

use super::{empty, feature, index_of, set_target, Doc, Target};
use crate::i18n;
use crate::selection::PickKind;

pub struct Run {
    pub before: Doc,
    /// The card's heading, "Fillet".
    pub title: String,
    /// The undo step OK records, "Add Fillet 3".
    pub label: String,
    pub feature: String,
    /// The targets OK waits for, in the order a click fills them.
    pub need: Vec<Target>,
    pub arm: Option<Target>,
    /// The rollback marker arming found, put back when it disarms.
    held: Option<Option<Value>>,
}

/// "edge" or "edges", the word a prompt uses for what a field takes.
pub fn noun(kind: PickKind, many: bool) -> &'static str {
    match (kind, many) {
        (PickKind::Edge, false) => "edge",
        (PickKind::Edge, true) => "edges",
        (PickKind::Face, false) => "face",
        (PickKind::Face, true) => "faces",
        (PickKind::Body, false) => "body",
        (PickKind::Body, true) => "bodies",
        (PickKind::Sketch, false) => "sketch",
        (PickKind::Sketch, true) => "sketches",
        (PickKind::Plane, false) => "plane",
        (PickKind::Plane, true) => "planes",
    }
}

impl Run {
    pub fn new(before: Doc, title: String, label: String, feature: String, need: Vec<Target>) -> Self {
        Run { before, title, label, feature, need, arm: None, held: None }
    }

    pub fn set_arm(&mut self, doc: &mut Doc, arm: Option<Target>) {
        if self.arm == arm {
            return;
        }
        self.arm = arm;
        match (arm.is_some(), self.held.is_some()) {
            (true, false) => {
                let was = doc.get("rollback").cloned();
                if let Some(at) = index_of(doc, &self.feature) {
                    let marker = was.as_ref().and_then(Value::as_f64).map(|r| r.max(0.0) as usize);
                    doc.insert("rollback".into(), json!(marker.map_or(at, |r| r.min(at))));
                }
                self.held = Some(was);
            }
            (false, true) => match self.held.take().flatten() {
                Some(v) => {
                    doc.insert("rollback".into(), v);
                }
                None => {
                    doc.remove("rollback");
                }
            },
            _ => {}
        }
    }

    /// The first needed field other than the armed one that is still empty.
    fn next_empty(&self, doc: &Doc) -> Option<Target> {
        let f = feature(doc, &self.feature)?;
        let armed = self.arm.map(|a| a.field);
        self.need.iter().copied().find(|t| Some(t.field) != armed && empty(f, t.field))
    }

    /// Why `value` cannot go in `field`: a boolean keeping a body and using it at once.
    fn refuse(&self, doc: &Doc, field: &str, value: &Value) -> Option<String> {
        let f = feature(doc, &self.feature)?;
        if f.get("type").and_then(Value::as_str) != Some("boolean") {
            return None;
        }
        let tools = super::entries(doc, &self.feature, "tools");
        match field {
            "tools" if f.get("target") == Some(value) => Some(i18n::t("tool.boolean.bodyKept")),
            "target" if tools.contains(value) => Some(i18n::t("tool.boolean.bodyUsed")),
            _ => None,
        }
    }

    /// A click on `value` for the armed field, `had` the entry already there for the same face, edge or body, which
    /// the click drops. A single field moves on to the next empty one once picked.
    pub fn pick(&mut self, doc: &mut Doc, value: Value, had: Option<Value>) -> Result<(), String> {
        let Some(arm) = self.arm else { return Ok(()) };
        let id = self.feature.clone();
        match had {
            Some(old) => set_target(doc, &id, arm.field, old, arm.many, true)?,
            None => {
                if let Some(why) = self.refuse(doc, arm.field, &value) {
                    return Err(why);
                }
                set_target(doc, &id, arm.field, value, arm.many, false)?;
                if !arm.many {
                    let next = self.next_empty(doc);
                    self.set_arm(doc, next);
                }
            }
        }
        Ok(())
    }

    /// Empties the armed field.
    pub fn clear(&mut self, doc: &mut Doc) -> Result<(), String> {
        let Some(arm) = self.arm else { return Ok(()) };
        match arm.many {
            true => set_target(doc, &self.feature, arm.field, json!([]), false, false),
            false => set_target(doc, &self.feature, arm.field, Value::Null, false, true),
        }
    }

    /// What OK still waits for, as the words to show.
    pub fn missing(&self, doc: &Doc) -> Option<String> {
        let f = feature(doc, &self.feature)?;
        let t = self.need.iter().find(|t| empty(f, t.field))?;
        Some(i18n::t_with(
            "tool.target.pickFirst",
            &[("many", if t.many { "yes" } else { "no" }.into()), ("kind", noun(t.kind, false).into())],
        ))
    }

    /// OK checks the needed targets are there and gives back the step to record, Cancel restores the document.
    pub fn finish(&mut self, doc: &mut Doc, ok: bool) -> Result<Option<(Doc, String)>, String> {
        if ok {
            if let Some(why) = self.missing(doc) {
                return Err(why);
            }
        }
        self.set_arm(doc, None);
        if !ok {
            doc.clone_from(&self.before);
            return Ok(None);
        }
        Ok((*doc != self.before).then(|| (self.before.clone(), self.label.clone())))
    }
}
