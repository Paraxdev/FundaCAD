//! The Parameters panel, ParamsDialog.vue: user and model parameters with their expressions, values and what they
//! drive. Every change is one edit of the viewport's document, so one undo step, and the model rebuilds.

pub(super) mod place;
mod rows;
mod state;

use std::collections::HashMap;

use fundacad_client::Doc;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputEvent, InputState};

use crate::i18n;
use crate::motion::{glass_in, hover_bg, row_bg, Leave};
use crate::theme::{ActiveTheme as _, Theme, FLOAT_GAP, FS_BODY, FS_MICRO, FS_SMALL, R_MD, S_1, S_2, S_3, S_4, T_FAST, W_SEMIBOLD};
use crate::ui::{icon_button, solid_card, text};
use crate::viewport::Viewport;
use rows::{value_text, Row, Rows};
use state::{Change, Col, Key, Notes};

actions!(params, [OpenParameters]);

const HINT: &str = "params.hint";
const UNITS: [(&str, &str); 3] = [("mm", "mm"), ("deg", "deg"), ("count", "params.unitless")];
const NAME_W: f32 = 110.;
const VALUE_W: f32 = 90.;
const DEL_W: f32 = 24.;
const FIELD_H: f32 = 28.;
/// The rows' fixed columns, their gaps and some of each field, the body scrolls sideways in a narrower panel.
const ROW_MIN: f32 = NAME_W + VALUE_W + DEL_W + 4. * S_3 + 2. * 48.;

struct Field {
    input: Entity<InputState>,
    _events: Subscription,
}

pub struct ParamsPanel {
    viewport: Entity<Viewport>,
    open: bool,
    leave: Leave,
    /// The document `rows` were read from.
    source: Option<Doc>,
    rows: Rows,
    fields: HashMap<Key, Field>,
    notes: Notes,
    unit: &'static str,
    _observe: Subscription,
    _escape: Subscription,
}

impl ParamsPanel {
    pub fn new(viewport: Entity<Viewport>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe_in(&viewport, window, |this, _, window, cx| {
            if this.open && this.refresh(window, cx) {
                cx.notify();
            }
        });
        // Before dispatch and without stopping it, as FundaCAD 1's panels did: Esc closes whatever has focus.
        let panel = cx.entity().downgrade();
        let escape = cx.intercept_keystrokes(move |e, _, cx| {
            if e.keystroke.key == "escape" && !e.keystroke.modifiers.modified() {
                let _ = panel.update(cx, |p, cx| {
                    if p.open {
                        p.toggle(cx);
                    }
                });
            }
        });
        Self {
            viewport,
            // FUNDA_PANEL=params opens it at start, for captures.
            open: std::env::var("FUNDA_PANEL").is_ok_and(|p| p == "params"),
            leave: Leave::default(),
            source: None,
            rows: Rows::default(),
            fields: HashMap::new(),
            notes: Notes::default(),
            unit: "mm",
            _observe: observe,
            _escape: escape,
        }
    }

    pub fn toggle(&mut self, cx: &mut Context<Self>) {
        self.open = !self.open;
        if self.open {
            self.leave.cancel();
        } else {
            self.leave.start(cx);
        }
        cx.notify();
    }

