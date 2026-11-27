//! Where the Parameters panel and an inspect card sit, as FundaCAD 1's panelStack placed its panels: in the stretch
//! between the rail labels and the right column, capped to that stretch rather than sliding under a card. The panel
//! takes the first stretch its 560 px fit, beside the inspect card or on the shelf under it, else the wider one.

use std::cell::Cell;

use crate::theme::FLOAT_GAP;

/// Past the Items card and the rail with its labels.
pub(in crate::shell) const LEFT_CLEAR: f32 = 468.;
/// Clear of the History card and the view controls.
pub(in crate::shell) const RIGHT_CLEAR: f32 = 372.;
const MIN_W: f32 = 560.;
const MAX_W: f32 = 720.;
/// The least the panel shrinks to, its body scrolls sideways under its rows' width.
const LEAST_W: f32 = 200.;
const CARD_W: f32 = 300.;
/// FundaCAD 1's .measure-panel min-width.
const CARD_LEAST: f32 = 180.;
/// The least height the shelf under the card must leave, enough for the head and a row or two of the body.
const SHELF_LEAST_H: f32 = 160.;

thread_local! {
    static CARD_H: Cell<Option<f32>> = const { Cell::new(None) };
}

/// The inspect card's width in a window `window_w` wide, left of the view controls and clear of the rail labels.
pub fn card_w(window_w: f32) -> f32 {
    (window_w - LEFT_CLEAR - RIGHT_CLEAR).clamp(CARD_LEAST, CARD_W)
}

/// The inspect card's height as last painted, so the panel can take the shelf under it. Returns whether it changed.
pub(in crate::shell) fn set_card_h(h: Option<f32>) -> bool {
    CARD_H.with(|c| c.replace(h) != h)
}

pub(in crate::shell) fn card_h() -> Option<f32> {
    CARD_H.with(Cell::get)
}

/// The panel's left edge, top and width in a window `window_w` wide, with an inspect card `card` px wide and
/// `card_h` tall (once painted) left of the view controls, over a stage `stage_h` tall down to the status line.
pub fn place(window_w: f32, stage_h: f32, card: f32, card_h: Option<f32>) -> (f32, f32, f32) {
    let beside = RIGHT_CLEAR + if card > 0. { card + FLOAT_GAP } else { 0. };
    let mut spans = vec![(FLOAT_GAP, window_w - LEFT_CLEAR - beside)];
    if let (true, Some(h)) = (card > 0., card_h) {
        let top = 2. * FLOAT_GAP + h;
        if stage_h - top - FLOAT_GAP >= SHELF_LEAST_H {
            spans.push((top, window_w - LEFT_CLEAR - RIGHT_CLEAR));
        }
    }
    let widest = spans.iter().copied().fold(spans[0], |w, s| if s.1 > w.1 { s } else { w });
    let (top, free) = spans.into_iter().find(|s| s.1 >= MIN_W).unwrap_or(widest);
    let w = free.clamp(LEAST_W, MAX_W).min(window_w - 2. * FLOAT_GAP).max(0.);
    let centre = LEFT_CLEAR + free / 2.;
    let left = (centre - w / 2.).min(window_w - FLOAT_GAP - w).max(FLOAT_GAP);
    (left, top, w)
}

#[cfg(test)]
mod tests;
