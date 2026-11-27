//! The popover parts of FundaCAD 1's view controls: Popover, Toggle, ChoiceList, Tabs and the wide buttons.

use gpui::prelude::FluentBuilder as _;
use gpui::*;

use crate::motion::{self, mix, pop_in};
use crate::theme::{
    Rgb, Theme, FLOAT_CHIP_RADIUS, FLOAT_GAP, FS_BODY, FS_MICRO, FS_SMALL, R_MD, R_PILL, R_SM, S_1, S_2, S_3,
    W_MEDIUM, W_SEMIBOLD,
};
use crate::ui::{icon, solid_card, text};

pub const POP_W: f32 = 236.;

/// A card opening to the left of the button it belongs to, kept inside the window.
pub fn popover(
    t: &Theme,
    key: &'static str,
    close: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    rows: Vec<AnyElement>,
) -> Div {
    let card = solid_card(t)
        .id(key)
        .bg(t.float_bg_solid)
        .w(px(POP_W))
        .p(px(S_2))
        .flex()
        .flex_col()
        .gap(px(2.))
        .text_color(t.text)
        .on_mouse_down_out(close)
        .occlude()
        .children(rows);
    // The anchor is the column's left edge, the group's padding and the float gap out from the button.
    div().absolute().top_0().left(px(-(FLOAT_GAP + 3.))).child(
        deferred(
            anchored()
                .anchor(Anchor::TopRight)
                .snap_to_window_with_margin(px(8.))
                .child(pop_in(SharedString::from(format!("vc-pop-{key}")), card)),
        )
        .with_priority(1),
    )
}

pub fn section(t: &Theme, label: &str) -> AnyElement {
    text(t, FS_MICRO)
        .px(px(S_2))
        .pt(px(S_1))
        .pb(px(2.))
        .font_weight(W_SEMIBOLD)
        .text_color(t.text_mute)
        .child(label.to_uppercase())
        .into_any_element()
}

pub fn rule(t: &Theme) -> AnyElement {
    div().h(px(1.)).mx(px(S_1)).my(px(S_1)).bg(t.control_edge).into_any_element()
}

pub fn note(t: &Theme, body: impl Into<SharedString>) -> AnyElement {
    text(t, FS_SMALL).px(px(S_2)).py(px(S_1)).text_color(t.text_mute).child(body.into()).into_any_element()
}

fn row(t: &Theme, id: impl Into<ElementId>) -> Stateful<Div> {
    let wash = t.hover_wash;
    text(t, FS_BODY)
        .id(id)
        .flex()
        .items_center()
        .gap(px(S_2))
        .min_h(px(t.hit(28.)))
        .px(px(S_2))
        .rounded(px(FLOAT_CHIP_RADIUS))
        .squircle()
        .font_weight(W_MEDIUM)
        .cursor_pointer()
        .hover(move |s| s.bg(wash))
}

/// FundaCAD 1's Toggle: the label with a switch at the end, the whole row flipping it.
pub fn toggle(t: &Theme, id: &str, label: impl Into<SharedString>, on: bool, enabled: bool) -> Stateful<Div> {
    let id = SharedString::from(id.to_string());
    let (off, accent, knob) = (t.control_edge, t.accent, t.on_accent);
    let track = div().w(px(28.)).h(px(16.)).flex_none().p(px(2.)).rounded(px(R_PILL));
    let track = motion::toggle(SharedString::from(format!("{id}-track")), on, track, move |d, m| {
        d.bg(mix(off, accent, m.on)).child(div().ml(px(12. * m.on)).size(px(12.)).rounded(px(R_PILL)).bg(knob))
    });
    let el = row(t, ElementId::Name(id)).justify_between().child(div().flex_1().child(label.into())).child(track);
    if enabled {
        el
    } else {
        el.opacity(0.45).cursor_default()
    }
}

/// One row of FundaCAD 1's ChoiceList: a tick on the chosen one, an optional hint under the label.
pub fn choice(
    t: &Theme,
    id: impl Into<ElementId>,
    label: &str,
    hint: Option<&str>,
    chosen: bool,
    enabled: bool,
) -> Stateful<Div> {
    let colour = if chosen { t.accent_hot } else { t.text };
    let tick = div().size(px(14.)).flex_none().when(chosen, |d| d.child(icon("check", 14., t.accent_hot)));
    let words = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .child(div().text_color(colour).when(chosen, |d| d.font_weight(W_SEMIBOLD)).child(label.to_string()))
        .children(hint.map(|h| text(t, FS_MICRO).w_full().text_color(t.text_mute).child(h.to_string())));
    let el = row(t, id).py(px(S_1)).child(tick).child(words);
    if enabled {
        el
    } else {
        el.opacity(0.45).cursor_default()
    }
}

/// `.pop-wide`, filled, or `ghost` for the quieter one.
pub fn wide(t: &Theme, id: &'static str, glyph: Option<&str>, label: &str, ghost: bool) -> Stateful<Div> {
    let (bg, hover) = if ghost { (Rgb::TRANSPARENT, t.hover_wash) } else { (t.raised_2, t.raised) };
    text(t, FS_BODY)
        .id(id)
        .h(px(t.hit(30.)))
        .px(px(S_3))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(S_2))
        .rounded(px(R_MD))
        .squircle()
        .font_weight(W_MEDIUM)
        .cursor_pointer()
        .bg(bg)
        .when(ghost, |d| d.border_1().border_color(t.control_edge))
        .hover(move |s| s.bg(hover))
        .children(glyph.map(|g| icon(g, 16., t.text_dim)))
        .child(label.to_string())
}

/// FundaCAD 1's Tabs: a segmented strip across the popover's top, one `tab` per choice.
pub fn tab_bar(t: &Theme) -> Div {
    div().flex().gap(px(2.)).p(px(2.)).mb(px(S_1)).rounded(px(R_MD)).bg(t.raised)
}

pub fn tab(t: &Theme, id: &'static str, label: &'static str, on: bool) -> Stateful<Div> {
    text(t, FS_SMALL)
        .id(id)
        .flex_1()
        .h(px(t.hit(24.)))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(R_SM))
        .cursor_pointer()
        .font_weight(if on { W_SEMIBOLD } else { W_MEDIUM })
        .text_color(if on { t.accent_hot } else { t.text_dim })
        .when(on, |d| d.bg(t.accent_wash))
        .child(label)
}

/// One matcap ball: a lit corner fading into its shadow, ringed when picked.
pub fn swatch(t: &Theme, id: &'static str, (lit, dark): (u32, u32), on: bool) -> Stateful<Div> {
    let fill = linear_gradient(135., linear_color_stop(rgb(lit), 0.), linear_color_stop(rgb(dark), 1.));
    div()
        .id(id)
        .size(px(36.))
        .rounded(px(R_PILL))
        .bg(fill)
        .cursor_pointer()
        .border_2()
        .border_color(if on { t.accent.into() } else { Hsla::transparent_black() })
}