    /// Reads the rows again when the document changed, true when it did.
    fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let viewport = self.viewport.read(cx);
        let Some(doc) = viewport.doc() else { return false };
        if self.source.as_ref() == Some(doc) {
            return false;
        }
        let doc = doc.clone();
        self.rows = rows::rows(&doc);
        self.source = Some(doc);
        let texts = state::texts(&self.rows);
        self.fields.retain(|k, _| !matches!(k, Key::Row(..)) || texts.contains_key(k));
        self.notes.retain(&self.rows);
        for (key, text) in texts {
            let Some(field) = self.fields.get(&key) else { continue };
            let focused = field.input.focus_handle(cx).is_focused(window);
            let shown = field.input.read(cx).value().to_string();
            if self.notes.resets(&key, focused, &shown, &text) {
                field.input.update(cx, |i, cx| i.set_value(text, window, cx));
            }
        }
        true
    }

    fn ensure_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for (key, text) in state::texts(&self.rows) {
            self.field(key, &text, window, cx);
        }
        self.field(Key::NewName, "", window, cx);
        self.field(Key::NewExpr, "", window, cx);
    }

    fn field(&mut self, key: Key, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.fields.contains_key(&key) {
            return;
        }
        let placeholder = match key {
            Key::NewName => "name",
            Key::NewExpr => "expression",
            _ => "",
        };
        let input = cx.new(|cx| InputState::new(window, cx).default_value(text.to_string()).placeholder(placeholder));
        let owner = key.clone();
        let events = cx.subscribe_in(&input, window, move |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => this.commit(&owner, window, cx),
            InputEvent::Blur if matches!(owner, Key::Row(..)) => this.commit(&owner, window, cx),
            InputEvent::Change => {
                let typed = this.typed(&owner, cx);
                let doc = this.viewport.read(cx).doc();
                this.notes.check(doc, &this.rows, &owner, &typed);
                cx.notify();
            }
            _ => {}
        });
        self.fields.insert(key, Field { input, _events: events });
    }

    fn typed(&self, key: &Key, cx: &App) -> String {
        self.fields.get(key).map(|f| f.input.read(cx).value().trim().to_string()).unwrap_or_default()
    }

    fn commit(&mut self, key: &Key, window: &mut Window, cx: &mut Context<Self>) {
        if !matches!(key, Key::Row(..)) {
            self.add(window, cx);
            return;
        }
        let typed = self.typed(key, cx);
        match self.notes.commit(&self.rows, key, &typed) {
            Some(change) => self.run(change, window, cx),
            None => cx.notify(),
        }
    }

    fn add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (name, expr) = (self.typed(&Key::NewName, cx), self.typed(&Key::NewExpr, cx));
        if name.is_empty() || expr.is_empty() {
            return;
        }
        self.run(Change::Add { name, expr, unit: self.unit }, window, cx);
    }

    fn delete(&mut self, name: String, window: &mut Window, cx: &mut Context<Self>) {
        self.run(Change::Delete(name), window, cx);
    }

    fn run(&mut self, change: Change, window: &mut Window, cx: &mut Context<Self>) {
        let edit = change.clone();
        let result = self.viewport.update(cx, |v, cx| v.edit(move |d| edit.apply(d), cx)).map(drop);
        let added = matches!(change, Change::Add { .. }) && result.is_ok();
        self.notes.settle(&change, result);
        if added {
            for key in [Key::NewName, Key::NewExpr] {
                if let Some(f) = self.fields.get(&key) {
                    f.input.update(cx, |i, cx| i.set_value("", window, cx));
                }
            }
        }
        self.refresh(window, cx);
        cx.notify();
    }
}

fn caption(t: &Theme, label: &str) -> Div {
    text(t, FS_MICRO).text_color(t.text_dim).child(label.to_uppercase())
}

fn head_row(t: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(S_3))
        .mb(px(S_2))
        .child(caption(t, &i18n::t("params.column.name")).w(px(NAME_W)).flex_none())
        .child(caption(t, &i18n::t("params.column.expression")).flex_1().min_w_0().truncate())
        .child(caption(t, &i18n::t("params.column.value")).w(px(VALUE_W)).flex_none())
        .child(caption(t, &i18n::t("params.column.comment")).flex_1().min_w_0().truncate())
        .child(div().w(px(DEL_W)).flex_none())
}

fn section(t: &Theme, label: &str) -> Div {
    text(t, FS_MICRO).font_weight(W_SEMIBOLD).text_color(t.text_dim).mt(px(S_4)).mb(px(S_1)).child(label.to_uppercase())
}

