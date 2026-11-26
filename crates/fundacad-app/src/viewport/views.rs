//! The camera commands of the View menu.

use std::f32::consts::{FRAC_PI_2, FRAC_PI_4, PI};

use gpui::Context;

use super::camera::Camera;
use super::Viewport;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Front,
    Back,
    Left,
    Right,
    Top,
    Bottom,
    Iso,
}

impl View {
    /// Yaw and pitch of the eye around the target, Z up, front looking along +Y.
    pub fn angles(self) -> (f32, f32) {
        let top = 1.55;
        match self {
            View::Front => (-FRAC_PI_2, 0.),
            View::Back => (FRAC_PI_2, 0.),
            View::Left => (PI, 0.),
            View::Right => (0., 0.),
            View::Top => (-FRAC_PI_2, top),
            View::Bottom => (-FRAC_PI_2, -top),
            View::Iso => (-FRAC_PI_4, (1f32 / 2f32.sqrt()).atan()),
        }
    }
}

impl Viewport {
    /// Frames everything shown, keeping the direction the camera looks from.
    pub fn fit_view(&mut self, cx: &mut Context<Self>) {
        if let Some((centre, radius)) = self.scene.bounds() {
            self.camera.fit(centre, radius);
            cx.notify();
        }
    }

    pub fn reset_camera(&mut self, cx: &mut Context<Self>) {
        self.camera = Camera::default();
        self.fit_view(cx);
        cx.notify();
    }

    pub fn look_from(&mut self, view: View, cx: &mut Context<Self>) {
        (self.camera.yaw, self.camera.pitch) = view.angles();
        self.fit_view(cx);
        cx.notify();
    }
}
