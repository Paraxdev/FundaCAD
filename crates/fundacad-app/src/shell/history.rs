use gpui::prelude::FluentBuilder as _;
use gpui::*;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::tooltip::Tooltip;

use super::history_menu::DragRow;
use super::timeline::{self, FieldKind};
use super::Shell;
use crate::document::{Feature, Health};
use crate::i18n::{self, tr};
use crate::theme::{
    Rgb, Theme, FLOAT_CHIP_RADIUS, FLOAT_GAP, FLOAT_RADIUS, FS_BODY, FS_MICRO, MONO_FONT, R_MD, R_PILL, S_0, S_1, S_2, S_3,
    W_SEMIBOLD,
};
use crate::motion::{self, mix, row_bg};
use crate::timeline::chips::{self, Marks};
use crate::timeline::rows::Rows;
use crate::timeline::{self as steps, deps, labels};
use crate::ui::{float_group, icon, icon_button, text};

pub(super) const WIDTH: f32 = 288.;
const ROW: f32 = 34.;

struct Row<'a> {
    i: usize,
    id: &'a str,
    f: &'a Feature,
    name: SharedString,
    marks: Marks,
    open: bool,
    /// Related to the viewport pick while the filter is off.
    lit: bool,
}

impl Shell {
    pub(super) fn history_card(&self, t: &Theme, window: &Window, cx: &mut Context<Self>) -> Div {
        let doc = &self.doc;
        let (back, forward) = (doc.can_step_back(), doc.can_step_forward());
        let m = doc.marker;
        let transport = div().flex().gap(px(S_0)).px(px(S_3)).pb(px(S_2)).children(
            [
                ("skipStart", back, 0),
                ("stepBack", back, m.saturating_sub(1)),
                ("stepForward", forward, m + 1),
                ("skipEnd", forward, doc.features.len()),
            ]
            .map(|(name, on, to)| {
                icon_button(t, name, name, 24., 12., t.text_mute).rounded(px(4.)).map(|d| {
                    if on {
                        d.bg(t.float_chip_bg).on_click(cx.listener(move |this, _, _, cx| this.roll_to(to, cx)))
                    } else {
                        d.opacity(0.4)
                    }
                })
            }),
        );
        let ids = self.row_ids();
        let fc = self.source.is_some();
        let source = &*self.timeline.doc;
        let seeds = self.related_seeds();
        let shown = if fc { timeline::shown(source, &seeds, self.timeline.related_off) } else { ids.clone() };
        let related = if fc { timeline::related(source, &seeds) } else { None };
        let marks = if fc { chips::marks(source, self.viewport.read(cx).feature_issues()) } else { Vec::new() };
        let names: Vec<SharedString> = if fc {
            let all = steps::features(source);
            all.iter().map(|f| labels::numbered(f, &all).into()).collect()
        } else {
            doc.features.iter().map(|f| f.name.clone()).collect()
        };
        let open = self.open_step();
        let mut list =
            div().id("history-steps").flex().flex_col().min_h_0().overflow_y_scroll().px(px(S_2)).pb(px(S_2));
        let reveal = self.timeline.reveal.take();
        let mut drawn = 0;
        for (i, f) in self.doc.features.iter().enumerate() {
            if i == m {
                list = list.child(marker(t));
                drawn += 1;
            }
            let Some(id) = ids.get(i).filter(|id| shown.contains(id)) else { continue };
            if reveal.as_deref() == Some(id.as_str()) {
                self.timeline.list.scroll_to_item(drawn);
            }
            let row = Row {
                i,
                id,
                f,
                name: names.get(i).cloned().unwrap_or_else(|| f.name.clone()),
                marks: marks.get(i).cloned().unwrap_or_default(),
                open: open == Some(i),
                lit: self.timeline.related_off && related.as_ref().is_some_and(|r| r.contains(id)),
            };
            list = list.child(self.step(t, row, cx));
            drawn += 1;
            if let Some(field) = self.timeline.field.as_ref().filter(|x| x.id == *id && x.kind == FieldKind::Note) {
                list = list.child(row_field(t, &field.input, cx).ml(px(S_3 + 18.)).mb(px(S_1)));
                drawn += 1;
            }
            if let Some(rows) = self.inspector(t, i, window, cx) {
                list = list.child(rows);
                drawn += 1;
            }
        }
        if m >= self.doc.features.len() {
            list = list.child(marker(t));
        }
        let list = list.track_scroll(&self.timeline.list);

        // `#timeline { background: var(--panel) }` outranks `.float-card` in the Vue cascade, so History is opaque.
        crate::ui::solid_card(t)
            .bg(t.panel)
            .w(px(WIDTH))
            .max_h_full()
            .child(self.history_head(t, related.map(|r| r.len()), &marks, cx))
            .child(transport)
            .child(list)
    }