impl ParamsPanel {
    fn input(&self, t: &Theme, key: &Key, stale: bool, window: &Window, cx: &App) -> Div {
        let field = self.fields.get(key);
        let focused = field.is_some_and(|f| f.input.focus_handle(cx).is_focused(window));
        let edge = if self.notes.problems.contains_key(key) {
            t.error
        } else if focused {
            t.accent
        } else {
            t.control_edge
        };
        let colour = if stale { t.warn } else { t.text };
        div()
            .h(px(FIELD_H))
            .min_w_0()
            .px(px(S_2))
            .flex()
            .items_center()
            .rounded(px(R_MD))
            .bg(t.field_bg)
            .border_1()
            .border_color(edge)
            .when_some(field, |d, f| {
                d.child(
                    Input::new(&f.input)
                        .appearance(false)
                        .bordered(false)
                        .focus_bordered(false)
                        .text_size(px(FS_SMALL))
                        .text_color(colour)
                        .p_0(),
                )
            })
    }

    /// The value cell: what a typed expression comes to, else the stored value.
    fn value(&self, t: &Theme, r: &Row) -> Div {
        let cell = text(t, FS_SMALL).w(px(VALUE_W)).flex_none().truncate();
        match self.notes.preview.get(&Key::Row(r.name.clone(), Col::Expr)) {
            Some(v) => cell.text_color(t.accent_hot).child(value_text(*v, &r.unit)),
            None => cell.text_color(if r.issue.is_some() { t.warn } else { t.text_dim }).child(r.value.clone()),
        }
    }

    /// A refusal or a stale value, under its row.
    fn note(&self, t: &Theme, r: &Row) -> Option<Div> {
        let typed = [Col::Name, Col::Expr, Col::Comment]
            .into_iter()
            .find_map(|c| self.notes.problems.get(&Key::Row(r.name.clone(), c)))
            .or_else(|| self.notes.refused.get(&r.name));
        let (line, colour) = match (typed, &r.issue) {
            (Some(why), _) => (why.clone(), t.error),
            (None, Some(issue)) => (issue.clone(), t.warn),
            (None, None) => return None,
        };
        Some(text(t, FS_MICRO).text_color(colour).pl(px(NAME_W + S_3)).mt(px(-S_1)).mb(px(S_2)).child(line))
    }

    fn row(&self, t: &Theme, r: &Row, window: &Window, cx: &mut Context<Self>) -> Div {
        let stale = r.issue.is_some();
        let key = |c| Key::Row(r.name.clone(), c);
        let last = match &r.drives {
            // The comment input's padding and border, so both sections' columns line up.
            Some(drives) => text(t, FS_SMALL)
                .flex_1()
                .min_w_0()
                .px(px(S_2))
                .border_1()
                .border_color(transparent_black())
                .truncate()
                .text_color(t.text_dim)
                .child(drives.clone()),
            None => self.input(t, &key(Col::Comment), false, window, cx).flex_1(),
        };
        let del = match r.drives {
            Some(_) => div().w(px(DEL_W)).flex_none(),
            None => {
                let refused = self.notes.refused.contains_key(&r.name);
                let name = r.name.clone();
                div().w(px(DEL_W)).flex_none().child(
                    icon_button(t, SharedString::from(format!("delete-{}", r.name)), "close", DEL_W, 12., {
                        if refused {
                            t.error
                        } else {
                            t.text_mute
                        }
                    })
                    .on_click(cx.listener(move |this, _, window, cx| this.delete(name.clone(), window, cx))),
                )
            }
        };
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(S_3))
                    .mb(px(S_2))
                    .child(self.input(t, &key(Col::Name), stale, window, cx).w(px(NAME_W)).flex_none())
                    .child(self.input(t, &key(Col::Expr), stale, window, cx).flex_1())
                    .child(self.value(t, r))
                    .child(last)
                    .child(del),
            )
            .children(self.note(t, r))
    }

    fn add_row(&self, t: &Theme, window: &Window, cx: &mut Context<Self>) -> Div {
        let units = div().flex().flex_none().gap(px(2.)).p(px(2.)).rounded(px(R_MD)).bg(t.field_bg).children(
            UNITS.map(|(unit, label)| {
                let on = self.unit == unit;
                let el = text(t, FS_MICRO)
                    .id(unit)
                    .px(px(S_2))
                    .h(px(FIELD_H - 6.))
                    .flex()
                    .items_center()
                    .rounded(px(R_MD - 1.))
                    .text_color(if on { t.text } else { t.text_dim })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.unit = unit;
                        cx.notify();
                    }))
                    .child(i18n::t(label));
                row_bg(SharedString::from(format!("unit-bg-{unit}")), el, on, t.hover_wash, t.raised)
            }),
        );
        let refused = self.notes.problems.contains_key(&Key::Add);
        let (fill, hot, ink) = if refused { (t.error, t.error, t.on_accent) } else { (t.raised, t.raised_2, t.text) };
        let add = text(t, FS_SMALL)
            .id("params-add-el")
            .h(px(FIELD_H))
            .px(px(S_3))
            .flex()
            .flex_none()
            .items_center()
            .rounded(px(R_MD))
            .text_color(ink)
            .on_click(cx.listener(|this, _, window, cx| this.add(window, cx)))
            .child(i18n::t("params.add"));
        let add = hover_bg("params-add", add, fill, hot);
        let preview = self.notes.preview.get(&Key::NewExpr).map(|v| {
            text(t, FS_SMALL).flex_none().text_color(t.accent_hot).child(value_text(*v, self.unit))
        });
        let note = self.notes.problems.get(&Key::Add).or_else(|| self.notes.problems.get(&Key::NewExpr));
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(S_3))
                    .mt(px(S_2))
                    .child(self.input(t, &Key::NewName, false, window, cx).w(px(NAME_W)).flex_none())
                    .child(self.input(t, &Key::NewExpr, false, window, cx).flex_1())
                    .children(preview)
                    .child(units)
                    .child(add),
            )
            .when_some(note, |d, why| {
                d.child(text(t, FS_MICRO).text_color(t.error).pl(px(NAME_W + S_3)).mt(px(S_1)).child(why.clone()))
            })
    }
}

