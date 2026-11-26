use fundacad_client::Doc;

const LIMIT: usize = 200;

struct Step {
    /// The document as it was before the step.
    doc: Doc,
    key: Option<String>,
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
    pub fn record(&mut self, before: Doc, key: Option<String>) {
        if key.is_some() && key == self.open && !self.done.is_empty() {
            return;
        }
        if self.done.len() == LIMIT {
            self.done.remove(0);
        }
        self.done.push(Step { doc: before, key: key.clone() });
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
        self.undone.push(Step { doc: now, key: step.key });
        self.open = None;
        Some(step.doc)
    }

    pub fn redo(&mut self, now: Doc) -> Option<Doc> {
        let step = self.undone.pop()?;
        self.done.push(Step { doc: now, key: step.key });
        self.open = None;
        Some(step.doc)
    }

    pub fn can_undo(&self) -> bool {
        !self.done.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.undone.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(v: i64) -> Doc {
        json!({ "v": v }).as_object().unwrap().clone()
    }

    #[test]
    fn ten_drags_of_one_face_undo_as_one_step() {
        let mut u = UndoStack::default();
        for v in 0..10 {
            u.record(doc(v), Some("e1 distance".into()));
        }
        assert_eq!(u.undo(doc(10)), Some(doc(0)));
        assert!(!u.can_undo());
        assert_eq!(u.redo(doc(0)), Some(doc(10)));
    }

    #[test]
    fn another_key_or_a_close_starts_a_new_step() {
        let mut u = UndoStack::default();
        u.record(doc(0), Some("a".into()));
        u.record(doc(1), Some("b".into()));
        u.close();
        u.record(doc(2), Some("b".into()));
        u.record(doc(3), None);
        u.record(doc(4), None);
        let mut back = Vec::new();
        let mut now = doc(5);
        while let Some(d) = u.undo(now.clone()) {
            back.push(d["v"].as_i64().unwrap());
            now = d;
        }
        assert_eq!(back, [4, 3, 2, 1, 0]);
    }

    #[test]
    fn a_new_step_drops_the_redo_and_an_undo_ends_the_merge() {
        let mut u = UndoStack::default();
        u.record(doc(0), Some("a".into()));
        assert_eq!(u.undo(doc(1)), Some(doc(0)));
        u.record(doc(0), Some("a".into()));
        assert!(!u.can_redo());
        assert!(u.can_undo());
        assert_eq!(u.undo(doc(2)), Some(doc(0)));
        u.record(doc(0), Some("a".into()));
        u.record(doc(2), Some("a".into()));
        assert_eq!(u.undo(doc(3)), Some(doc(0)), "the second drag merged into the first after the undo");
    }
}
