//! The workspace: a 36px title bar over the stage, where the 3D view runs full bleed and every panel floats over it.

mod geometry;
mod history;
mod history_menu;
mod inspector;
mod items;
mod modal;
mod params;
mod rail;
mod timeline;
mod titlebar;
mod transfer;

use std::collections::HashMap;

use fundacad_client::Doc;
use gpui::*;
use gpui_kit::component::input::{InputEvent, InputState};

use crate::document::{self, Document, Target};
use crate::theme::{self, ActiveTheme as _, FLOAT_GAP, FS_SMALL, S_1, S_3, UI_FONT};
use crate::ui::{chip, frost_flush, text};
use crate::viewport::Viewport;
pub use params::OpenParameters;

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
    /// The viewport's count of documents opened when `doc` was read, so a new one starts with the marker at its end.
    opened: u64,
    fields: HashMap<String, Field>,
    inspector: inspector::Ui,
    items_tab: usize,
    items: items::ItemsState,
    timeline: timeline::Timeline,
    focus: FocusHandle,
    bench: crate::workbench::Bench,
    params: Entity<params::ParamsPanel>,
    transfer: transfer::Transfer,
    _system: Subscription,
}

impl Shell {
    pub fn new(viewport: Entity<Viewport>, doc: Document, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe_in(&viewport, window, |this, _, window, cx| {
            this.sync(window, cx);
            cx.notify();
        })
        .detach();
        let bench = crate::workbench::Bench::new(&viewport, window, cx);
        cx.observe(&bench.overlay, |_, _, cx| cx.notify()).detach();
        cx.observe(&bench.files, |_, _, cx| cx.notify()).detach();
        let params = cx.new(|cx| params::ParamsPanel::new(viewport.clone(), window, cx));
        transfer::install(cx.weak_entity(), cx);
        let p = params.clone();
        crate::commands::register(cx, "parameters", "Parameters", crate::commands::Group::Tools, move |_, cx| {
            p.update(cx, |p, cx| p.toggle(cx))
        });
        let mut shell = Self {
            viewport,
            doc,
            source: None,
            opened: 0,
            fields: HashMap::new(),
            inspector: Default::default(),
            items_tab: 0,
            items: items::ItemsState::new(cx),
            timeline: timeline::Timeline::default(),
            focus: cx.focus_handle(),
            bench,
            params,
            transfer: transfer::Transfer::new(cx),
            _system: theme::follow_system(window, cx),
        };
        shell.sync(window, cx);
        shell
    }

    /// Reads the shown document again when the viewport's has changed.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let opened = self.viewport.read(cx).opened();
        if opened != self.opened {
            self.opened = opened;
            self.timeline.rows = Default::default();
            cx.defer_in(window, |this, window, cx| this.check_links(true, window, cx));
        }
        let viewport = self.viewport.read(cx);
        // An STL has no steps, so History empties instead of keeping the last document's.
        let empty = Doc::new();
        let doc = viewport.doc().unwrap_or(&empty);
        if self.source.as_ref() == Some(doc) {
            return;
        }
        self.doc = Document::from_funda(self.doc.name.clone(), doc);
        self.source = Some(doc.clone());
        self.timeline_synced(doc);
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
        self.ensure_inspector_fields(window, cx);
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
        if self.inspector_commit(key, window, cx) {
            return;
        }
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
        let params = self.params.clone();
        let files = self.bench.files.read(cx);
        (self.doc.name, self.doc.dirty) = (files.name(), files.dirty());
        div()
            .size_full()
            .track_focus(&self.focus)
            .key_context(crate::commands::key_context(cx))
            .on_action(crate::commands::on_run)
            .on_action(move |_: &OpenParameters, _, cx| params.update(cx, |p, cx| p.toggle(cx)))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| this.history_key(ev, window, cx)))
            .flex()
            .flex_col()
            .font_family(UI_FONT)
            .bg(t.bg)
            .text_color(t.text)
            .child(self.titlebar(t, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .bg(t.viewport_bg)
                    .child(div().absolute().size_full().child(self.viewport.clone()))
                    .child(left)
                    .child(right)
                    .child(status)
                    .child(self.params.clone()),
            )
            .children(self.history_menu(t, cx))
            .children(self.transfer_modal(t, cx))
            .child(frost_flush(self.viewport.clone()))
            .child(crate::files::drop::hint(t))
            .child(self.bench.overlay.clone())
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
            "pen",
            "text",
            "import",
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
        let from_doc = doc.features.iter().map(|f| f.glyph);
        let missing: Vec<_> = fixed
            .into_iter()
            .chain(from_doc)
            .chain(super::rail::glyphs())
            .filter(|g| Assets.load(&crate::ui::icon_path(g)).ok().flatten().is_none())
            .collect();
        assert!(missing.is_empty(), "missing icons: {missing:?}");
    }
}
