//! What the History rows hold between frames: the picked rows, the right click menu, the rename or note field, the
//! row being dragged over and the related filter. The edits themselves are in crate::timeline.

use std::cell::Cell;
use std::rc::Rc;

use fundacad_client::Doc;
use gpui::*;
use gpui_kit::component::input::{InputEvent, InputState};

use super::Shell;
use crate::timeline::rows::Rows;
use crate::timeline::{self as steps, deps, labels, ops};

#[derive(Default)]
pub(super) struct Timeline {
    pub rows: Rows,
    pub menu: Option<Menu>,
    pub field: Option<RowField>,
    /// The related filter is on unless turned off, as in FundaCAD 1. It filters only while the viewport has a pick.
    pub related_off: bool,
    /// Which failed step the error chip picks next.
    pub err_cycle: usize,
    pub list: ScrollHandle,
    /// The row the list scrolls to on its next draw.
    pub reveal: Cell<Option<String>>,
    /// The document the rows were drawn from, shared with the drag callbacks.
    pub doc: Rc<Doc>,
}

pub(super) struct Menu {
    pub at: Point<Pixels>,
    pub targets: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum FieldKind {
    Rename,
    Note,
}

pub(super) struct RowField {
    pub id: String,
    pub kind: FieldKind,
    pub input: Entity<InputState>,
    _events: Subscription,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Act {
    Rename,
    ResetName,
    Suppress(bool),
    RollBefore,
    RollHere,
    Note,
    RemoveNote,
    Delete,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Entry {
    /// `act` None draws the item off.
    Item {
        act: Option<Act>,
        label: String,
        keys: &'static str,
        danger: bool,
    },
    Separator,
}

fn item(act: Act, label: impl Into<String>) -> Entry {
    Entry::Item { act: Some(act), label: label.into(), keys: "", danger: false }
}

fn off(label: &str) -> Entry {
    Entry::Item { act: None, label: label.into(), keys: "", danger: false }
}

/// The right click menu over `targets`, as openMenu and openMultiMenu in TimelineBar.vue. Edit and Repick wait for
/// the inspector.
pub(super) fn menu(doc: &Doc, targets: &[String]) -> Vec<Entry> {
    let suppressed = |id: &String| {
        doc.get("suppressed").and_then(|s| s.as_array()).is_some_and(|s| s.iter().any(|v| v.as_str() == Some(id)))
    };
    let delete = |label: String| Entry::Item { act: Some(Act::Delete), label, keys: "Del", danger: true };
    match targets {
        [] => Vec::new(),
        [id] => {
            let named = steps::features(doc).into_iter().find(|f| steps::id_of(f) == id).and_then(labels::own_name);
            let note = ops::note(doc, id);
            let mut out =
                vec![Entry::Item { act: Some(Act::Rename), label: "Rename".into(), keys: "F2", danger: false }];
            if named.is_some() {
                out.push(item(Act::ResetName, "Reset name"));
            }
            let on = suppressed(id);
            out.push(item(Act::Suppress(!on), if on { "Unsuppress" } else { "Suppress" }));
            out.push(item(Act::RollBefore, "Roll back before this"));
            out.push(item(Act::RollHere, "Roll to here"));
            out.push(item(Act::Note, if note.is_some() { "Edit note" } else { "Add note" }));
            if note.is_some() {
                out.push(item(Act::RemoveNote, "Remove note"));
            }
            out.push(Entry::Separator);
            out.push(delete("Delete".into()));
            out
        }
        many => {
            let n = many.len();
            let all_off = many.iter().all(suppressed);
            vec![
                off("Rename (select one feature)"),
                item(Act::Suppress(!all_off), format!("{} these {n}", if all_off { "Unsuppress" } else { "Suppress" })),
                off("Roll back before this (select one feature)"),
                Entry::Separator,
                delete(format!("Delete these {n}")),
            ]
        }
    }
}

/// A click on a row. A plain click on the one open row folds it, as onChipClick does.
pub(super) fn pick(rows: &Rows, order: &[String], id: &str, toggle: bool, range: bool) -> Rows {
    if !toggle && !range && rows.sole() == Some(id) {
        return Rows::default();
    }
    rows.click(order, id, toggle, range)
}

/// The rows drawn: all of them, or what the steps behind the viewport pick relate to while the filter is on. Picked
/// rows never seed it, so picking rows hides none.
pub(super) fn shown(doc: &Doc, seeds: &[String], related_off: bool) -> Vec<String> {
    match related(doc, seeds) {
        Some(near) if !related_off => near,
        _ => steps::ids(doc),
    }
}

/// What the seed steps use and are used by, themselves included, None while no seed is in the document.
pub(super) fn related(doc: &Doc, seeds: &[String]) -> Option<Vec<String>> {
    let seeds = steps::in_order(doc, seeds);
    (!seeds.is_empty()).then(|| deps::related(doc, &seeds))
}

/// What a finished field writes, None when it would change nothing: a rename left as the shown name, or a note left
/// as it was.
pub(super) fn typed_edit(doc: &Doc, kind: FieldKind, id: &str, typed: &str) -> Option<String> {
    let was = match kind {
        FieldKind::Rename => labels::name_of(doc, id),
        FieldKind::Note => ops::note(doc, id).unwrap_or_default(),
    };
    (typed.trim() != was.trim()).then(|| typed.trim().to_owned())
}

impl Shell {
    /// The row ids as drawn, `#i` for the sample document that has none.
    pub(super) fn row_ids(&self) -> Vec<String> {
        if self.source.is_some() {
            steps::ids(&self.timeline.doc)
        } else {
            (0..self.doc.features.len()).map(|i| format!("#{i}")).collect()
        }
    }

    /// The steps that made the faces, bodies and sketch regions picked in the viewport, as TimelineBar.vue seeds the
    /// related filter. The viewport picks nothing yet, so the filter waits for it.
    pub(super) fn related_seeds(&self) -> Vec<String> {
        Vec::new()
    }

    /// Called from sync once the document changed.
    pub(super) fn timeline_synced(&mut self, doc: &Doc) {
        self.timeline.doc = Rc::new(doc.clone());
        let have = steps::ids(doc);
        self.timeline.rows.keep(&have);
        if self.timeline.menu.as_ref().is_some_and(|m| m.targets.iter().any(|id| !have.contains(id))) {
            self.timeline.menu = None;
        }
        if self.timeline.field.as_ref().is_some_and(|f| !have.contains(&f.id)) {
            self.timeline.field = None;
        }
    }

    /// One History edit as an undo step, its refusal said in the status.
    pub(super) fn timeline_edit(
        &mut self,
        key: Option<&str>,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = key.map(str::to_owned);
        self.viewport.update(cx, |v, cx| match v.edit_step(key, None, f, cx) {
            Ok(_) => true,
            Err(why) => {
                v.say(why, cx);
                false
            }
        })
    }

    pub(super) fn click_row(&mut self, id: &str, ev: &ClickEvent, window: &mut Window, cx: &mut Context<Self>) {
        let m = ev.modifiers();
        let order = shown(&self.timeline.doc, &self.related_seeds(), self.timeline.related_off);
        let order = if self.source.is_some() { order } else { self.row_ids() };
        self.timeline.rows = pick(&self.timeline.rows, &order, id, m.control || m.platform, m.shift);
        self.timeline.menu = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub(super) fn open_menu(&mut self, id: &str, at: Point<Pixels>, cx: &mut Context<Self>) {
        if self.source.is_none() || self.timeline.field.is_some() {
            return;
        }
        let targets = steps::in_order(&self.timeline.doc, &self.timeline.rows.act_on(id));
        self.timeline.menu = Some(Menu { at, targets });
        cx.notify();
    }

    pub(super) fn run(&mut self, act: Act, targets: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.timeline.menu = None;
        let doc = self.timeline.doc.clone();
        let Some(first) = targets.first().cloned() else { return };
        let at = steps::ids(&doc).iter().position(|id| *id == first).unwrap_or(0);
        match act {
            Act::Rename => self.open_field(first, FieldKind::Rename, window, cx),
            Act::Note => self.open_field(first, FieldKind::Note, window, cx),
            Act::ResetName => {
                self.timeline_edit(None, move |d| ops::rename(d, &first, ""), cx);
            }
            Act::RemoveNote => {
                self.timeline_edit(None, move |d| ops::set_note(d, &first, ""), cx);
            }
            Act::Suppress(on) => {
                self.timeline_edit(None, move |d| ops::set_suppressed(d, &targets, on), cx);
            }
            Act::RollBefore => self.roll_to(at, cx),
            Act::RollHere => self.roll_to(at + 1, cx),
            Act::Delete => self.delete_rows(targets, cx),
        }
        cx.notify();
    }

    /// Moves the rollback marker, a run of moves being one undo step. The sample document only moves it on screen.
    pub(super) fn roll_to(&mut self, at: usize, cx: &mut Context<Self>) {
        if self.source.is_none() {
            self.doc.set_marker(at);
            cx.notify();
            return;
        }
        self.timeline_edit(
            Some("rollback"),
            move |d| {
                ops::set_rollback(d, at);
                Ok(())
            },
            cx,
        );
    }

    /// Deletes the steps as one undo step. Never refused, as in FundaCAD 1: the status names what used them instead.
    pub(super) fn delete_rows(&mut self, targets: Vec<String>, cx: &mut Context<Self>) {
        let doc = self.timeline.doc.clone();
        let gone = steps::in_order(&doc, &targets);
        if gone.is_empty() {
            return;
        }
        let line = labels::deleted_line(&doc, &gone, &deps::dependents(&doc, &gone));
        let rows = self.timeline.rows.after_delete(&gone);
        if self.timeline_edit(None, move |d| ops::delete(d, &gone), cx) {
            self.timeline.rows = rows;
            self.viewport.update(cx, |v, cx| v.say(line, cx));
        }
    }

    pub(super) fn move_row(&mut self, id: String, to: usize, cx: &mut Context<Self>) {
        if let Err(why) = deps::can_move(&self.timeline.doc, &id, to) {
            self.viewport.update(cx, |v, cx| v.say(why, cx));
            return;
        }
        self.timeline_edit(None, move |d| ops::move_to(d, &id, to), cx);
    }

    fn open_field(&mut self, id: String, kind: FieldKind, window: &mut Window, cx: &mut Context<Self>) {
        let text = match kind {
            FieldKind::Rename => labels::name_of(&self.timeline.doc, &id),
            FieldKind::Note => ops::note(&self.timeline.doc, &id).unwrap_or_default(),
        };
        let placeholder = if kind == FieldKind::Note { "Note" } else { "Name" };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(text));
        let events = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } | InputEvent::Blur => this.close_field(true, window, cx),
            _ => {}
        });
        input.update(cx, |i, cx| {
            i.focus(window, cx);
            i.select_all(window, cx);
        });
        self.timeline.field = Some(RowField { id, kind, input, _events: events });
        cx.notify();
    }

