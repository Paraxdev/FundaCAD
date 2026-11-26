//! What the Parameters panel keeps beside its fields: refusals, live values and the edit each commit makes.

use std::collections::HashMap;

use fundacad_client::Doc;
use fundacad_core::params::edit;

use super::rows::Rows;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Col {
    Name,
    Expr,
    Comment,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    Row(String, Col),
    NewName,
    NewExpr,
    /// The Add button, which carries a refused add.
    Add,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Rename { from: String, to: String },
    Expr { name: String, expr: String },
    Comment { name: String, comment: String },
    Add { name: String, expr: String, unit: &'static str },
    Delete(String),
}

impl Change {
    pub fn apply(&self, doc: &mut Doc) -> Result<(), String> {
        match self {
            Self::Rename { from, to } => edit::rename_param(doc, from, to).map(drop),
            Self::Expr { name, expr } => edit::set_param_expr(doc, name, expr).map(drop),
            Self::Comment { name, comment } => edit::set_param_comment(doc, name, comment),
            Self::Add { name, expr, unit } => edit::add_param(doc, name, expr, unit).map(drop),
            Self::Delete(name) => edit::delete_param(doc, name).map(drop),
        }
    }
}

/// The text each row field shows when nothing is typed in it.
pub fn texts(rows: &Rows) -> HashMap<Key, String> {
    let mut out = HashMap::new();
    for r in rows.user.iter().chain(&rows.model) {
        out.insert(Key::Row(r.name.clone(), Col::Name), r.name.clone());
        out.insert(Key::Row(r.name.clone(), Col::Expr), r.expr.clone());
        if r.drives.is_none() {
            out.insert(Key::Row(r.name.clone(), Col::Comment), r.comment.clone());
        }
    }
    out
}

#[derive(Debug, Default, PartialEq)]
pub struct Notes {
    /// Why a typed text was refused or will not evaluate, kept until it is fixed.
    pub problems: HashMap<Key, String>,
    /// What an expression being typed evaluates to.
    pub preview: HashMap<Key, f64>,
    /// A refused delete, by parameter.
    pub refused: HashMap<String, String>,
}

impl Notes {
    /// Evaluates a field as it is typed.
    pub fn check(&mut self, doc: Option<&Doc>, rows: &Rows, key: &Key, typed: &str) {
        let name = match key {
            Key::Row(name, Col::Expr) => Some(name.as_str()),
            Key::NewExpr => None,
            Key::NewName => {
                self.problems.remove(&Key::Add);
                return;
            }
            _ => return,
        };
        if *key == Key::NewExpr {
            self.problems.remove(&Key::Add);
        }
        let unchanged = name.and_then(|n| rows.find(n)).is_some_and(|r| r.expr == typed);
        self.preview.remove(key);
        self.problems.remove(key);
        match doc {
            Some(doc) if !typed.is_empty() && !unchanged => match edit::check_expr(doc, name, typed) {
                Ok(v) => {
                    self.preview.insert(key.clone(), v);
                }
                Err(why) => {
                    self.problems.insert(key.clone(), why);
                }
            },
            _ => {}
        }
    }

    /// The change committing `typed` into a row field makes, None when the row already holds it.
    pub fn commit(&mut self, rows: &Rows, key: &Key, typed: &str) -> Option<Change> {
        let Key::Row(name, col) = key else { return None };
        let row = rows.find(name)?;
        self.preview.remove(key);
        let current = match col {
            Col::Name => &row.name,
            Col::Expr => &row.expr,
            Col::Comment => &row.comment,
        };
        if typed == current {
            self.problems.remove(key);
            return None;
        }
        let (name, typed) = (name.clone(), typed.to_owned());
        Some(match col {
            Col::Name => Change::Rename { from: name, to: typed },
            Col::Expr => Change::Expr { name, expr: typed },
            Col::Comment => Change::Comment { name, comment: typed },
        })
    }

    /// Keeps the refusal of a change where the user sees it, or clears it once the change went through.
    pub fn settle(&mut self, change: &Change, result: Result<(), String>) {
        let key = match change {
            Change::Rename { from, .. } => Key::Row(from.clone(), Col::Name),
            Change::Expr { name, .. } => Key::Row(name.clone(), Col::Expr),
            Change::Comment { name, .. } => Key::Row(name.clone(), Col::Comment),
            Change::Add { .. } => Key::Add,
            Change::Delete(name) => {
                match result {
                    Ok(()) => self.refused.remove(name),
                    Err(why) => self.refused.insert(name.clone(), why),
                };
                return;
            }
        };
        match result {
            Ok(()) => {
                if key == Key::Add {
                    for k in [Key::NewName, Key::NewExpr] {
                        self.problems.remove(&k);
                        self.preview.remove(&k);
                    }
                }
                self.problems.remove(&key);
            }
            Err(why) => {
                self.problems.insert(key, why);
            }
        }
    }

    /// Drops what belongs to rows that are gone.
    pub fn retain(&mut self, rows: &Rows) {
        let texts = texts(rows);
        let kept = |k: &Key| !matches!(k, Key::Row(..)) || texts.contains_key(k);
        self.problems.retain(|k, _| kept(k));
        self.preview.retain(|k, _| kept(k));
        self.refused.retain(|n, _| rows.find(n).is_some());
    }

    /// Whether a field shows the stored text again: not while it is typed in or holds a refused text.
    pub fn resets(&self, key: &Key, focused: bool, shown: &str, stored: &str) -> bool {
        !focused && !self.problems.contains_key(key) && shown != stored
    }
}

#[cfg(test)]
mod tests;
