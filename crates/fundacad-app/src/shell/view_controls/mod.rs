//! The view controls column at the stage's right edge, FundaCAD 1's ViewportControls.vue: snapping, grid and
//! units, views and projection, the three view modes, and the Display popover with shading, overlays, X-ray and
//! wireframe.

#[cfg(test)]
mod tests;
pub mod units;
mod widgets;

use std::time::{Duration, Instant};

use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::tooltip::Tooltip;

use super::Shell;
use crate::commands::{self, register, Group};
use crate::motion::{self, mix};
use crate::selection::Filter;
use crate::theme::{Rgb, Theme, FLOAT_GAP, FLOAT_RADIUS, FS_MICRO, MONO_FONT, S_1, S_2, W_SEMIBOLD};
use crate::ui::{float_group, icon};
use crate::viewport::{Display, Matcap, OverlayKind, Projection, ViewMode, Viewport};
use units::Unit;
use widgets::{choice, note, popover, rule, section, swatch, toggle, wide};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Pop {
    Snap,
    Grid,
    Views,
    Display,
}

impl Pop {
    fn key(self) -> &'static str {
        match self {
            Pop::Snap => "snap",
            Pop::Grid => "grid",
            Pop::Views => "views",
            Pop::Display => "display",
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct State {
    open: Option<Pop>,
    appearance: bool,
    /// The popover a press outside just closed: the click that follows on its own button must not open it again.
    closed: Option<(Pop, Instant)>,
    pub(super) history_hidden: bool,
}

impl State {
    /// What a click on `pop`'s button does to the open popover.
    pub(super) fn toggle(&mut self, pop: Pop, now: Instant) {
        let just_closed = self.closed.take().is_some_and(|(p, at)| p == pop && now - at < Duration::from_millis(400));
        self.open = if just_closed || self.open == Some(pop) { None } else { Some(pop) };
    }

    pub(super) fn close_outside(&mut self, now: Instant) {
        if let Some(p) = self.open.take() {
            self.closed = Some((p, now));
        }
    }

    pub(super) fn is_open(&self, pop: Pop) -> bool {
        self.open == Some(pop)
    }
}

const VIEWS: [(&str, &str); 6] =
    [("top", "Top"), ("bottom", "Bottom"), ("front", "Front"), ("back", "Back"), ("right", "Right"), ("left", "Left")];
const FILTERS: [(Filter, &str, Option<&str>); 3] = [
    (Filter::Auto, "Body, then face", Some("click a body to take it, click it again for a face or edge")),
    (Filter::Faces, "Faces", None),
    (Filter::Bodies, "Bodies", None),
];

/// The view commands the column and its keys share.
pub(super) fn install(viewport: &Entity<Viewport>, cx: &mut App) {
    let edits: [(&'static str, &'static str, fn(&mut Display)); 5] = [
        ("toggle-xray", "X-Ray", |d| d.xray = !d.xray),
        ("toggle-wireframe", "Wireframe", |d| d.wireframe = !d.wireframe),
        ("clean-view", "Clean view", |d| d.overlays.on = !d.overlays.on),
        ("viewmode-cycle", "Next view mode", |d| d.view_mode = d.view_mode.step(false)),
        ("viewmode-cycle-back", "Previous view mode", |d| d.view_mode = d.view_mode.step(true)),
    ];
    for (id, label, edit) in edits {
        let v = viewport.clone();
        register(cx, id, label, Group::View, move |_, cx| v.update(cx, |v, cx| edit_display(v, edit, cx)));
    }
}

fn edit_display(v: &mut Viewport, f: impl FnOnce(&mut Display), cx: &mut Context<Viewport>) {
    let mut d = v.display().clone();
    f(&mut d);
    v.set_display(d, cx);
}

impl Shell {
    fn display(&self, cx: &mut Context<Self>, f: impl FnOnce(&mut Display)) {
        self.viewport.update(cx, |v, cx| edit_display(v, f, cx));
    }

    fn pop_button(&self, t: &Theme, pop: Pop, glyph: &'static str, tip: &'static str, cx: &mut Context<Self>) -> Stateful<Div> {
        let lit = self.view_ctl.is_open(pop) || (pop == Pop::Display && self.lit_display(cx));
        column_button(t, glyph, tip, lit).on_click(cx.listener(move |this, _, _, cx| {
            this.view_ctl.toggle(pop, Instant::now());
            cx.notify();
        }))
    }

    fn lit_display(&self, cx: &App) -> bool {
        let d = self.viewport.read(cx).display();
        d.xray || d.wireframe
    }

    fn close_pop(e: Entity<Self>) -> impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static {
        move |_, _, cx| {
            e.update(cx, |s, cx| {
                s.view_ctl.close_outside(Instant::now());
                cx.notify();
            })
        }
    }

    pub(super) fn view_controls(&self, t: &Theme, cx: &mut Context<Self>) -> Div {
        let vp = self.viewport.read(cx);
        let unit = units::unit();
        let grid_label = units::fmt_length(vp.grid_step_mm(), unit);
        let mode = vp.display().view_mode;

        let grid = div()
            .id("grid")
            .h(px(32.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(FLOAT_RADIUS - 4.))
            .font_family(MONO_FONT)
            .text_size(px(FS_MICRO))
            .font_weight(W_SEMIBOLD)
            .cursor_pointer()
            .text_color(if self.view_ctl.is_open(Pop::Grid) { t.accent_hot } else { t.text_dim })
            .when(self.view_ctl.is_open(Pop::Grid), |d| d.bg(t.accent_wash))
            .hover(|s| s.bg(t.raised))
            .tooltip(|window, cx| Tooltip::new("Grid and units").build(window, cx))
            .on_click(cx.listener(|this, _, _, cx| {
                this.view_ctl.toggle(Pop::Grid, Instant::now());
                cx.notify();
            }))
            .child(grid_label.replace(' ', ""));

        let me = cx.entity();
        let anchored = |button: AnyElement, pop: Pop, body: Option<Vec<AnyElement>>| {
            div().relative().child(button).children(body.map(|rows| popover(t, pop.key(), Self::close_pop(me.clone()), rows)))
        };
        let open = |p: Pop| self.view_ctl.is_open(p);
        let snap = anchored(
            self.pop_button(t, Pop::Snap, "magnet", "Snapping", cx).into_any_element(),
            Pop::Snap,
            open(Pop::Snap).then(|| self.snap_rows(t, cx)),
        );
        let grid = anchored(grid.into_any_element(), Pop::Grid, open(Pop::Grid).then(|| self.grid_rows(t, unit, cx)));
        let views = anchored(
            self.pop_button(t, Pop::Views, "views", "Views", cx).into_any_element(),
            Pop::Views,
            open(Pop::Views).then(|| self.view_rows(t, cx)),
        );
        let display = anchored(
            self.pop_button(t, Pop::Display, "shaded", "Display", cx).into_any_element(),
            Pop::Display,
            open(Pop::Display).then(|| self.display_rows(t, cx)),
        );
        let reset = column_button(t, "view-reset", "Reset camera (Shift+Home)", false)
            .on_click(|_, window, cx| commands::run("reset-camera", window, cx));

        let modes = ViewMode::ALL.map(|m| {
            column_button(t, m.icon(), m.label(), mode == m)
                .on_click(cx.listener(move |this, _, _, cx| this.display(cx, |d| d.view_mode = m)))
        });
        let sketching = self.viewport.read(cx).sketching();
        let history_on = !self.view_ctl.history_hidden;
        let history_tip = if sketching { "Sketch options (Ctrl+Alt+H)" } else { "History (Ctrl+Alt+H)" };
        div()
            .flex()
            .flex_col()
            .gap(px(FLOAT_GAP))
            .child(float_group(t).child(snap).child(grid).child(views).child(reset))
            .child(float_group(t).children(modes))
            .child(
                float_group(t)
                    .child(display)
                    // Screenshot and Versions wait on an image export and the versions panel.
                    .child(column_button(t, "camera", "Screenshot", false).opacity(0.4))
                    .child(column_button(t, "versions", "Versions", false).opacity(0.4))
                    .child(column_button(t, "history", history_tip, history_on).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.view_ctl.history_hidden = !this.view_ctl.history_hidden;
                            cx.notify();
                        },
                    ))),
            )
            .child(float_group(t).child(
                column_button(t, "bug", "Report a problem", false)
                    .on_click(|_, window, cx| commands::run("report-problem", window, cx)),
            ))
    }

