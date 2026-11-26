//! The Parameters panel, ParamsDialog.vue: user and model parameters with their expressions, values and what they
//! drive. Every change is one edit of the viewport's document, so one undo step, and the model rebuilds.

mod rows;

use std::collections::HashMap;

use fundacad_client::Doc;
use fundacad_core::params::edit;
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputEvent, InputState};

use crate::theme::{ActiveTheme as _, Theme, FLOAT_GAP, FS_BODY, FS_MICRO, FS_SMALL, R_MD, S_1, S_2, S_3, S_4, W_SEMIBOLD};
use crate::ui::{icon_button, solid_card, text};
use crate::viewport::Viewport;
use rows::{value_text, Row, Rows};

actions!(params, [OpenParameters]);

const HINT: &str = "Expressions are in mm / degrees; suffixes mm cm in deg rad allowed \u{b7} a semicolon separates \
                    arguments: max(a; b) \u{b7} Esc to close";
const UNITS: [(&str, &str); 3] = [("mm", "mm"), ("deg", "deg"), ("count", "unitless")];
const NAME_W: f32 = 110.;
const VALUE_W: f32 = 90.;
const DEL_W: f32 = 24.;
const FIELD_H: f32 = 28.;
/// Clear of the History card and the view controls on the right.
const RIGHT: f32 = 372.;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Col {
    Name,
    Expr,
    Comment,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
    Row(String, Col),
    NewName,
    NewExpr,
}

struct Field {
    input: Entity<InputState>,
    _events: Subscription,
}

pub struct ParamsPanel {
    viewport: Entity<Viewport>,
    open: bool,
    /// The document `rows` were read from.
    source: Option<Doc>,
    rows: Rows,
    fields: HashMap<Key, Field>,
    /// Why a typed text was refused or will not evaluate, kept until it is fixed.
    problems: HashMap<Key, String>,
    /// What an expression being typed evaluates to.
    preview: HashMap<Key, f64>,
    /// A refused delete, by parameter.
    refused: HashMap<String, String>,
    unit: &'static str,
    _observe: Subscription,
}

impl ParamsPanel {
    pub fn new(viewport: Entity<Viewport>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let observe = cx.observe_in(&viewport, window, |this, _, window, cx| this.sync(window, cx));
        let mut panel = Self {
            viewport,
            // FUNDA_PANEL=params opens it at start, for captures.
            open: std::env::var("FUNDA_PANEL").is_ok_and(|p| p == "params"),
            source: None,
            rows: Rows::default(),
            fields: HashMap::new(),
            problems: HashMap::new(),
            preview: HashMap::new(),
            refused: HashMap::new(),
            unit: "mm",
            _observe: observe,
        };
        panel.sync(window, cx);
        panel
    }

    pub fn toggle(&mut self, cx: &mut Context<Self>) {
        self.open = !self.open;
        cx.notify();
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let viewport = self.viewport.read(cx);
        let Some(doc) = viewport.doc() else { return };
        if self.source.as_ref() == Some(doc) {
            return;
        }
        let doc = doc.clone();
        self.rows = rows::rows(&doc);
        self.source = Some(doc);
        let texts = self.texts();
        let kept = |k: &Key| matches!(k, Key::NewName | Key::NewExpr) || texts.contains_key(k);
        self.fields.retain(|k, _| kept(k));
        self.problems.retain(|k, _| kept(k));
        self.preview.retain(|k, _| kept(k));
        let rows = &self.rows;
        self.refused.retain(|n, _| rows.find(n).is_some());
        for (key, text) in texts {
            let Some(field) = self.fields.get(&key) else { continue };
            let focused = field.input.focus_handle(cx).is_focused(window);
            if !focused && !self.problems.contains_key(&key) && field.input.read(cx).value() != text {
                field.input.update(cx, |i, cx| i.set_value(text, window, cx));
            }
        }
        cx.notify();
    }

    /// The text each row field shows when nothing is typed in it.
    fn texts(&self) -> HashMap<Key, String> {
        let mut out = HashMap::new();
        for r in self.rows.user.iter().chain(&self.rows.model) {
            out.insert(Key::Row(r.name.clone(), Col::Name), r.name.clone());
            out.insert(Key::Row(r.name.clone(), Col::Expr), r.expr.clone());
            if r.drives.is_none() {
                out.insert(Key::Row(r.name.clone(), Col::Comment), r.comment.clone());
            }
        }
        out
    }

