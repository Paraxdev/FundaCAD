//! The command palette on Ctrl+K, FundaCAD 1's overlays/CommandPalette.vue.

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputEvent, InputState};

use super::{score, Overlay};
use crate::commands;
use crate::theme::{Theme, FLOAT_CHIP_RADIUS, FLOAT_RADIUS, FS_BODY, FS_MICRO, FS_SMALL, S_1, S_2, S_3, S_4};
use crate::ui::text;

actions!(palette, [Up, Down, Pick, Close]);

const CONTEXT: &str = "Palette";
const SHOWN: usize = 40;

/// After gpui_kit::init, so these beat the text field's own up, down and escape.
pub fn bind(cx: &mut App) {
    let ctx = Some("Palette > Input");
    cx.bind_keys([
        KeyBinding::new("up", Up, ctx),
        KeyBinding::new("down", Down, ctx),
        KeyBinding::new("enter", Pick, ctx),
        KeyBinding::new("escape", Close, ctx),
    ]);
}

pub struct Palette {
    input: Entity<InputState>,
    active: usize,
    _events: Subscription,
}

impl Palette {
    pub fn new(window: &mut Window, cx: &mut Context<Overlay>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search commands…"));
        input.update(cx, |s, cx| s.focus(window, cx));
        let events = cx.subscribe_in(&input, window, |this, _, e: &InputEvent, _, cx| {
            if matches!(e, InputEvent::Change) {
                if let Some(p) = &mut this.palette {
                    p.active = 0;
                }
                cx.notify();
            }
        });
        Self { input, active: 0, _events: events }
    }
}

/// A row of the palette: the command, its group and its key.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    pub id: &'static str,
    pub label: SharedString,
    pub group: &'static str,
}

/// The best `SHOWN` of `rows` for `query`, best first, the order given kept between equals.
pub fn rank(rows: Vec<Hit>, query: &str) -> Vec<Hit> {
    let query = query.to_lowercase();
    let mut scored: Vec<(f32, Hit)> =
        rows.into_iter().map(|h| (score::score(&query, &h.label.to_lowercase()), h)).filter(|(s, _)| *s > 0.).collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    scored.into_iter().take(SHOWN).map(|(_, h)| h).collect()
}

impl Overlay {
    pub(super) fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_some() {
            self.release_keyboard(window, cx);
            cx.notify();
        }
    }

    fn hits(&self, cx: &App) -> Vec<Hit> {
        let Some(p) = &self.palette else { return Vec::new() };
        let query = p.input.read(cx).value();
        let rows = commands::available(cx)
            .into_iter()
            .map(|c| Hit { id: c.id, label: c.label, group: c.group.label() })
            .collect();
        rank(rows, query.trim())
    }

    fn run_hit(&mut self, id: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        self.close_palette(window, cx);
        window.defer(cx, move |window, cx| commands::run(id, window, cx));
    }

    fn move_active(&mut self, by: isize, cx: &mut Context<Self>) {
        let n = self.hits(cx).len() as isize;
        if let (Some(p), true) = (&mut self.palette, n > 0) {
            p.active = (p.active as isize + by).rem_euclid(n) as usize;
            cx.notify();
        }
    }

    pub(super) fn render_palette(&self, t: &Theme, _window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = self.palette.as_ref()?;
        let hits = self.hits(cx);
        let active = p.active.min(hits.len().saturating_sub(1));
        let mut list = div().id("palette-list").flex().flex_col().max_h(px(360.)).overflow_y_scroll().p(px(S_1));
        if hits.is_empty() {
            list = list.child(text(t, FS_SMALL).text_color(t.text_mute).p(px(S_3)).child("No matching command"));
        }
        for (i, hit) in hits.into_iter().enumerate() {
            let id = hit.id;
            let wash = t.accent_wash;
            list = list.child(
                text(t, FS_BODY)
                    .id(("hit", i))
                    .flex()
                    .items_center()
                    .gap(px(S_3))
                    .px(px(S_3))
                    .py(px(S_2))
                    .rounded(px(FLOAT_CHIP_RADIUS))
                    .cursor_pointer()
                    .when(i == active, |d| d.bg(wash).text_color(t.accent_hot))
                    .child(div().flex_1().child(hit.label))
                    .child(text(t, FS_MICRO).text_color(t.text_mute).child(hit.group))
                    .when_some(commands::hint(cx, id), |d, k| {
                        d.child(text(t, FS_MICRO).text_color(t.text_dim).child(k))
                    })
                    .on_click(cx.listener(move |this, _, window, cx| this.run_hit(id, window, cx))),
            );
        }
        let card = div()
            .id("palette")
            .key_context(CONTEXT)
            .occlude()
            .w(px(560.))
            .mt(px(96.))
            .flex()
            .flex_col()
            .rounded(px(FLOAT_RADIUS))
            .bg(t.panel)
            .shadow(t.float_shadow.clone())
            .on_action(cx.listener(|this, _: &Up, _, cx| this.move_active(-1, cx)))
            .on_action(cx.listener(|this, _: &Down, _, cx| this.move_active(1, cx)))
            .on_action(cx.listener(|this, _: &Close, window, cx| this.close_palette(window, cx)))
            .on_action(cx.listener(|this, _: &Pick, window, cx| {
                let hits = this.hits(cx);
                let at = this.palette.as_ref().map_or(0, |p| p.active);
                if let Some(hit) = hits.get(at.min(hits.len().saturating_sub(1))) {
                    this.run_hit(hit.id, window, cx);
                }
            }))
            .child(div().px(px(S_4)).py(px(S_3)).border_b_1().border_color(t.line).child(
                Input::new(&p.input).appearance(false).bordered(false).focus_bordered(false).text_size(px(FS_BODY)),
            ))
            .child(list);
        Some(
            div()
                .id("palette-scrim")
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .occlude()
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
                .child(card.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()))
                .into_any_element(),
        )
    }
}