    /// Ends the rename or note field, writing what was typed when `keep`.
    pub(super) fn close_field(&mut self, keep: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(field) = self.timeline.field.take() else { return };
        let typed = field.input.read(cx).value().to_string();
        let edit = typed_edit(&self.timeline.doc, field.kind, &field.id, &typed).filter(|_| keep);
        if let Some(text) = edit {
            let id = field.id.clone();
            match field.kind {
                FieldKind::Rename => self.timeline_edit(None, move |d| ops::rename(d, &id, &text), cx),
                FieldKind::Note => self.timeline_edit(None, move |d| ops::set_note(d, &id, &text), cx),
            };
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// F2, Delete and Escape on the History selection, while no field has the keys.
    pub(super) fn history_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = ev.keystroke.key.as_str();
        if self.timeline.field.is_some() {
            if key == "escape" {
                self.close_field(false, window, cx);
                cx.stop_propagation();
            }
            return;
        }
        if !self.focus.is_focused(window) || self.source.is_none() {
            return;
        }
        match key {
            "escape" if self.timeline.menu.is_some() => self.timeline.menu = None,
            "escape" if !self.timeline.rows.keys.is_empty() => self.timeline.rows = Rows::default(),
            "f2" => match self.timeline.rows.sole().map(str::to_owned) {
                Some(id) => self.open_field(id, FieldKind::Rename, window, cx),
                None => return,
            },
            "delete" if !self.timeline.rows.keys.is_empty() => {
                let picked = self.timeline.rows.keys.clone();
                self.delete_rows(picked, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

#[cfg(test)]
mod tests;