    /// `.float-card-head` with the related filter and the failed count, as in TimelineBar.vue.
    fn history_head(&self, t: &Theme, related: Option<usize>, marks: &[Marks], cx: &mut Context<Self>) -> Div {
        let failed = marks.iter().filter(|m| m.failed.is_some()).count();
        let on = !self.timeline.related_off;
        let pill = |id: &'static str| {
            text(t, FS_MICRO)
                .id(id)
                .h(px(22.))
                .px(px(S_2))
                .flex()
                .items_center()
                .gap(px(S_1))
                .rounded(px(R_PILL))
                .font_weight(W_SEMIBOLD)
                .whitespace_nowrap()
        };
        let related = related.map(|n| {
            let tip = i18n::t(if on { "history.related.on" } else { "history.related.off" });
            pill("history-related")
                .map(|d| {
                    if on {
                        d.bg(t.accent_wash).text_color(t.accent_hot)
                    } else {
                        d.bg(t.float_chip_bg).text_color(t.text_dim)
                    }
                })
                .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.timeline.related_off = !this.timeline.related_off;
                    cx.notify();
                }))
                .child(tr!("history.related.chip", n = n))
        });
        let errors = (failed > 0).then(|| {
            pill("history-errors")
                .bg(t.error_tint)
                .text_color(t.error)
                .tooltip(|window, cx| Tooltip::new(i18n::t("history.errors.tip")).build(window, cx))
                .on_click(cx.listener(|this, _, _, cx| this.next_failed(cx)))
                .child(icon("warning", 11., t.error))
                .child(failed.to_string())
        });
        div()
            .flex()
            .items_center()
            .gap(px(S_2))
            .pt(px(10.))
            .pr(px(10.))
            .pb(px(6.))
            .pl(px(14.))
            .child(text(t, FS_BODY).flex_1().font_weight(W_SEMIBOLD).child(i18n::t("history.title")))
            .children(related)
            .children(errors)
            .child(icon_button(t, "History-close", "close", 28., 14., t.text_mute))
    }

    fn step(&self, t: &Theme, row: Row, cx: &mut Context<Self>) -> impl IntoElement {
        let Row { i, id, f, name, marks, open, lit } = row;
        let picked = self.timeline.rows.has(id);
        let colour = match f.health {
            _ if marks.failed.is_some() => t.error,
            Health::Error => t.error,
            Health::Warning => t.warn,
            Health::Ok if picked => t.accent_hot,
            Health::Ok => t.text,
        };
        let hover = t.raised;
        // `color-mix(in srgb, var(--accent) 16%, transparent)` in _glass.scss, no token carries it.
        let selected = t.accent.fade(0.16);
        let suppressed = marks.suppressed || f.suppressed;
        let fade = step_opacity(i >= self.doc.marker, suppressed);
        let bar = if picked { Some(t.accent_hot) } else { lit.then_some(t.accent) };
        let fc = self.source.is_some();
        let renaming = self.timeline.field.as_ref().filter(|x| x.id == id && x.kind == FieldKind::Rename);
        let tip: SharedString =
            steps::features(&self.timeline.doc).get(i).map(|g| chips::tooltip(g, i, &marks)).unwrap_or_default().into();
        let (key, menu_key, drop_key, over_key) = (id.to_owned(), id.to_owned(), id.to_owned(), id.to_owned());
        let doc = self.timeline.doc.clone();
        let (wash, refuse) = (t.accent_wash, t.error_tint);
        let label = match renaming {
            Some(field) => row_field(t, &field.input, cx).flex_1().min_w_0().into_any_element(),
            None => text(t, FS_BODY)
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(colour)
                .when(suppressed, |d| d.line_through())
                .child(name.clone())
                .into_any_element(),
        };
        let flag = match (&marks.failed, &marks.warning, f.health) {
            (Some(_), _, _) | (None, None, Health::Error) => Some(icon("error", 14., t.error)),
            (None, Some(_), _) | (None, None, Health::Warning) => Some(icon("warning", 14., t.warn)),
            (None, None, Health::Ok) => None,
        };
        let el = div()
            .id(("step", i))
            .relative()
            .h(px(ROW))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(S_2))
            .rounded(px(FLOAT_CHIP_RADIUS))
            .text_color(colour)
            .when(fade < 1., |d| d.opacity(fade))
            .when_some(bar, |d, bar| {
                d.child(div().absolute().left_0().top(px(8.)).bottom(px(8.)).w(px(3.)).rounded(px(R_PILL)).bg(bar))
            })
            .on_click(cx.listener(move |this, ev, window, cx| this.click_row(&key, ev, window, cx)))
            .when(fc, |d| {
                d.on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |this, ev: &MouseDownEvent, _, cx| this.open_menu(&menu_key, ev.position, cx)),
                )
                .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                .when(renaming.is_none(), |d| {
                    d.on_drag(DragRow { id: id.to_owned(), glyph: f.glyph, name: name.clone() }, |row, _, _, cx| {
                        cx.new(|_| row.clone())
                    })
                })
                .drag_over::<DragRow>(move |s, row, _, _| {
                    if row.id == over_key {
                        s
                    } else if deps::can_move(&doc, &row.id, i).is_ok() {
                        s.bg(wash)
                    } else {
                        s.bg(refuse)
                    }
                })
                .on_drop(cx.listener(move |this, row: &DragRow, _, cx| {
                    if row.id != drop_key {
                        this.move_row(row.id.clone(), i, cx);
                    }
                }))
            })
            .child(icon(f.glyph, 18., colour))
            .child(label)
            .when(marks.note.is_some(), |d| d.child(icon("text", 12., t.text_mute)))
            .when(marks.file.is_some(), |d| d.child(icon("import", 12., t.text_mute)))
            .when(suppressed, |d| d.child(icon("hidden", 12., t.text_mute)))
            .children(flag)
            .child(icon(if open { "caretDown" } else { "caretRight" }, 12., t.text_mute));
        row_bg(("step-bg", i), el, picked, hover, selected)
    }

    pub(super) fn view_controls(&self, t: &Theme) -> Div {
        let button = |name: &'static str, on: bool| {
            let (hover, text_hover, dim, hot) = (t.raised, t.text, t.text_dim, t.accent_hot);
            let el = div().id(name).size(px(40.)).flex().items_center().justify_center().rounded(px(FLOAT_RADIUS - 4.));
            let wash = t.accent_wash;
            motion::hover(SharedString::from(format!("view-bg-{name}")), el, move |d, m| {
                let lift = m.hover * (1. - m.on);
                d.bg(mix(mix(Rgb::TRANSPARENT, hover, lift), wash, m.on))
                    .child(icon(name, 18., mix(mix(dim, text_hover, lift), hot, m.on)))
            })
            .on(on)
        };
        let grid = div()
            .h(px(32.))
            .flex()
            .items_center()
            .justify_center()
            .font_family(MONO_FONT)
            .text_size(px(FS_MICRO))
            .font_weight(W_SEMIBOLD)
            .text_color(t.text_dim)
            .child("10mm");
        div()
            .flex()
            .flex_col()
            .gap(px(FLOAT_GAP))
            .child(
                float_group(t)
                    .child(button("magnet", false))
                    .child(grid)
                    .child(button("views", false))
                    .child(button("view-reset", false)),
            )
            .child(
                float_group(t)
                    .child(button("view-matcap", false))
                    .child(button("view-realtime", true))
                    .child(button("view-pathtraced", false)),
            )
            .child(
                float_group(t)
                    .child(button("shaded", false))
                    .child(button("camera", false))
                    .child(button("versions", false))
                    .child(button("history", true)),
            )
            .child(float_group(t).child(
                button("bug", false).on_click(|_, window, cx| crate::commands::run("report-problem", window, cx)),
            ))
    }
}