impl Render for ParamsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let fade = if self.open { Some(1.) } else { self.leave.opacity(T_FAST, window, cx) };
        let Some(fade) = fade else { return div().into_any_element() };
        self.refresh(window, cx);
        self.ensure_fields(window, cx);
        let size = window.viewport_size();
        let window_w = size.width / px(1.);
        let card = if super::inspect::shown(self.viewport.read(cx)) { place::card_w(window_w) } else { 0. };
        let (left, top, width) = place::place(window_w, card, place::card_h());
        let room = size.height - px(super::titlebar::HEIGHT + top + FLOAT_GAP) - super::status::reach();
        let t = cx.theme().clone();
        let t = &t;
        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).text_color(t.accent_hot).child(i18n::t("tool.parameters")))
            .child(
                icon_button(t, "params-close", "close", 28., 14., t.text_mute)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle(cx))),
            );
        let mut body = div()
            .flex()
            .flex_col()
            .flex_none()
            .min_w(px(ROW_MIN))
            .child(section(t, &i18n::t("params.user")))
            .child(head_row(t));
        for r in &self.rows.user {
            body = body.child(self.row(t, r, window, cx));
        }
        body = body.child(self.add_row(t, window, cx));
        if !self.rows.model.is_empty() {
            body = body.child(section(t, &i18n::t("params.model"))).child(head_row(t));
            for r in &self.rows.model {
                body = body.child(self.row(t, r, window, cx));
            }
        }
        body = body.child(text(t, FS_MICRO).mt(px(S_3)).text_color(t.text_mute).child(i18n::t(HINT)));
        let card = solid_card(t)
            .bg(t.float_bg_solid)
            .w(px(width))
            .max_h((size.height * 0.7).min(room))
            .p(px(S_4))
            .child(head)
            .child(div().id("params-body").flex().flex_col().min_h_0().overflow_scroll().child(body));
        div()
            .absolute()
            .top(px(top))
            .left(px(left))
            .opacity(fade)
            .child(glass_in("params-in", card))
            .when(!self.open, |d| d.child(div().absolute().inset_0().occlude()))
            .into_any_element()
    }
}
