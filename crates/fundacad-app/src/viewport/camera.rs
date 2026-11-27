use glam::{Mat4, Vec2, Vec3};

pub(super) const PITCH_LIMIT: f32 = 1.55;
const FOV_Y: f32 = 0.7;

/// An orbit camera around `target`, Z up like the engine.
#[derive(Clone, Debug, PartialEq)]
pub struct Camera {
    pub target: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self { target: Vec3::ZERO, yaw: -0.9, pitch: 0.55, distance: 3.2 }
    }
}

impl Camera {
    pub fn eye(&self) -> Vec3 {
        let dir = Vec3::new(self.pitch.cos() * self.yaw.cos(), self.pitch.cos() * self.yaw.sin(), self.pitch.sin());
        self.target + dir * self.distance
    }

    pub fn view(&self) -> Mat4 {
        Mat4::look_at_rh(self.eye(), self.target, Vec3::Z)
    }

    pub fn projection(&self, aspect: f32) -> Mat4 {
        if super::display::projection().ortho_for(self) {
            return self.ortho(aspect);
        }
        let near = (self.distance * 0.01).max(1e-4);
        Mat4::perspective_rh(FOV_Y, aspect, near, self.distance * 100.0)
    }

    /// Orthographic, sized so the orbit target keeps the scale perspective gives it, and deep enough both ways
    /// that nothing behind the eye is cut off.
    pub fn ortho(&self, aspect: f32) -> Mat4 {
        let half_h = self.distance * (FOV_Y * 0.5).tan();
        let half_w = half_h * aspect;
        Mat4::orthographic_rh(-half_w, half_w, -half_h, half_h, -self.distance * 100.0, self.distance * 100.0)
    }

    /// The world ray through `ndc` (-1..1, y up): origin on the near plane and unit direction.
    pub fn ray(&self, ndc: Vec2, aspect: f32) -> (Vec3, Vec3) {
        let inverse = (self.projection(aspect) * self.view()).inverse();
        let near = inverse.project_point3(ndc.extend(0.0));
        let far = inverse.project_point3(ndc.extend(1.0));
        (near, (far - near).normalize())
    }

    /// Orbit by a drag of `delta` logical pixels.
    pub fn orbit(&mut self, delta: Vec2) {
        self.yaw -= delta.x * 0.008;
        self.pitch = (self.pitch + delta.y * 0.008).clamp(-PITCH_LIMIT, PITCH_LIMIT);
    }

    /// The world size of one logical pixel at the orbit target, for a viewport `height` pixels tall.
    pub fn per_pixel(&self, height: f32) -> f32 {
        2.0 * self.distance * (FOV_Y * 0.5).tan() / height.max(1.0)
    }

    /// Pan so the point under the cursor follows it, for a viewport `height` logical pixels tall.
    pub fn pan(&mut self, delta: Vec2, height: f32) {
        let per_pixel = self.per_pixel(height);
        let view = self.view();
        let right = view.row(0).truncate();
        let up = view.row(1).truncate();
        self.target += (-right * delta.x + up * delta.y) * per_pixel;
    }

    /// Zoom by `steps` (positive is in) towards the cursor at `ndc` (-1..1, y up).
    pub fn zoom_at(&mut self, steps: f32, ndc: Vec2, aspect: f32) {
        let factor = 0.88f32.powf(steps);
        let half_h = self.distance * (FOV_Y * 0.5).tan();
        let view = self.view();
        let right = view.row(0).truncate();
        let up = view.row(1).truncate();
        let under_cursor = self.target + right * (ndc.x * half_h * aspect) + up * (ndc.y * half_h);
        self.target = under_cursor + (self.target - under_cursor) * factor;
        self.distance = (self.distance * factor).clamp(1e-3, 1e5);
    }

    /// Frames a bounding sphere.
    pub fn fit(&mut self, centre: Vec3, radius: f32) {
        self.target = centre;
        self.distance = radius.max(1e-3) / (FOV_Y * 0.5).sin() * 1.1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_keeps_the_point_under_the_cursor() {
        let mut cam = Camera::default();
        let aspect = 1.5;
        let ndc = Vec2::new(0.4, -0.3);
        let half_h = cam.distance * (FOV_Y * 0.5).tan();
        let view = cam.view();
        let before =
            cam.target + view.row(0).truncate() * (ndc.x * half_h * aspect) + view.row(1).truncate() * (ndc.y * half_h);
        cam.zoom_at(3.0, ndc, aspect);
        let half_h = cam.distance * (FOV_Y * 0.5).tan();
        let view = cam.view();
        let after =
            cam.target + view.row(0).truncate() * (ndc.x * half_h * aspect) + view.row(1).truncate() * (ndc.y * half_h);
        assert!((before - after).length() < 1e-4, "{before} vs {after}");
    }

    #[test]
    fn the_centre_ray_points_at_the_target() {
        let cam = Camera::default();
        let (origin, dir) = cam.ray(Vec2::ZERO, 1.5);
        let to_target = (cam.target - origin).normalize();
        assert!(dir.dot(to_target) > 0.9999, "{dir} vs {to_target}");
    }

    #[test]
    fn pitch_stops_short_of_the_poles() {
        let mut cam = Camera::default();
        cam.orbit(Vec2::new(0.0, 10_000.0));
        assert!(cam.pitch <= PITCH_LIMIT);
        assert!(cam.view().is_finite());
    }
}