    fn snap_rows(&self, t: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let s = self.viewport.read(cx).display().sketch;
        let flip = |id: &'static str, label: &'static str, on: bool, f: fn(&mut Display)| {
            toggle(t, id, label, on, true)
                .on_click(cx.listener(move |this, _, _, cx| this.display(cx, f)))
                .into_any_element()
        };
        vec![
            section(t, "Snap to"),
            flip("snap-grid", "Grid", s.snap, |d| d.sketch.snap = !d.sketch.snap),
            rule(t),
            section(t, "Show"),
            flip("show-grid", "Sketch grid", s.grid, |d| d.sketch.grid = !d.sketch.grid),
            flip("show-constraints", "Constraints", s.constraints, |d| d.sketch.constraints = !d.sketch.constraints),
            flip("show-dimensions", "Dimensions", s.dimensions, |d| d.sketch.dimensions = !d.sketch.dimensions),
        ]
    }

    fn grid_rows(&self, t: &Theme, unit: Unit, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let step = units::fmt_length(self.viewport.read(cx).grid_step_mm(), unit);
        let mut rows = vec![section(t, "Units")];
        rows.extend(Unit::ALL.map(|u| {
            choice(t, u.id(), u.label(), None, u == unit, true)
                .on_click(cx.listener(move |_, _, _, cx| {
                    units::set_unit(u);
                    cx.notify();
                }))
                .into_any_element()
        }));
        rows.push(rule(t));
        rows.push(section(t, "Grid"));
        rows.push(note(
            t,
            format!(
                "One square is {step} at this zoom. Zoom in for a finer grid, and the move gizmo steps by a tenth of a \
                 square."
            ),
        ));
        rows
    }