    fn ensure_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for (key, text) in self.texts() {
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
        let input =
            cx.new(|cx| InputState::new(window, cx).default_value(text.to_string()).placeholder(placeholder));
        let owner = key.clone();
        let events = cx.subscribe_in(&input, window, move |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => this.commit(&owner, window, cx),
            InputEvent::Blur if matches!(owner, Key::Row(..)) => this.commit(&owner, window, cx),
            InputEvent::Change => this.check(&owner, cx),
            _ => {}
        });
        self.fields.insert(key, Field { input, _events: events });
    }

    fn typed(&self, key: &Key, cx: &App) -> String {
        self.fields.get(key).map(|f| f.input.read(cx).value().trim().to_string()).unwrap_or_default()
    }

    /// Evaluates an expression as it is typed.
    fn check(&mut self, key: &Key, cx: &mut Context<Self>) {
        let name = match key {
            Key::Row(name, Col::Expr) => Some(name.clone()),
            Key::NewExpr => None,
            _ => return,
        };
        let typed = self.typed(key, cx);
        let unchanged = name.as_ref().and_then(|n| self.rows.find(n)).is_some_and(|r| r.expr == typed);
        let result = match self.viewport.read(cx).doc() {
            Some(doc) if !typed.is_empty() && !unchanged => Some(edit::check_expr(doc, name.as_deref(), &typed)),
            _ => None,
        };
        self.preview.remove(key);
        self.problems.remove(key);
        match result {
            Some(Ok(v)) => {
                self.preview.insert(key.clone(), v);
            }
            Some(Err(why)) => {
                self.problems.insert(key.clone(), why);
            }
            None => {}
        }
        cx.notify();
    }

    fn edit(
        &self,
        f: impl Fn(&mut Doc) -> Result<(), String> + Send + Sync + 'static,
        cx: &mut Context<Self>,
    ) -> Result<(), String> {
        self.viewport.update(cx, |v, cx| v.edit(f, cx)).map(drop)
    }

    fn commit(&mut self, key: &Key, window: &mut Window, cx: &mut Context<Self>) {
        let Key::Row(name, col) = key else {
            self.add(window, cx);
            return;
        };
        let Some(row) = self.rows.find(name) else { return };
        let typed = self.typed(key, cx);
        let current = match col {
            Col::Name => &row.name,
            Col::Expr => &row.expr,
            Col::Comment => &row.comment,
        };
        self.preview.remove(key);
        if typed == *current {
            self.problems.remove(key);
            cx.notify();
            return;
        }
        let name = name.clone();
        let done = match col {
            Col::Name => self.edit(move |d| edit::rename_param(d, &name, &typed).map(drop), cx),
            Col::Expr => self.edit(move |d| edit::set_param_expr(d, &name, &typed).map(drop), cx),
            Col::Comment => self.edit(move |d| edit::set_param_comment(d, &name, &typed), cx),
        };
        match done {
            Ok(()) => {
                self.problems.remove(key);
            }
            Err(why) => {
                self.problems.insert(key.clone(), why);
            }
        }
        self.sync(window, cx);
        cx.notify();
    }

    fn add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (name, expr, unit) = (self.typed(&Key::NewName, cx), self.typed(&Key::NewExpr, cx), self.unit);
        if name.is_empty() || expr.is_empty() {
            return;
        }
        match self.edit(move |d| edit::add_param(d, &name, &expr, unit).map(drop), cx) {
            Ok(()) => {
                self.problems.remove(&Key::NewName);
                self.problems.remove(&Key::NewExpr);
                self.preview.remove(&Key::NewExpr);
                for key in [Key::NewName, Key::NewExpr] {
                    if let Some(f) = self.fields.get(&key) {
                        f.input.update(cx, |i, cx| i.set_value("", window, cx));
                    }
                }
            }
            Err(why) => {
                self.problems.insert(Key::NewName, why);
            }
        }
        self.sync(window, cx);
        cx.notify();
    }

    fn delete(&mut self, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let target = name.clone();
        match self.edit(move |d| edit::delete_param(d, &target).map(drop), cx) {
            Ok(()) => {
                self.refused.remove(&name);
            }
            Err(why) => {
                self.refused.insert(name, why);
            }
        }
        self.sync(window, cx);
        cx.notify();
    }
}

fn caption(t: &Theme, label: &str) -> Div {
    text(t, FS_MICRO).text_color(t.text_dim).child(label.to_uppercase())
}

fn head_row(t: &Theme, last: &str) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(S_3))
        .mb(px(S_2))
        .child(caption(t, "Name").w(px(NAME_W)).flex_none())
        .child(caption(t, "Expression").flex_1().min_w_0())
        .child(caption(t, "Value").w(px(VALUE_W)).flex_none())
        .child(caption(t, last).flex_1().min_w_0())
        .child(div().w(px(DEL_W)).flex_none())
}

