//! The open History step's rows, as FeatureProperties.vue: the build note, what the feature is applied to, its
//! choices, switches and numbers. Every change is one undo step through the viewport.

use std::collections::{HashMap, HashSet};

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::Input;
use serde_json::Value;

use super::history::format_value;
use super::Shell;
use crate::document::Param;
use crate::inspector::{self as model, ChoiceRow, Kind, NumRow, Row, Rule};
use crate::theme::{Theme, FLOAT_CHIP_RADIUS, FS_SMALL, R_MD, R_PILL, S_0, S_1, S_2, S_3, W_SEMIBOLD};
use crate::ui::{icon, text};

#[derive(Default)]
pub(super) struct Ui {
    /// The choice whose options are listed, as `feature:field`.
    open_choice: Option<String>,
    /// Why a typed value was refused, by `Target::key`.
    problems: HashMap<String, String>,
}

/// Before a document is open the step's own values stand in, edited by the shell's plain commit.
fn param_row(p: &Param) -> Row {
    let kind = match p.unit {
        "mm" => Kind::Length,
        "°" => Kind::Angle,
        _ => Kind::Count,
    };
    Row::Number(NumRow {
        field: p.label.to_string(),
        label: p.label.to_string(),
        kind,
        rule: Rule::default(),
        value: Some(p.value),
        expr: p.expr.as_ref().map(|e| e.to_string()),
        target: p.target.clone(),
    })
}

/// The field key of a row that takes typing.
fn typed_key(n: &NumRow) -> Option<String> {
    n.target.as_ref().filter(|_| n.expr.is_none()).map(|t| t.key())
}

fn shown(n: &NumRow) -> String {
    n.value.map(format_value).unwrap_or_default()
}

impl Shell {
    /// The open step's feature id and rows.
    fn open_rows(&self, cx: &App) -> Option<(String, Vec<Row>)> {
        let f = &self.doc.features[self.open_step()?];
        let rows = match &self.source {
            Some(doc) => model::rows(doc, &f.id, self.viewport.read(cx).feature_issues()),
            None => f.params.iter().map(param_row).collect(),
        };
        Some((f.id.clone(), rows))
    }

    fn open_number(&self, key: &str, cx: &App) -> Option<NumRow> {
        self.open_rows(cx)?.1.into_iter().find_map(|r| match r {
            Row::Number(n) if typed_key(&n).as_deref() == Some(key) => Some(n),
            _ => None,
        })
    }

