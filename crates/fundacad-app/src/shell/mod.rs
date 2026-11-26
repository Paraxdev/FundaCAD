//! The workspace: a 36px title bar over the stage, where the 3D view runs full bleed and every panel floats over it.

mod geometry;
mod history;
mod items;
mod rail;
mod titlebar;

use std::collections::HashMap;

use fundacad_client::Doc;
use gpui::*;
use gpui_kit::component::input::{InputEvent, InputState};

use crate::document::{self, Document, Target};
use crate::theme::{self, ActiveTheme as _, FLOAT_GAP, FS_SMALL, S_1, S_3, UI_FONT};
use crate::ui::{chip, frost_flush, text};
use crate::viewport::Viewport;

/// A History value being typed, keyed by its `Target::key`.
struct Field {
    input: Entity<InputState>,
    _events: Subscription,
}

pub struct Shell {
    viewport: Entity<Viewport>,
    doc: Document,
    /// The document `doc` was read from, to tell a real change from the viewport redrawing.
    source: Option<Doc>,
    /// The transport moved the marker, so it is the shell's until the document says otherwise.
    marker_moved: bool,
    fields: HashMap<String, Field>,
    items_tab: usize,
    items: items::ItemsState,
    /// The History step whose values show under it.
    open: Option<usize>,
    focus: FocusHandle,
    _system: Subscription,
}

impl Shell {
    pub fn new(viewport: Entity<Viewport>, doc: Document, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe_in(&viewport, window, |this, _, window, cx| {
            this.sync(window, cx);
            cx.notify();
        })
        .detach();
        let mut shell = Self {
            viewport,
            doc,
            source: None,
            marker_moved: false,
            fields: HashMap::new(),
            items_tab: 0,
            items: items::ItemsState::new(cx),
            open: None,
            focus: cx.focus_handle(),
            _system: theme::follow_system(window, cx),
        };
        shell.sync(window, cx);
        shell
    }