impl Shell {
    /// The one picked step, whose values show under it.
    pub(super) fn open_step(&self) -> Option<usize> {
        let id = self.timeline.rows.sole()?;
        self.row_ids().iter().position(|r| r == id)
    }

    /// Picks the next failed step in turn, as jumpToNextError.
    fn next_failed(&mut self, cx: &mut Context<Self>) {
        let doc = self.timeline.doc.clone();
        let marks = chips::marks(&doc, self.viewport.read(cx).feature_issues());
        let failed: Vec<String> =
            steps::ids(&doc).into_iter().zip(marks).filter(|(_, m)| m.failed.is_some()).map(|(id, _)| id).collect();
        if failed.is_empty() {
            return;
        }
        let id = failed[self.timeline.err_cycle % failed.len()].clone();
        self.timeline.err_cycle += 1;
        self.timeline.rows = Rows { keys: vec![id.clone()], anchor: Some(id.clone()) };
        self.timeline.reveal.set(Some(id));
        cx.notify();
    }
}

/// The rename or note field of a row, `.t-rename` in TimelineBar.vue.
fn row_field(t: &Theme, input: &Entity<InputState>, cx: &mut Context<Shell>) -> Div {
    div()
        .h(px(26.))
        .px(px(S_2))
        .flex()
        .items_center()
        .rounded(px(R_MD))
        .bg(t.field_bg)
        .border_1()
        .border_color(t.accent)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
            if ev.keystroke.key == "escape" {
                this.close_field(false, window, cx);
                cx.stop_propagation();
            }
        }))
        .child(Input::new(input).appearance(false).bordered(false).focus_bordered(false).text_size(px(FS_BODY)).p_0())
}

