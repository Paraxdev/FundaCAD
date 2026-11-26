//! Where the Parameters panel sits: in the gap between the rail and the History card, 560 to 720 px wide as in
//! FundaCAD 1, and over the cards only when the window leaves no room for it.

use crate::theme::FLOAT_GAP;

/// Past the Items card and the rail with its labels.
const LEFT_CLEAR: f32 = 468.;
/// Clear of the History card and the view controls.
const RIGHT_CLEAR: f32 = 372.;
const MIN_W: f32 = 560.;
const MAX_W: f32 = 720.;

/// The panel's left edge and width in a window `window_w` wide.
pub fn place(window_w: f32) -> (f32, f32) {
    let free = window_w - LEFT_CLEAR - RIGHT_CLEAR;
    let w = free.clamp(MIN_W, MAX_W).min(window_w - 2. * FLOAT_GAP).max(0.);
    let centre = LEFT_CLEAR + free / 2.;
    let left = (centre - w / 2.).min(window_w - FLOAT_GAP - w).max(FLOAT_GAP);
    (left, w)
}

#[cfg(test)]
mod tests;
