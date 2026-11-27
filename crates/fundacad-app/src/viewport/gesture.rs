//! The radial menu's mouse trigger, FundaCAD 1's "gesture" pointer binding: a right press with the trigger's
//! modifiers held that travels opens the ring at the press point, and the release picks. A still press stays the
//! right click menu, a right drag without the modifiers stays an orbit.

use gpui::*;

use super::Viewport;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CanvasGesture {
    Start(Point<Pixels>),
    /// The button came up here before the ring took the pointer.
    Release(Point<Pixels>),
}

impl EventEmitter<CanvasGesture> for Viewport {}

impl Viewport {
    /// A right press, true when it is the radial trigger's and must not orbit.
    pub(super) fn right_down(&mut self, e: &MouseDownEvent) -> bool {
        let gesture = crate::prefs::radial::gesture_now(&e.modifiers);
        match gesture {
            true => self.right.down_gesture(e.position),
            false => self.right.down(e.position),
        }
        gesture
    }

    /// Takes the move while a trigger press is held.
    pub(super) fn gesture_move(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) -> bool {
        if !self.right.gesture_held() {
            return false;
        }
        if e.pressed_button != Some(MouseButton::Right) {
            self.right = Default::default();
            return false;
        }
        if let Some(from) = self.right.gesture_start(e.position) {
            cx.emit(CanvasGesture::Start(from));
        }
        true
    }

    pub(super) fn gesture_up(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        let ended = self.right.gesture_up();
        if ended {
            cx.emit(CanvasGesture::Release(at));
        }
        ended
    }
}
