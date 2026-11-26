//! A minimal modal: a scrim over the window, a card with a title, a body and a row of buttons. Escape closes it.
//! The overlay's question holds plain choices, this holds a form and the busy dialog that waits on a task.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use crate::theme::{Theme, FS_BODY, FS_SMALL, FS_TITLE, R_MD, S_1, S_2, S_3, S_4, W_MEDIUM, W_SEMIBOLD};
use crate::ui::{solid_card, text};

pub fn modal(
    t: &Theme,
    focus: &FocusHandle,
    title: impl Into<SharedString>,
    body: impl IntoElement,
    buttons: Vec<AnyElement>,
    on_close: impl Fn(&mut Window, &mut App) + 'static,
) -> Div {
    let mut context = KeyContext::default();
    context.add(crate::commands::MODAL);
    div().absolute().inset_0().flex().items_center().justify_center().bg(hsla(0., 0., 0., 0.45)).occlude().child(
        solid_card(t)
            .id("modal")
            .track_focus(focus)
            .key_context(context)
            .on_key_down(move |e: &KeyDownEvent, window, cx| {
                if e.keystroke.key == "escape" {
                    cx.stop_propagation();
                    on_close(window, cx);
                }
            })
            .w(px(460.))
            .max_h(relative(0.9))
            .bg(t.float_bg_solid)
            .p(px(S_4))
            .gap(px(S_3))
            .child(text(t, FS_TITLE).font_weight(W_SEMIBOLD).child(title.into()))
            .child(div().flex().flex_col().gap(px(S_2)).child(body))
            .child(div().flex().justify_end().gap(px(S_2)).pt(px(S_2)).children(buttons)),
    )
}

/// A labelled row of the body.
pub fn row(t: &Theme, label: impl Into<SharedString>, content: impl IntoElement) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(S_3))
        .child(text(t, FS_SMALL).w(px(96.)).flex_none().text_color(t.text_dim).child(label.into()))
        .child(div().flex_1().min_w_0().flex().flex_wrap().gap(px(S_1)).child(content))
}

pub fn button(
    t: &Theme,
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    primary: bool,
    enabled: bool,
) -> Stateful<Div> {
    let hover = if primary { t.accent_hot } else { t.raised_2 };
    text(t, FS_BODY)
        .id(id)
        .h(px(t.hit(28.)))
        .px(px(S_4))
        .flex()
        .items_center()
        .rounded(px(R_MD))
        .font_weight(W_MEDIUM)
        .map(|d| if primary { d.bg(t.accent).text_color(t.on_accent) } else { d.bg(t.raised) })
        .when(enabled, |d| d.cursor_pointer().hover(move |s| s.bg(hover)))
        .when(!enabled, |d| d.opacity(0.4))
        .child(label.into())
}

/// One option of a segmented choice.
pub fn choice(
    t: &Theme,
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    on: bool,
    enabled: bool,
) -> Stateful<Div> {
    let hover = t.hover_wash;
    text(t, FS_SMALL)
        .id(id)
        .h(px(t.hit(22.)))
        .px(px(S_2))
        .flex()
        .items_center()
        .rounded(px(3.))
        .border_1()
        .border_color(if on { t.accent } else { t.control_edge })
        .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
        .text_color(if on { t.accent_hot } else { t.text_dim })
        .when(on, |d| d.bg(t.accent_wash))
        .when(enabled && !on, |d| d.cursor_pointer().hover(move |s| s.bg(hover)))
        .when(!enabled, |d| d.opacity(0.4))
        .child(label.into())
}

pub fn note(t: &Theme, s: impl Into<SharedString>) -> Div {
    text(t, FS_SMALL).text_color(t.text_mute).child(s.into())
}
