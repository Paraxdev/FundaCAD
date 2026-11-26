//! File manager style row selection, as src/ui/rowSelection.ts: click, Ctrl to toggle, Shift for a run from the
//! anchor, Ctrl+Shift to add a run.

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rows {
    pub keys: Vec<String>,
    pub anchor: Option<String>,
}

impl Rows {
    /// `order` is the rows as drawn. A Shift-click with no usable anchor takes just this row and anchors it, and
    /// never moves the anchor, so a run can grow or shrink.
    pub fn click(&self, order: &[String], key: &str, toggle: bool, range: bool) -> Rows {
        let one = || Rows { keys: vec![key.to_owned()], anchor: Some(key.to_owned()) };
        if range {
            let from = self.anchor.as_ref().and_then(|a| order.iter().position(|k| k == a));
            let to = order.iter().position(|k| k == key);
            let (Some(from), Some(to)) = (from, to) else { return one() };
            let run = &order[from.min(to)..=from.max(to)];
            let mut keys = if toggle { self.keys.clone() } else { Vec::new() };
            keys.extend(run.iter().filter(|k| !self.keys.contains(k) || !toggle).cloned());
            return Rows { keys, anchor: self.anchor.clone() };
        }
        if toggle {
            let mut keys = self.keys.clone();
            match keys.iter().position(|k| k == key) {
                Some(at) => {
                    keys.remove(at);
                }
                None => keys.push(key.to_owned()),
            }
            return Rows { keys, anchor: Some(key.to_owned()) };
        }
        one()
    }

    /// The rows an action on `key` covers: the whole selection when it holds `key`, else just that row.
    pub fn act_on(&self, key: &str) -> Vec<String> {
        if self.keys.iter().any(|k| k == key) {
            self.keys.clone()
        } else {
            vec![key.to_owned()]
        }
    }

    /// Drops the rows the document no longer has, after an undo or a delete.
    pub fn keep(&mut self, have: &[String]) {
        self.keys.retain(|k| have.contains(k));
        if self.anchor.as_ref().is_some_and(|a| !have.contains(a)) {
            self.anchor = None;
        }
    }

    /// The one picked row, None for none or several.
    pub fn sole(&self) -> Option<&str> {
        match &self.keys[..] {
            [one] => Some(one),
            _ => None,
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.keys.iter().any(|k| k == key)
    }
}

#[cfg(test)]
mod tests;
