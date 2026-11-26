use gpui::prelude::FluentBuilder as _;
use gpui::*;

use super::items::card_head;
use super::Shell;
use crate::document::{Feature, Health};
use crate::theme::{
    Theme, FLOAT_CHIP_RADIUS, FLOAT_GAP, FLOAT_RADIUS, FS_BODY, FS_MICRO, MONO_FONT, R_PILL, S_0, S_2, S_3, W_SEMIBOLD,
};
use crate::ui::{float_group, icon, icon_button, text};

pub(super) const WIDTH: f32 = 288.;
const ROW: f32 = 34.;

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
                        d.bg(t.float_chip_bg).on_click(cx.listener(move |this, _, _, cx| {
                            this.doc.set_marker(to);
                            this.marker_moved = true;
                            cx.notify();
                        }))
                    } else {
                        d.opacity(0.4)
                    }
                })
            }),
        );
        let mut list =
            div().id("history-steps").flex().flex_col().min_h_0().overflow_y_scroll().px(px(S_2)).pb(px(S_2));
        for (i, f) in self.doc.features.iter().enumerate() {
            list = list.child(self.step(t, i, f, cx));
            list = list.children(self.inspector(t, i, window, cx));
        }
        list = list.child(marker(t));

        // `#timeline { background: var(--panel) }` outranks `.float-card` in the Vue cascade, so History is opaque.
        crate::ui::solid_card(t)
            .bg(t.panel)
            .w(px(WIDTH))
            .max_h_full()
            .child(card_head(t, "History"))
            .child(transport)
            .child(list)
    }

    fn step(&self, t: &Theme, i: usize, f: &Feature, cx: &mut Context<Self>) -> impl IntoElement {
        let on = self.open_step() == Some(i);
        let colour = match f.health {
            Health::Error => t.error,
            Health::Warning => t.warn,
            Health::Ok if on => t.accent_hot,
            Health::Ok => t.text,
        };
        let hover = t.raised;
        // `color-mix(in srgb, var(--accent) 16%, transparent)` in _glass.scss, no token carries it.
        let selected = t.accent.fade(0.16);
        let fade = step_opacity(i >= self.doc.marker, f.suppressed);
        let bar = t.accent_hot;
        div()
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
            .map(|d| if on { d.bg(selected) } else { d.hover(move |s| s.bg(hover)) })
            .when(on, |d| {
                d.child(div().absolute().left_0().top(px(8.)).bottom(px(8.)).w(px(3.)).rounded(px(R_PILL)).bg(bar))
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                this.open = toggle(this.open_step(), i);
                cx.notify();
            }))
            .child(icon(f.glyph, 18., colour))
            .child(
                text(t, FS_BODY)
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(colour)
                    .when(f.suppressed, |d| d.line_through())
                    .child(f.name.clone()),
            )
            .map(|d| match f.health {
                Health::Error => d.child(icon("error", 14., colour)),
                Health::Warning => d.child(icon("warning", 14., colour)),
                Health::Ok => d,
            })
            .child(icon(if on { "caretDown" } else { "caretRight" }, 12., t.text_mute))
    }

    pub(super) fn view_controls(&self, t: &Theme) -> Div {
        let button = |name: &'static str, on: bool| {
            let hover = t.raised;
            let text_hover = t.text;
            let glyph = icon(name, 18., if on { t.accent_hot } else { t.text_dim });
            div()
                .id(name)
                .size(px(40.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(FLOAT_RADIUS - 4.))
                .group(name)
                .map(|d| if on { d.bg(t.accent_wash) } else { d.hover(move |s| s.bg(hover)) })
                .child(if on { glyph } else { glyph.group_hover(name, move |s| s.text_color(text_hover)) })
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
            .child(float_group(t).child(button("bug", false)))
    }
}

/// The rollback marker after the last step that is played.
fn marker(t: &Theme) -> Div {
    div()
        .h(px(14.))
        .flex_none()
        .relative()
        .mx(px(2.))
        .child(div().absolute().left_0().right_0().top(px(6.)).h(px(2.)).rounded(px(1.)).bg(t.accent))
        .child(div().absolute().left_0().top(px(2.)).w(px(13.)).h(px(10.)).rounded(px(2.)).bg(t.accent))
}

impl Shell {
    /// The open step, dropped once the document no longer has it.
    pub(super) fn open_step(&self) -> Option<usize> {
        self.open.filter(|&i| i < self.doc.features.len())
    }
}

fn toggle(open: Option<usize>, i: usize) -> Option<usize> {
    if open == Some(i) {
        None
    } else {
        Some(i)
    }
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
    use super::{format_value, step_opacity, toggle};

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
    fn a_click_opens_a_step_and_a_second_closes_it() {
        assert_eq!(toggle(None, 2), Some(2));
        assert_eq!(toggle(Some(1), 2), Some(2));
        assert_eq!(toggle(Some(2), 2), None);
    }

    #[test]
    fn suppressed_outranks_rolled_back_as_in_the_vue_cascade() {
        assert_eq!(step_opacity(true, false), 0.38);
        assert_eq!(step_opacity(true, true), 0.6);
        assert_eq!(step_opacity(false, true), 0.6);
        assert_eq!(step_opacity(false, false), 1.);
    }
}
