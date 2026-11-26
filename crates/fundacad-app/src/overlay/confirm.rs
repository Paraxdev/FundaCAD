//! A question with one button per answer, FundaCAD 1's ui/ConfirmDialog.vue.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::Overlay;
use crate::theme::{Theme, FLOAT_RADIUS, FS_BODY, FS_MICRO, FS_TITLE, R_MD, S_1, S_2, S_3, S_5, W_MEDIUM};
use crate::ui::text;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChoiceKind {
    Primary,
    Danger,
    Plain,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub label: SharedString,
    pub hint: Option<SharedString>,
    pub kind: ChoiceKind,
}

impl Choice {
    pub fn primary(label: impl Into<SharedString>) -> Self {
        Self { label: label.into(), hint: None, kind: ChoiceKind::Primary }
    }

    pub fn danger(label: impl Into<SharedString>) -> Self {
        Self { label: label.into(), hint: None, kind: ChoiceKind::Danger }
    }

    pub fn plain(label: impl Into<SharedString>) -> Self {
        Self { label: label.into(), hint: None, kind: ChoiceKind::Plain }
    }

    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

pub struct Confirm {
    pub question: SharedString,
    pub choices: Vec<Choice>,
    pub tx: async_channel::Sender<Option<usize>>,
    /// The button Enter presses, the primary one at first, else the last, which is Cancel by habit.
    pub active: usize,
}

impl Confirm {
    pub fn new(question: SharedString, choices: Vec<Choice>, tx: async_channel::Sender<Option<usize>>) -> Self {
        let active = first_active(&choices);
        Self { question, choices, tx, active }
    }
}

pub fn first_active(choices: &[Choice]) -> usize {
    choices.iter().position(|c| c.kind == ChoiceKind::Primary).unwrap_or(choices.len().saturating_sub(1))
}

impl Overlay {
    fn answer(&mut self, pick: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(c) = self.confirm.take() {
            let _ = c.tx.try_send(pick);
            self.release_keyboard(window, cx);
            cx.notify();
        }
    }

    pub(super) fn confirm_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(c) = &mut self.confirm else { return };
        let n = c.choices.len().max(1);
        match key {
            "escape" => return self.answer(None, window, cx),
            "enter" | "space" => {
                let pick = c.active;
                return self.answer(Some(pick), window, cx);
            }
            "left" | "up" => c.active = (c.active + n - 1) % n,
            "right" | "down" | "tab" => c.active = (c.active + 1) % n,
            _ => return,
        }
        cx.notify();
    }

    pub(super) fn render_confirm(&self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let c = self.confirm.as_ref()?;
        let mut row = div().flex().gap(px(S_2)).mt(px(S_5));
        for (i, choice) in c.choices.iter().enumerate() {
            row = row.child(
                button(t, i, choice, i == c.active)
                    .on_click(cx.listener(move |this, _, window, cx| this.answer(Some(i), window, cx))),
            );
        }
        let card = div()
            .id("confirm")
            .occlude()
            .w(px(420.))
            .p(px(S_5))
            .rounded(px(FLOAT_RADIUS))
            .bg(t.panel)
            .shadow(t.float_shadow.clone())
            .child(text(t, FS_TITLE).font_weight(W_MEDIUM).child(c.question.clone()))
            .child(row);
        Some(
            div()
                .id("confirm-scrim")
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(t.scrim)
                .occlude()
                .child(card)
                .into_any_element(),
        )
    }
}

/// `.btn` with `.ui-confirm-primary` or `.ui-confirm-danger`, its hint under the label.
fn button(t: &Theme, i: usize, choice: &Choice, active: bool) -> Stateful<Div> {
    let (bg, fg, hover): (Hsla, Hsla, Hsla) = match choice.kind {
        ChoiceKind::Primary => (t.accent.into(), t.bg.into(), t.accent_hot.into()),
        ChoiceKind::Danger => (t.error_tint.into(), t.error.into(), t.error_tint.into()),
        ChoiceKind::Plain => (t.raised.into(), t.text.into(), t.hover_wash.into()),
    };
    let ring: Hsla = t.accent.into();
    text(t, FS_BODY)
        .id(("choice", i))
        .flex_1()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(S_1 / 2.))
        .py(px(S_2))
        .px(px(S_3))
        .rounded(px(R_MD))
        .bg(bg)
        .text_color(fg)
        .font_weight(W_MEDIUM)
        .border_1()
        .border_color(if active { ring } else { transparent_black() })
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .child(choice.label.clone())
        .when_some(choice.hint.clone(), |d, h| d.child(text(t, FS_MICRO).text_color(fg.opacity(0.8)).child(h)))
}