    fn view_rows(&self, t: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let appearance = self.view_ctl.appearance;
        let tab = |id: &'static str, label: &'static str, to: bool| {
            widgets::tab(t, id, label, appearance == to).on_click(cx.listener(move |this, _, _, cx| {
                this.view_ctl.appearance = to;
                cx.notify();
            }))
        };
        let tabs_row = widgets::tab_bar(t)
            .child(tab("tab-views", "Views", false))
            .child(tab("tab-appearance", "Appearance", true))
            .into_any_element();
        let mut rows = vec![tabs_row];
        if !appearance {
            let run = |id: &'static str| move |_: &ClickEvent, window: &mut Window, cx: &mut App| commands::run(id, window, cx);
            rows.push(wide(t, "view-default", Some("view-iso"), "Default View", false).on_click(run("iso")).into_any_element());
            rows.push(div().h(px(S_1)).into_any_element());
            rows.push(wide(t, "view-fit", Some("view-fit"), "Fit to Model", true).on_click(run("fit")).into_any_element());
            rows.push(rule(t));
            rows.extend(VIEWS.map(|(id, label)| {
                let glyph = match id {
                    "top" => "view-top",
                    "bottom" => "view-bottom",
                    "front" => "view-front",
                    "back" => "view-back",
                    "right" => "view-right",
                    _ => "view-left",
                };
                choice_icon(t, id, glyph, label).on_click(run(id)).into_any_element()
            }));
        } else {
            let (projection, filter) = {
                let vp = self.viewport.read(cx);
                (vp.display().projection, vp.filter())
            };
            rows.push(section(t, "Projection"));
            rows.extend(Projection::ALL.map(|p| {
                choice(t, SharedString::from(format!("proj-{}", p.label())), p.label(), p.hint(), p == projection, true)
                    .on_click(cx.listener(move |this, _, _, cx| this.display(cx, |d| d.projection = p)))
                    .into_any_element()
            }));
            rows.push(rule(t));
            rows.push(section(t, "Select"));
            rows.extend(FILTERS.map(|(f, label, hint)| {
                choice(t, SharedString::from(format!("sel-{label}")), label, hint, f == filter, true)
                    .on_click(cx.listener(move |this, _, _, cx| this.viewport.update(cx, |v, cx| v.set_filter(f, cx))))
                    .into_any_element()
            }));
        }
        rows
    }

