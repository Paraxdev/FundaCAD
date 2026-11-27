//! The small building blocks every Funda surface shares, drawn from the theme tokens. Whatever floats over the 3D
//! view occludes it, so a scroll or click on a card never reaches the camera or the model behind.

use std::cell::RefCell;

use gpui::*;

use crate::motion::{self, mix, Transition};
use crate::theme::{line_normal, Theme, FLOAT_CHIP_RADIUS, FLOAT_RADIUS, FLOAT_TILE_RADIUS};
use crate::viewport::{Frost, Viewport};

thread_local! {
    /// The glass surfaces prepainted this frame, which `frost_flush` hands to the viewport.
    static FROSTS: RefCell<Vec<Frost>> = const { RefCell::new(Vec::new()) };
}

/// Reports the bounds of the surface it sits in, to be blurred behind in the viewport. `outset` reaches the border box.
fn frost(radius: f32, outset: f32) -> Canvas<()> {
    canvas(
        move |bounds, _, _| {
            FROSTS.with_borrow_mut(|f| f.push(Frost { bounds, radius }));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .inset(px(-outset))
}

/// Last in the window's tree, so every surface has reported by the time it prepaints.
pub fn frost_flush(viewport: Entity<Viewport>) -> Canvas<()> {
    canvas(
        move |_, _, cx| {
            let frosts = FROSTS.with_borrow_mut(std::mem::take);
            viewport.update(cx, |v, cx| v.set_frosted(frosts, cx));
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
}

/// Text at a type-scale size with Chrome's `line-height: normal`.
pub fn text(t: &Theme, fs: f32) -> Div {
    div().text_size(px(fs)).line_height(line_normal(fs)).text_color(t.text)
}

/// A bare name is a forge icon, `pack/name` one a plugin ships, as `printing/print`.
pub fn icon_path(name: &str) -> String {
    if name.contains('/') {
        format!("icons/{name}.svg")
    } else {
        format!("icons/forge/{name}.svg")
    }
}

/// An svg does not inherit the text colour, so an icon takes its own.
pub fn icon(name: &str, size: f32, color: impl Into<Hsla>) -> Svg {
    svg().path(SharedString::from(icon_path(name))).size(px(size)).flex_none().text_color(color)
}

/// `.float-card`: a glass card over the 3D view.
pub fn float_card(t: &Theme) -> Div {
    solid_card(t).child(frost(FLOAT_RADIUS, 1.))
}

/// A card that sets its own opaque background, so nothing behind it needs a blur.
pub fn solid_card(t: &Theme) -> Div {
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
        .child(frost(FLOAT_RADIUS, 1.))
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
        .child(frost(FLOAT_TILE_RADIUS, 0.))
}

/// `.rail-pill` and chips: the small glass label beside a tile.
pub fn chip(t: &Theme) -> Div {
    div()
        .rounded(px(FLOAT_CHIP_RADIUS))
        .bg(t.float_chip_bg)
        .shadow(t.float_shadow.clone())
        .occlude()
        .child(frost(FLOAT_CHIP_RADIUS, 0.))
}

/// A square icon button, `IconButton` in the Vue app, its wash and icon colour eased over --t-fast.
pub fn icon_button(
    t: &Theme,
    id: impl Into<ElementId>,
    name: &str,
    box_size: f32,
    icon_size: f32,
    color: impl Into<Hsla>,
) -> Transition<Stateful<Div>> {
    let (hover, hover_text, color) = (t.raised, t.text, color.into());
    let id = id.into();
    let name = SharedString::from(name.to_string());
    let el = div().id(id.clone()).size(px(t.hit(box_size))).flex_none().flex().items_center().justify_center().rounded(px(4.));
    motion::hover(id, el, move |mut d, m| {
        let base = motion::base_bg(&mut d);
        d.bg(mix(base, hover, m.hover)).child(icon(&name, icon_size, mix(color, hover_text, m.hover)))
    })
}