fn section(t: &Theme, label: &str) -> Div {
    text(t, FS_MICRO).font_weight(W_SEMIBOLD).text_color(t.text_dim).mt(px(S_4)).mb(px(S_1)).child(label.to_uppercase())
}

impl ParamsPanel {
    fn input(&self, t: &Theme, key: &Key, stale: bool, window: &Window, cx: &App) -> Div {
        let field = self.fields.get(key);
        let focused = field.is_some_and(|f| f.input.focus_handle(cx).is_focused(window));
        let edge = if self.problems.contains_key(key) {
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
        match self.preview.get(&Key::Row(r.name.clone(), Col::Expr)) {
            Some(v) => cell.text_color(t.accent_hot).child(value_text(*v, &r.unit)),
            None => cell.text_color(if r.issue.is_some() { t.warn } else { t.text_dim }).child(r.value.clone()),
        }
    }

    /// A refusal or a stale value, under its row.
    fn note(&self, t: &Theme, r: &Row) -> Option<Div> {
        let typed = [Col::Name, Col::Expr, Col::Comment]
            .into_iter()
            .find_map(|c| self.problems.get(&Key::Row(r.name.clone(), c)))
            .or_else(|| self.refused.get(&r.name));
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
            Some(drives) => text(t, FS_SMALL).flex_1().min_w_0().truncate().text_color(t.text_dim).child(drives.clone()),
            None => self.input(t, &key(Col::Comment), false, window, cx).flex_1(),
        };
        let del = match r.drives {
            Some(_) => div().w(px(DEL_W)).flex_none(),
            None => {
                let refused = self.refused.contains_key(&r.name);
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
                let hover = t.hover_wash;
                text(t, FS_MICRO)
                    .id(unit)
                    .px(px(S_2))
                    .h(px(FIELD_H - 6.))
                    .flex()
                    .items_center()
                    .rounded(px(R_MD - 1.))
                    .map(|d| if on { d.bg(t.raised).text_color(t.text) } else { d.text_color(t.text_dim) })
                    .hover(move |s| s.bg(hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.unit = unit;
                        cx.notify();
                    }))
                    .child(label)
            }),
        );
        let refused = self.problems.contains_key(&Key::NewName);
        let (fill, hot, ink) = if refused { (t.error, t.error, t.on_accent) } else { (t.raised, t.raised_2, t.text) };
        let add = text(t, FS_SMALL)
            .id("params-add")
            .h(px(FIELD_H))
            .px(px(S_3))
            .flex()
            .flex_none()
            .items_center()
            .rounded(px(R_MD))
            .bg(fill)
            .text_color(ink)
            .hover(move |s| s.bg(hot))
            .on_click(cx.listener(|this, _, window, cx| this.add(window, cx)))
            .child("+ Add");
        let preview = self.preview.get(&Key::NewExpr).map(|v| {
            text(t, FS_SMALL).flex_none().text_color(t.accent_hot).child(value_text(*v, self.unit))
        });
        let note = self.problems.get(&Key::NewName).or_else(|| self.problems.get(&Key::NewExpr));
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
        if !self.open {
            return div().into_any_element();
        }
        self.ensure_fields(window, cx);
        let t = cx.theme().clone();
        let t = &t;
        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .child(text(t, FS_BODY).font_weight(W_SEMIBOLD).text_color(t.accent_hot).child("Parameters"))
            .child(
                icon_button(t, "params-close", "close", 28., 14., t.text_mute)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle(cx))),
            );
        let mut body = div()
            .id("params-body")
            .flex()
            .flex_col()
            .min_h_0()
            .overflow_y_scroll()
            .child(section(t, "User Parameters"))
            .child(head_row(t, "Comment / drives"));
        for r in &self.rows.user {
            body = body.child(self.row(t, r, window, cx));
        }
        body = body.child(self.add_row(t, window, cx));
        if !self.rows.model.is_empty() {
            body = body.child(section(t, "Model Parameters")).child(head_row(t, "Comment / drives"));
            for r in &self.rows.model {
                body = body.child(self.row(t, r, window, cx));
            }
        }
        body = body.child(text(t, FS_MICRO).mt(px(S_3)).text_color(t.text_mute).child(HINT));
        solid_card(t)
            .bg(t.float_bg_solid)
            .absolute()
            .top(px(FLOAT_GAP))
            .right(px(RIGHT))
            .w(px(640.))
            .max_h(window.viewport_size().height * 0.7)
            .p(px(S_4))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" {
                    this.toggle(cx);
                }
            }))
            .child(head)
            .child(body)
            .into_any_element()
    }
}
