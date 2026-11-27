//! Where the Parameters panel sits: in the gap between the rail and the History card, 560 to 720 px wide as in
//! FundaCAD 1, and over the cards only when the window leaves no room for it.

use crate::theme::FLOAT_GAP;

/// Past the Items card and the rail with its labels.
pub(in crate::shell) const LEFT_CLEAR: f32 = 468.;
/// Clear of the History card and the view controls.
pub(in crate::shell) const RIGHT_CLEAR: f32 = 372.;
const MIN_W: f32 = 560.;
const MAX_W: f32 = 720.;

/// The panel's left edge and width in a window `window_w` wide, with `right_card` px more of cards beside History.
pub fn place(window_w: f32, right_card: f32) -> (f32, f32) {
    let right = RIGHT_CLEAR + if right_card > 0. { right_card + FLOAT_GAP } else { 0. };
    let free = window_w - LEFT_CLEAR - right;
    let w = free.clamp(MIN_W, MAX_W).min(window_w - 2. * FLOAT_GAP).max(0.);
    let centre = LEFT_CLEAR + free / 2.;
    let left = (centre - w / 2.).min(window_w - FLOAT_GAP - w).max(FLOAT_GAP);
    (left, w)
}

#[cfg(test)]
mod tests;