/// The rollback marker, between the last step that is played and the first that is not.
fn marker(t: &Theme) -> Div {
    div()
        .h(px(14.))
        .flex_none()
        .relative()
        .mx(px(2.))
        .child(div().absolute().left_0().right_0().top(px(6.)).h(px(2.)).rounded(px(1.)).bg(t.accent))
        .child(div().absolute().left_0().top(px(2.)).w(px(13.)).h(px(10.)).rounded(px(2.)).bg(t.accent))
}

/// `.suppressed` comes after `.rolled` in _timeline.scss, so a suppressed step past the marker shows at 0.6.
fn step_opacity(rolled: bool, suppressed: bool) -> f32 {
    if suppressed {
        0.6
    } else if rolled {
        0.38
    } else {
        1.
    }
}

/// A parameter value without trailing zeros, as the Vue fields print it.
pub(super) fn format_value(v: f64) -> String {
    if !v.is_finite() {
        return v.to_string();
    }
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0" } else { s }.to_string()
}

#[cfg(test)]
mod tests {
    use super::{format_value, step_opacity};

    #[test]
    fn values_drop_trailing_zeros() {
        assert_eq!(format_value(10.), "10");
        assert_eq!(format_value(2.5), "2.5");
        assert_eq!(format_value(0.125), "0.125");
        assert_eq!(format_value(-2.5), "-2.5");
        assert_eq!(format_value(0.0004), "0");
        assert_eq!(format_value(-0.0004), "0");
        assert_eq!(format_value(f64::NAN), "NaN");
    }

    #[test]
    fn suppressed_outranks_rolled_back_as_in_the_vue_cascade() {
        assert_eq!(step_opacity(true, false), 0.38);
        assert_eq!(step_opacity(true, true), 0.6);
        assert_eq!(step_opacity(false, true), 0.6);
        assert_eq!(step_opacity(false, false), 1.);
    }
}
