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
    fn fly_to(&mut self, to: Camera, cx: &mut Context<Self>) {
        let reduce = cx.reduce_motion();
        self.motion.fly(&mut self.camera, to, reduce);
        cx.notify();
    }

    /// `cam` framing everything shown, keeping the direction it looks from.
    fn framed(&self, mut cam: Camera) -> Camera {
        if let Some((centre, radius)) = self.scene.bounds() {
            cam.fit(centre, radius);
        }
        cam
    }

    /// Frames everything shown, keeping the direction the camera looks from.
    pub fn fit_view(&mut self, cx: &mut Context<Self>) {
        let to = self.framed(self.camera.clone());
        self.fly_to(to, cx);
    }

    pub fn reset_camera(&mut self, cx: &mut Context<Self>) {
        let to = self.framed(Camera::default());
        self.fly_to(to, cx);
    }

    pub fn look_from(&mut self, view: View, cx: &mut Context<Self>) {
        let mut to = self.camera.clone();
        (to.yaw, to.pitch) = view.angles();
        let to = self.framed(to);
        self.fly_to(to, cx);
    }
}
