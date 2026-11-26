//! The small building blocks every Funda surface shares, drawn from the theme tokens. Whatever floats over the 3D
//! view occludes it, so a scroll or click on a card never reaches the camera or the model behind.

use gpui::*;

use crate::theme::{line_normal, Theme, FLOAT_CHIP_RADIUS, FLOAT_RADIUS, FLOAT_TILE_RADIUS};

/// Text at a type-scale size with Chrome's `line-height: normal`.
pub fn text(t: &Theme, fs: f32) -> Div {
    div().text_size(px(fs)).line_height(line_normal(fs)).text_color(t.text)
}

/// An icon from the forge pack. An svg does not inherit the text colour, so it takes its own.
pub fn icon(name: &str, size: f32, color: impl Into<Hsla>) -> Svg {
    svg().path(SharedString::from(format!("icons/forge/{name}.svg"))).size(px(size)).flex_none().text_color(color)
}

const ICON_BUTTON: &str = "icon-button";

/// `.float-card`: a glass card over the 3D view.
pub fn float_card(t: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(FLOAT_RADIUS))
        .bg(t.float_bg)
        .border_1()
        .border_color(transparent_black())
        .shadow(t.float_shadow.clone())
        .occlude()
}

/// `.float-group`: the column of view controls.
pub fn float_group(t: &Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .p(px(3.))
        .rounded(px(FLOAT_RADIUS))
        .bg(t.float_bg)
        .border_1()
        .border_color(transparent_black())
        .shadow(t.float_shadow.clone())
        .occlude()
}

/// `.rail-tile`: one glass tile of the tool rail.
pub fn tile(t: &Theme, size: f32) -> Div {
    div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(FLOAT_TILE_RADIUS))
        .bg(t.float_tile_bg)
        .shadow(t.float_shadow.clone())
        .text_color(t.text)
        .occlude()
}

/// `.rail-pill` and chips: the small glass label beside a tile.
pub fn chip(t: &Theme) -> Div {
    div().rounded(px(FLOAT_CHIP_RADIUS)).bg(t.float_chip_bg).shadow(t.float_shadow.clone()).occlude()
}

/// A square icon button, `IconButton` in the Vue app.
pub fn icon_button(
    t: &Theme,
    id: impl Into<ElementId>,
    name: &str,
    box_size: f32,
    icon_size: f32,
    color: impl Into<Hsla>,
) -> Stateful<Div> {
    let hover = t.raised;
    let hover_text = t.text;
    div()
        .id(id)
        .size(px(t.hit(box_size)))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.))
        .group(ICON_BUTTON)
        .hover(move |s| s.bg(hover))
        .child(icon(name, icon_size, color).group_hover(ICON_BUTTON, move |s| s.text_color(hover_text)))
}