    fn display_rows(&self, t: &Theme, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let d = self.viewport.read(cx).display().clone();
        let mut rows = vec![section(t, "Shading")];
        rows.extend(ViewMode::ALL.map(|m| {
            choice(t, m.icon(), m.label(), None, m == d.view_mode, true)
                .on_click(cx.listener(move |this, _, _, cx| this.display(cx, |d| d.view_mode = m)))
                .into_any_element()
        }));
        if d.view_mode == ViewMode::Matcap {
            let balls = Matcap::ALL.map(|m| {
                let id: &'static str = match m {
                    Matcap::Studio => "matcap-studio",
                    Matcap::Clay => "matcap-clay",
                    Matcap::Metal => "matcap-metal",
                    Matcap::Wax => "matcap-wax",
                };
                let tip = m.label();
                swatch(t, id, m.swatch(), m == d.matcap)
                    .tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
                    .on_click(cx.listener(move |this, _, _, cx| this.display(cx, |d| d.matcap = m)))
            });
            rows.push(div().flex().gap(px(S_2)).px(px(S_2)).py(px(S_1)).children(balls).into_any_element());
            rows.push(
                toggle(t, "matcap-tint", "Tint with body colors", d.matcap_tint, true)
                    .on_click(cx.listener(|this, _, _, cx| this.display(cx, |d| d.matcap_tint = !d.matcap_tint)))
                    .into_any_element(),
            );
        }
        rows.push(rule(t));
        rows.push(section(t, "Overlays"));
        rows.push(
            toggle(t, "overlay-all", "Show overlays", d.overlays.on, true)
                .on_click(cx.listener(|this, _, _, cx| this.display(cx, |d| d.overlays.on = !d.overlays.on)))
                .into_any_element(),
        );
        rows.extend(OverlayKind::ALL.map(|k| {
            let on = d.overlays.kind(k);
            let el = toggle(t, &format!("overlay-{}", k.id()), k.label(), on, d.overlays.on);
            if d.overlays.on {
                el.on_click(cx.listener(move |this, _, _, cx| this.display(cx, |d| d.overlays.set(k, !on))))
                    .into_any_element()
            } else {
                el.into_any_element()
            }
        }));
        rows.push(note(t, "A running tool still shows its gizmo, and a hidden outline still selects its edge."));
        let clean = if d.overlays.on { "Clean view" } else { "Bring overlays back" };
        rows.push(
            wide(t, "clean-view", None, clean, true)
                .on_click(|_, window, cx| commands::run("clean-view", window, cx))
                .into_any_element(),
        );
        rows.push(rule(t));
        rows.push(
            toggle(t, "xray", "X-Ray", d.xray, true)
                .on_click(|_, window, cx| commands::run("toggle-xray", window, cx))
                .into_any_element(),
        );
        rows.push(
            toggle(t, "wireframe", "Wireframe", d.wireframe, true)
                .on_click(|_, window, cx| commands::run("toggle-wireframe", window, cx))
                .into_any_element(),
        );
        rows.push(rule(t));
        rows.push(section(t, "Surface analysis"));
        // The analysis tools have no handler in this build yet, so their switches stay off and greyed.
        rows.extend(
            [("zebra", "Zebra"), ("curvature", "Curvature combs"), ("overhang", "Overhang"), ("colors", "Body colors")]
                .map(|(id, label)| toggle(t, id, label, false, false).into_any_element()),
        );
        rows
    }
}

/// A 40px button of the column, `IconButton` in the Vue app, washed with the accent while `on`.
fn column_button(t: &Theme, glyph: &'static str, tip: &'static str, on: bool) -> Stateful<Div> {
    let (hover, text_hover, dim, hot, wash) = (t.raised, t.text, t.text_dim, t.accent_hot, t.accent_wash);
    let el = div().id(glyph).size(px(40.)).flex().items_center().justify_center().rounded(px(FLOAT_RADIUS - 4.));
    let el = motion::hover(SharedString::from(format!("view-bg-{glyph}")), el, move |d, m| {
        let lift = m.hover * (1. - m.on);
        d.bg(mix(mix(Rgb::TRANSPARENT, hover, lift), wash, m.on))
            .child(icon(glyph, 18., mix(mix(dim, text_hover, lift), hot, m.on)))
    })
    .on(on);
    div().id(SharedString::from(format!("vc-{glyph}"))).child(el).tooltip(move |window, cx| Tooltip::new(tip).build(window, cx))
}

fn choice_icon(t: &Theme, id: &'static str, glyph: &'static str, label: &str) -> Stateful<Div> {
    crate::ui::text(t, crate::theme::FS_BODY)
        .id(id)
        .flex()
        .items_center()
        .gap(px(S_2))
        .h(px(t.hit(28.)))
        .px(px(S_2))
        .rounded(px(6.))
        .cursor_pointer()
        .hover(|s| s.bg(t.hover_wash))
        .child(icon(glyph, 18., t.text_dim))
        .child(label.to_string())
}
