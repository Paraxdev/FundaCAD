//! A person's own keys over the table, from the settings, and the clashes that leaves.

use serde::{Deserialize, Serialize};

use super::keys::{Combo, Shortcut, RESERVED};

/// The settings key the list is stored under.
pub const SETTING: &str = "keymap";

/// A key a person chose for one row, by the row's id. An empty key unbinds the row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UserKey {
    pub id: String,
    pub key: String,
    /// FundaCAD 1 stored the modifiers beside a bare key, as `{"key": "b", "ctrl": true}`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shift: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ctrl: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Problem {
    /// No row has this id, a row of a newer build or a typo.
    Unknown {
        id: String,
    },
    Unreadable {
        id: String,
        why: String,
    },
    /// The row is one of the fixed ones, or the key is one of theirs.
    Reserved {
        id: String,
        key: String,
        by: &'static str,
    },
    /// Two rows that can be live at once share a key. The first one wins.
    Conflict {
        key: String,
        first: &'static str,
        second: &'static str,
    },
}

impl Problem {
    pub fn describe(&self) -> String {
        match self {
            Problem::Unknown { id } => format!("No shortcut is called {id}"),
            Problem::Unreadable { id, why } => format!("The key for {id} was left out: {why}"),
            Problem::Reserved { key, by, .. } => format!("{key} stays on {by}"),
            Problem::Conflict { key, first, second } => format!("{key} is on both {first} and {second}, {first} wins"),
        }
    }
}

/// The table with the person's keys applied, the rows they changed first so a key they chose wins over the table's
/// own use of it, and every problem found.
pub fn apply(table: Vec<Shortcut>, user: &[UserKey]) -> (Vec<Shortcut>, Vec<Problem>) {
    let mut rows = table;
    let mut mine = Vec::new();
    let mut problems = Vec::new();
    for u in user {
        let Some(at) = rows.iter().position(|r| r.id == u.id) else {
            problems.push(Problem::Unknown { id: u.id.clone() });
            continue;
        };
        if rows[at].fixed {
            let key = rows[at].combo.as_ref().map(Combo::to_string).unwrap_or_default();
            problems.push(Problem::Reserved { id: u.id.clone(), key, by: rows[at].label });
            continue;
        }
        let combo = if u.key.trim().is_empty() {
            None
        } else {
            match Combo::parse(&u.key) {
                Ok(mut c) => {
                    c.shift |= u.shift;
                    c.ctrl |= u.ctrl;
                    Some(c)
                }
                Err(why) => {
                    problems.push(Problem::Unreadable { id: u.id.clone(), why });
                    continue;
                }
            }
        };
        if let Some(c) = &combo {
            if let Some(f) = rows.iter().find(|r| r.fixed && r.combo.as_ref() == Some(c)) {
                problems.push(Problem::Reserved { id: u.id.clone(), key: c.to_string(), by: f.label });
                continue;
            }
            if let Some(&(_, by)) = RESERVED.iter().find(|(k, _)| Combo::parse(k).as_ref() == Ok(c)) {
                problems.push(Problem::Reserved { id: u.id.clone(), key: c.to_string(), by });
                continue;
            }
        }
        rows[at].combo = combo;
        if !mine.contains(&rows[at].id) {
            mine.push(rows[at].id.clone());
        }
    }
    let (mut first, rest): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| mine.contains(&r.id));
    first.extend(rest);
    let clashes = conflicts(&first);
    problems.extend(clashes.into_iter().map(|(a, b)| Problem::Conflict {
        key: first[a].combo.as_ref().map(Combo::to_string).unwrap_or_default(),
        first: first[a].label,
        second: first[b].label,
    }));
    (first, problems)
}

/// Pairs of rows, by index, that share a key while both can be live, the earlier row first.
pub fn conflicts(rows: &[Shortcut]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for (i, a) in rows.iter().enumerate() {
        let Some(ka) = &a.combo else { continue };
        for (j, b) in rows.iter().enumerate().skip(i + 1) {
            if b.combo.as_ref() == Some(ka) && a.action != b.action && a.context.overlaps(b.context) {
                out.push((i, j));
            }
        }
    }
    out
}

#[cfg(test)]
/// The row a key runs in a context, the first match winning as when bound.
pub fn resolve<'a>(rows: &'a [Shortcut], combo: &Combo, sketching: bool) -> Option<&'a Shortcut> {
    let ctx = if sketching { super::keys::Ctx::Sketch } else { super::keys::Ctx::Model };
    rows.iter().find(|r| r.combo.as_ref() == Some(combo) && r.context.overlaps(ctx))
}
