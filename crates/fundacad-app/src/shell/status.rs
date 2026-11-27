//! The status line along the bottom middle, laid out as FundaCAD 1's frame-rate readout (useClearSpan): in the stretch
//! of its row the rail labels and the right column leave free, so it never runs under a card.

use gpui::*;

use super::params::place::{LEFT_CLEAR, RIGHT_CLEAR};
use crate::theme::{line_normal, Theme, FLOAT_GAP, FS_SMALL, S_1, S_3};
use crate::ui::{chip, text};

const MAX_W: f32 = 560.;

/// How far up from the bottom of the window the status line reaches, with a gap above it. The toast stack starts
/// no lower, as FundaCAD 1's did over its prompt (--prompt-clear).
pub fn reach() -> Pixels {
    px(FLOAT_GAP) + line_normal(FS_SMALL) + px(2. * S_1 + 2. + FLOAT_GAP)
}

/// The left and right insets of the free stretch in a stage `width` wide. Below `MAX_W` of room the right inset
/// gives way first, then the left, as promptInsets did.
pub fn span(width: f32) -> (f32, f32) {
    let (mut left, mut right) = (LEFT_CLEAR, RIGHT_CLEAR);
    let mut short = MAX_W.min(width - 2. * FLOAT_GAP) - (width - left - right);
    if short > 0. {
        let give = short.min(right - FLOAT_GAP);
        right -= give;
        short -= give;
        if short > 0. {
            left = (left - short).max(FLOAT_GAP);
        }
    }
    (left, right)
}

pub fn status(t: &Theme, line: String, window: &Window) -> Div {
    let (left, right) = span(window.viewport_size().width / px(1.));
    div().absolute().left(px(left)).right(px(right)).bottom(px(FLOAT_GAP)).flex().justify_center().child(
        chip(t)
            .min_w_0()
            .max_w(px(MAX_W))
            .px(px(S_3))
            .py(px(S_1))
            .child(text(t, FS_SMALL).min_w_0().truncate().text_color(t.text_dim).child(line)),
    )
}

#[cfg(test)]
mod tests {
    use super::{span, FLOAT_GAP, LEFT_CLEAR, MAX_W, RIGHT_CLEAR};

    #[test]
    fn a_wide_stage_keeps_the_line_between_the_rail_and_the_right_column() {
        assert_eq!(span(1440.), (LEFT_CLEAR, RIGHT_CLEAR));
    }

    #[test]
    fn a_small_stage_gives_way_on_the_right_first() {
        let (left, right) = span(1100.);
        assert_eq!(left, LEFT_CLEAR);
        assert_eq!(1100. - left - right, MAX_W);
        let (left, right) = span(700.);
        assert_eq!((left, right), (700. - FLOAT_GAP - MAX_W, FLOAT_GAP));
    }
}