    /// Reads the shown document again when the viewport's has changed.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let viewport = self.viewport.read(cx);
        let Some(doc) = viewport.doc() else { return };
        if self.source.as_ref() == Some(doc) {
            return;
        }
        let mut next = Document::from_funda(self.doc.name.clone(), doc);
        self.source = Some(doc.clone());
        if self.marker_moved {
            next.set_marker(self.doc.marker);
        }
        self.doc = next;
        let texts: HashMap<String, String> = self.texts();
        let stale: Vec<String> = self.fields.keys().filter(|k| !texts.contains_key(*k)).cloned().collect();
        for key in stale {
            self.fields.remove(&key);
        }
        for (key, text) in texts {
            let Some(field) = self.fields.get(&key) else { continue };
            let focused = field.input.focus_handle(cx).is_focused(window);
            if !focused && field.input.read(cx).value() != text {
                field.input.update(cx, |i, cx| i.set_value(text, window, cx));
            }
        }
    }

    fn ensure_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(open) = self.open_step() else { return };
        let wanted: Vec<(String, String)> = self.doc.features[open]
            .params
            .iter()
            .filter_map(|p| Some((p.target.as_ref()?.key(), history::format_value(p.value))))
            .collect();
        for (key, text) in wanted {
            self.field(&key, &text, window, cx);
        }
    }

    /// The text each editable value shows, by `Target::key`.
    fn texts(&self) -> HashMap<String, String> {
        let params = self.doc.features.iter().flat_map(|f| &f.params);
        params.filter_map(|p| Some((p.target.as_ref()?.key(), history::format_value(p.value)))).collect()
    }

    /// The input of an editable value, made on first use.
    fn field(&mut self, key: &str, text: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(f) = self.fields.get(key) {
            return f.input.clone();
        }
        let input = cx.new(|cx| InputState::new(window, cx).default_value(text.to_string()));
        let owner = key.to_string();
        let events = cx.subscribe_in(&input, window, move |this, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                this.commit(&owner, window, cx);
            }
        });
        self.fields.insert(key.to_string(), Field { input: input.clone(), _events: events });
        input
    }

    /// Applies what was typed, or puts the value back when it is not a number.
    fn commit(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(field) = self.fields.get(key) else { return };
        let typed = field.input.read(cx).value();
        let current = self
            .doc
            .features
            .iter()
            .flat_map(|f| &f.params)
            .find(|p| p.target.as_ref().is_some_and(|t| t.key() == key));
        if let (Some(value), Some(param)) = (document::parse_value(&typed), current) {
            if value != param.value {
                if let Some(target) = param.target.clone() {
                    self.edit(target, value, cx);
                }
            }
        }
        self.sync(window, cx);
        let text = self.texts().remove(key).unwrap_or_default();
        if let Some(field) = self.fields.get(key) {
            field.input.update(cx, |i, cx| i.set_value(text, window, cx));
        }
    }

    fn edit(&mut self, target: Target, value: f64, cx: &mut Context<Self>) {
        let edited = self.viewport.update(cx, |v, cx| v.edit(move |d| document::apply(d, &target, value), cx));
        if let Err(why) = edited {
            log::info!("the edit was not applied: {why}");
        }
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let t = &t;
        let gap = px(FLOAT_GAP);
        self.ensure_fields(window, cx);
        self.viewport.update(cx, |v, cx| v.set_background(t.viewport_bg.bytes(), cx));

        let left = div()
            .absolute()
            .top(gap)
            .bottom(gap)
            .left(gap)
            .flex()
            .gap(gap)
            .child(self.items_card(t, window, cx))
            .child(rail::rail(t));
        let right = div()
            .absolute()
            .top(gap)
            .bottom(gap)
            .right(gap)
            .flex()
            .items_start()
            .gap(gap)
            .child(self.view_controls(t))
            .child(self.history_card(t, window, cx));
        let status = self.viewport.read(cx).status();
        let status = div().absolute().left_0().right_0().bottom(gap).flex().justify_center().child(
            chip(t)
                .max_w(px(560.))
                .px(px(S_3))
                .py(px(S_1))
                .child(text(t, FS_SMALL).min_w_0().truncate().text_color(t.text_dim).child(status)),
        );

        // Actions go only to the window root while nothing has focus, so the shell takes it.
        if window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        let viewport = self.viewport.clone();
        let redo = self.viewport.clone();
        div()
            .size_full()
            .track_focus(&self.focus)
            .on_action(move |_: &crate::viewport::Undo, _, cx| viewport.update(cx, |v, cx| v.undo(cx)))
            .on_action(move |_: &crate::viewport::Redo, _, cx| redo.update(cx, |v, cx| v.redo(cx)))
            .flex()
            .flex_col()
            .font_family(UI_FONT)
            .bg(t.bg)
            .text_color(t.text)
            .child(self.titlebar(t))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .bg(t.viewport_bg)
                    .child(div().absolute().size_full().child(self.viewport.clone()))
                    .child(left)
                    .child(right)
                    .child(status),
            )
            .child(frost_flush(self.viewport.clone()))
    }
}

#[cfg(test)]
mod tests {
    use gpui::AssetSource as _;

    use crate::assets::Assets;
    use crate::document::Document;

    /// Every name the shell draws, the rail's and the sample document's included.
    #[test]
    fn every_glyph_is_in_the_icon_pack() {
        let fixed = [
            "caretDown",
            "caretRight",
            "close",
            "error",
            "warning",
            "home",
            "undo",
            "redo",
            "primitive",
            "sync",
            "visible",
            "hidden",
            "more",
            "skipStart",
            "stepBack",
            "stepForward",
            "skipEnd",
            "magnet",
            "views",
            "view-reset",
            "view-matcap",
            "view-realtime",
            "view-pathtraced",
            "shaded",
            "camera",
            "versions",
            "history",
            "bug",
        ];
        let doc = Document::sample();
        let from_doc = doc
            .features
            .iter()
            .map(|f| f.glyph)
            .chain(doc.groups.iter().flat_map(|g| std::iter::once(g.glyph).chain(g.items.iter().map(|i| i.glyph))));
        let missing: Vec<_> = fixed
            .into_iter()
            .chain(from_doc)
            .chain(super::rail::glyphs())
            .filter(|g| Assets.load(&crate::ui::icon_path(g)).ok().flatten().is_none())
            .collect();
        assert!(missing.is_empty(), "missing icons: {missing:?}");
    }
}
