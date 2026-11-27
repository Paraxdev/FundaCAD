//! The line constraint tools, FundaCAD 1's sketch/constraintTools.ts click flows for Horizontal, Vertical, Parallel,
//! Perpendicular and Collinear, and its shortcut rule: a key applies to a fitting selection, else arms the tool.

use fundacad_sketch::Entity;
use serde_json::json;

use super::{dims, relations, Editor, Tool};
use crate::i18n::tr;

pub const ONE_LINE: &[&str] = &["horizontal", "vertical"];
pub const TWO_LINES: &[&str] = &["parallel", "perpendicular", "collinear"];

/// The command label, the rail's tool name.
pub fn label(kind: &str) -> &'static str {
    match kind {
        "horizontal" => "tool.horizontal",
        "vertical" => "tool.vertical",
        "parallel" => "tool.parallel",
        "perpendicular" => "tool.perpendicular",
        _ => "tool.collinear",
    }
}

impl Editor {
    fn plain_line(&self, id: &str) -> bool {
        matches!(self.solved.entities.iter().find(|e| e.id() == id), Some(Entity::Line { .. }))
    }

    /// A line or a rectangle side, which FundaCAD 1 takes as a line operand.
    fn line_operand(&self, id: &str) -> bool {
        self.plain_line(id)
            || id.split_once('~').is_some_and(|(base, _)| {
                matches!(self.solved.entities.iter().find(|e| e.id() == base), Some(Entity::Rectangle { .. }))
            })
    }

    /// A click on `id` with the `kind` tool armed, the undo label when it added a constraint.
    pub fn rule_pick(&mut self, kind: &'static str, id: String) -> Option<String> {
        if ONE_LINE.contains(&kind) {
            return self.plain_line(&id).then(|| self.add_rule(json!({"type": kind, "line": id})));
        }
        if !self.line_operand(&id) {
            return None;
        }
        match self.first.take() {
            None => {
                self.first = Some(id);
                None
            }
            Some(a) if a == id => None,
            Some(a) => Some(self.add_rule(json!({"type": kind, "l1": a, "l2": id}))),
        }
    }

    /// The shortcut or rail button for `kind`: applied to the selected line when it fits, else the tool armed with
    /// a selected line as its first pick.
    pub fn rule_key(&mut self, kind: &'static str) -> Option<String> {
        let sel = self.selected.clone();
        if ONE_LINE.contains(&kind) && sel.as_deref().is_some_and(|s| self.plain_line(s)) {
            return self.constrain(kind);
        }
        self.set_tool(Tool::Constrain(kind));
        if TWO_LINES.contains(&kind) {
            self.first = sel.filter(|s| self.line_operand(s));
        }
        None
    }

    fn add_rule(&mut self, c: serde_json::Value) -> String {
        self.constraints.push(c);
        self.resolve(true);
        let last = self.constraints.len() - 1;
        let kind = self.constraints[last]["type"].as_str().unwrap_or_default().to_string();
        if ONE_LINE.contains(&kind.as_str()) {
            let line = self.constraints[last]["line"].as_str().unwrap_or_default().to_string();
            return tr!("sketch.step.align", kind = kind, name = dims::shape_name(&self.entities, &line));
        }
        let rows =
            relations::constraint_rows(&self.entities, &self.constraints[last..], &Default::default(), &Default::default());
        tr!("step.label.add", step = rows.first().map(|r| r.name.clone()).unwrap_or(kind))
    }
}

#[cfg(test)]
#[path = "rules_tests.rs"]
mod tests;