    pub(super) fn ensure_inspector_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(feature = "shot")]
        {
            // FUNDA_OPEN_STEP=<index> opens a History step for a screenshot, once the document is read.
            static OPENED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if self.source.is_some() && !OPENED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                if let Some(i) = std::env::var("FUNDA_OPEN_STEP").ok().and_then(|s| s.parse::<usize>().ok()) {
                    if let Some(id) = self.row_ids().get(i).cloned() {
                        self.timeline.rows = crate::timeline::rows::Rows { keys: vec![id.clone()], anchor: Some(id) };
                    }
                }
            }
        }
        let rows = self.open_rows(cx).map(|(_, rows)| rows).unwrap_or_default();
        let mut keys = HashSet::new();
        for row in rows {
            let Row::Number(n) = row else { continue };
            let Some(key) = typed_key(&n) else { continue };
            let text = shown(&n);
            let input = self.field(&key, &text, window, cx);
            if input.read(cx).value() == text {
                self.inspector.problems.remove(&key);
            }
            keys.insert(key);
        }
        self.inspector.problems.retain(|k, _| keys.contains(k));
    }

    /// Checks what was typed into an open step's number, false when the row is not the inspector's.
    pub(super) fn inspector_commit(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.source.is_none() {
            return false;
        }
        let Some(n) = self.open_number(key, cx) else { return false };
        let Some(field) = self.fields.get(key) else { return true };
        let typed = field.input.read(cx).value().to_string();
        if typed.trim() == shown(&n) {
            self.inspector.problems.remove(key);
            return true;
        }
        let checked =
            model::parse(n.kind, &typed).and_then(|v| model::value_problem(&n.label, n.rule, v).map_or(Ok(v), Err));
        let (value, Some(target)) = (checked, n.target) else { return true };
        let value = match value {
            Ok(v) => v,
            Err(why) => {
                self.inspector.problems.insert(key.to_string(), why);
                cx.notify();
                return true;
            }
        };
        self.inspector.problems.remove(key);
        let step = self.open_rows(cx).map(|(id, _)| crate::timeline::labels::name_of(&self.timeline.doc, &id));
        let label = step.map(|s| format!("{} of {s}", n.label.to_lowercase()));
        let edited =
            self.viewport.update(cx, |v, cx| v.edit_step(None, label, move |d| model::set_number(d, &target, value), cx));
        if let Err(why) = edited {
            log::info!("the edit was not applied: {why}");
        }
        self.sync(window, cx);
        let text = self.open_number(key, cx).map(|n| shown(&n)).unwrap_or_default();
        if let Some(field) = self.fields.get(key) {
            field.input.update(cx, |i, cx| i.set_value(text, window, cx));
        }
        true
    }

    fn apply_option(&mut self, id: String, field: &'static str, value: Value, cx: &mut Context<Self>) {
        let edited = self.viewport.update(cx, |v, cx| v.edit(move |d| model::set_option(d, &id, field, &value), cx));
        if let Err(why) = edited {
            log::info!("the change was not applied: {why}");
        }
        cx.notify();
    }

    /// `.timeline-props`: the rows of the open step, indented under it.
    pub(super) fn inspector(&self, t: &Theme, i: usize, window: &Window, cx: &mut Context<Self>) -> Option<Div> {
        if self.open_step() != Some(i) {
            return None;
        }
        let (id, rows) = self.open_rows(cx)?;
        if rows.is_empty() {
            return None;
        }
        let rows: Vec<AnyElement> = rows.iter().map(|r| self.row(t, &id, r, window, cx)).collect();
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(S_2))
                .ml(px(S_3))
                .mb(px(S_2))
                .py(px(S_2))
                .pr(px(S_2))
                .pl(px(S_3))
                .flex_none()
                .border_l_1()
                .border_color(t.line)
                .children(rows),
        )
    }

    fn row(&self, t: &Theme, id: &str, row: &Row, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        match row {
            Row::Note { text: words, warning } => {
                let c = if *warning { t.warn } else { t.error };
                div()
                    .flex()
                    .items_start()
                    .gap(px(S_2))
                    .px(px(S_2))
                    .py(px(S_1 + S_0))
                    .rounded(px(FLOAT_CHIP_RADIUS))
                    .bg(c.fade(0.12))
                    .child(icon(if *warning { "warning" } else { "error" }, 14., c).flex_none().mt(px(1.)))
                    .child(text(t, FS_SMALL).flex_1().min_w_0().text_color(t.text).child(words.clone()))
                    .into_any_element()
            }
            Row::Repeats { names } => line(t, "Features", value(t, names, false)).into_any_element(),
            Row::Target { label, text: words, empty } => line(t, label, value(t, words, *empty)).into_any_element(),
            Row::Choice(c) => self.choice(t, id, c, cx).into_any_element(),
            Row::Toggle { field, label, on } => {
                let (id, field, on) = (id.to_string(), *field, *on);
                let switch = switch(t, on).id(ElementId::Name(format!("toggle:{id}:{field}").into())).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.apply_option(id.clone(), field, Value::Bool(!on), cx);
                    }),
                );
                line(t, label, switch).into_any_element()
            }
            Row::Number(n) => self.number(t, n, window, cx).into_any_element(),
        }
    }

    fn choice(&self, t: &Theme, id: &str, c: &ChoiceRow, cx: &mut Context<Self>) -> Div {
        let key = format!("{id}:{}", c.field);
        let open = self.inspector.open_choice.as_deref() == Some(key.as_str());
        let current = c.options.iter().find(|o| o.value == c.current).map_or(c.current.as_str(), |o| o.label.as_str());
        let flip = key.clone();
        let button = text(t, FS_SMALL)
            .id(ElementId::Name(format!("choice:{key}").into()))
            .w(px(120.))
            .h(px(32.))
            .flex_none()
            .px(px(S_3))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(S_1))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .bg(t.field_bg)
            .border_1()
            .border_color(if open { t.accent } else { t.control_edge })
            .child(div().min_w_0().truncate().child(current.to_string()))
            .child(icon("caretDown", 12., t.text_mute).flex_none())
            .on_click(cx.listener(move |this, _, _, cx| {
                let ui = &mut this.inspector;
                ui.open_choice = if ui.open_choice.as_ref() == Some(&flip) { None } else { Some(flip.clone()) };
                cx.notify();
            }));
        let row = div().flex().flex_col().gap(px(S_1)).child(line(t, c.label, button));
        if !open {
            return row;
        }
        // Stands in for the popup menu fc2/commands brings, listed under the row until then.
        let hover = t.hover_wash;
        let options = c.options.iter().enumerate().map(|(n, o)| {
            let (id, field, value) = (id.to_string(), c.field, o.value.clone());
            text(t, FS_SMALL)
                .id(ElementId::Name(format!("option:{key}:{n}").into()))
                .px(px(S_2))
                .py(px(S_1))
                .rounded(px(R_MD))
                .text_color(t.text)
                .map(|d| if o.value == c.current { d.bg(t.accent_wash) } else { d.hover(move |s| s.bg(hover)) })
                .child(o.label.clone())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.inspector.open_choice = None;
                    this.apply_option(id.clone(), field, Value::String(value.clone()), cx);
                }))
        });
        let list = div()
            .min_w(px(120.))
            .flex()
            .flex_col()
            .gap(px(S_0))
            .p(px(S_1))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .bg(t.raised)
            .border_1()
            .border_color(t.line)
            .children(options);
        row.child(div().flex().justify_end().child(list))
    }

    fn number(&self, t: &Theme, n: &NumRow, window: &Window, cx: &App) -> Div {
        let key = typed_key(n);
        let input = key.as_ref().and_then(|k| self.fields.get(k)).map(|f| &f.input);
        let focused = input.is_some_and(|i| i.focus_handle(cx).is_focused(window));
        let label = text(t, FS_SMALL).flex_1().min_w_0().text_color(t.text_dim).map(|d| match n.expr {
            Some(_) => {
                d.flex().gap(px(3.)).child(div().italic().text_color(t.accent_hot).child("fx:")).child(n.label.clone())
            }
            None => d.child(n.label.clone()),
        });
        let shown = match (input, &n.expr) {
            (Some(input), None) => div()
                .flex_1()
                .min_w_0()
                .child(
                    Input::new(input)
                        .appearance(false)
                        .bordered(false)
                        .focus_bordered(false)
                        .text_size(px(FS_SMALL))
                        .p_0(),
                )
                .into_any_element(),
            (_, Some(expr)) => div().min_w_0().truncate().child(expr.clone()).into_any_element(),
            (None, None) => div().child(shown(n)).into_any_element(),
        };
        let problem = key.and_then(|k| self.inspector.problems.get(&k).cloned());
        let edge = if problem.is_some() {
            t.error
        } else if focused {
            t.accent
        } else {
            t.control_edge
        };
        let unit = n.kind.unit();
        let field = text(t, FS_SMALL)
            .w(px(120.))
            .h(px(32.))
            .flex_none()
            .px(px(S_3))
            .flex()
            .items_center()
            .justify_between()
            .rounded(px(FLOAT_CHIP_RADIUS))
            .bg(t.field_bg)
            .border_1()
            .border_color(edge)
            .child(shown)
            .when(!unit.is_empty(), |d| {
                d.child(div().px(px(S_1)).py(px(2.)).font_weight(W_SEMIBOLD).text_color(t.text_mute).child(unit))
            });
        div()
            .flex()
            .flex_col()
            .gap(px(S_1))
            .child(div().flex().items_center().gap(px(S_3)).child(label).child(field))
            .when_some(problem, |d, p| d.child(text(t, FS_SMALL).text_color(t.error).child(p)))
    }
}

fn line(t: &Theme, label: &str, control: impl IntoElement) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(S_3))
        .child(text(t, FS_SMALL).flex_1().min_w_0().text_color(t.text_dim).child(label.to_string()))
        .child(control)
}

fn value(t: &Theme, words: &str, empty: bool) -> Div {
    text(t, FS_SMALL).max_w(px(150.)).text_color(if empty { t.text_mute } else { t.text }).child(words.to_string())
}

/// A 36 by 20 switch, the knob at the end it is set to.
fn switch(t: &Theme, on: bool) -> Div {
    div()
        .w(px(36.))
        .h(px(20.))
        .flex_none()
        .relative()
        .rounded(px(R_PILL))
        .bg(if on { t.accent } else { t.raised_2 })
        .border_1()
        .border_color(if on { t.accent } else { t.control_edge })
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(if on { 18. } else { 2. }))
                .size(px(14.))
                .rounded(px(R_PILL))
                .bg(if on { t.on_accent } else { t.text }),
        )
}
