use fundacad_client::Doc;

const LIMIT: usize = 200;

struct Step {
    /// The document as it was before the step.
    doc: Doc,
    key: Option<String>,
    /// What the step did, when its maker knows better than a diff of the two documents.
    label: Option<String>,
}

/// Undo and redo of whole documents. Steps with the same merge key in a row are one step, so repeated drags of one
/// face undo together, until something else is picked.
#[derive(Default)]
pub struct UndoStack {
    done: Vec<Step>,
    undone: Vec<Step>,
    /// The key the last step can still take more changes under.
    open: Option<String>,
}

impl UndoStack {
    /// The document changed from `before`. A `key` equal to the open one folds the change into the last step.
    pub fn record(&mut self, before: Doc, key: Option<String>, label: Option<String>) {
        if key.is_some() && key == self.open && !self.done.is_empty() {
            return;
        }
        if self.done.len() == LIMIT {
            self.done.remove(0);
        }
        self.done.push(Step { doc: before, key: key.clone(), label });
        self.undone.clear();
        self.open = key;
    }

    /// Ends the merge window.
    pub fn close(&mut self) {
        self.open = None;
    }

    /// The document to go back to, given the one shown now.
    pub fn undo(&mut self, now: Doc) -> Option<Doc> {
        let step = self.done.pop()?;
        self.undone.push(Step { doc: now, key: step.key, label: step.label });
        self.open = None;
        Some(step.doc)
    }

    pub fn redo(&mut self, now: Doc) -> Option<Doc> {
        let step = self.undone.pop()?;
        self.done.push(Step { doc: now, key: step.key, label: step.label });
        self.open = None;
        Some(step.doc)
    }

    /// The words of the step an undo or a redo would take, given the document shown now, as "Fillet 2".
    pub fn label(&self, undo: bool, now: &Doc) -> Option<String> {
        let step = if undo { self.done.last() } else { self.undone.last() }?;
        Some(step.label.clone().unwrap_or_else(|| {
            let (before, after) = if undo { (&step.doc, now) } else { (now, &step.doc) };
            crate::timeline::labels::step_label(before, after)
        }))
    }

    pub fn can_undo(&self) -> bool {
        !self.done.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.undone.is_empty()
    }
}

#[cfg(test)]
mod tests;
