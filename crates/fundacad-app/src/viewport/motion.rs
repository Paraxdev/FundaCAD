//! The view's motion, after FundaCAD 1's navigator: whole pose flights eased by smootherstep for the named views, fit
//! and sketch entry, and every gesture eased onto its goal by a critically damped spring.

use std::f32::consts::PI;
use std::time::{Duration, Instant};

use glam::Vec3;

use super::camera::Camera;

pub mod selection;

/// The smooth time of eased gestures, seconds, FundaCAD 1's default.
pub const SMOOTH_TIME: f32 = 0.125;
/// Below this a move reads as a cut rather than a motion.
const MIN_FLIGHT_S: f32 = 0.18;
/// A half turn is the worst case, past this the animation becomes a wait.
const MAX_FLIGHT_S: f32 = 0.5;
/// About 1.4 degrees, smaller turns snap rather than fly.
const SNAP_TURN_RAD: f32 = 0.025;
const SETTLE_ANGLE: f32 = 1e-5;
/// Of the distance, for the target and the distance itself.
const SETTLE_SHARE: f32 = 1e-5;
/// A frame longer than this is a stall, easing over it would jump anyway.
const MAX_DT: f32 = 0.05;
const HOVER_IN_S: f32 = 0.08;
const HOVER_OUT_S: f32 = 0.14;
const SELECT_S: f32 = 0.12;

/// FUNDA_SLOW_MOTION=<factor> slows every motion of the view down, to watch or capture one mid way.
fn slow() -> f32 {
    static SLOW: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *SLOW.get_or_init(|| {
        let factor = std::env::var("FUNDA_SLOW_MOTION").ok().and_then(|v| v.parse::<f32>().ok());
        factor.filter(|f| f.is_finite() && *f >= 1.0).unwrap_or(1.0)
    })
}

/// Smootherstep: zero velocity at both ends, and unlike a spring it ends at a chosen time.
pub fn ease(t: f32) -> f32 {
    let x = t.clamp(0.0, 1.0);
    x * x * x * (x * (x * 6.0 - 15.0) + 10.0)
}

/// Into (-pi, pi].
pub fn wrap(a: f32) -> f32 {
    if !a.is_finite() {
        return 0.0;
    }
    let r = a.rem_euclid(2.0 * PI);
    if r > PI {
        r - 2.0 * PI
    } else {
        r
    }
}

/// Proportional to the turn so a small correction is not sluggish. `zoom` is the ratio of the sizes framed, 1 for none.
pub fn flight_seconds(turn: f32, zoom: f32) -> f32 {
    let t = if turn.is_finite() { turn.abs() } else { 0.0 };
    let r = if zoom.is_finite() && zoom > 0.0 { zoom } else { 1.0 };
    // log2 so 2x out and 2x in cost the same.
    let z = r.log2().abs().min(4.0);
    (MIN_FLIGHT_S + t / PI * 0.28 + z * 0.05).min(MAX_FLIGHT_S)
}

pub fn worth_flying(turn: f32, zoom: f32) -> bool {
    turn.is_finite() && zoom.is_finite() && zoom > 0.0 && (turn.abs() > SNAP_TURN_RAD || zoom.log2().abs() > 0.08)
}

fn look(c: &Camera) -> Vec3 {
    (c.target - c.eye()).normalize_or_zero()
}

/// How long a flight between two poses takes, 0 when the view is already there.
pub fn flight_duration(a: &Camera, b: &Camera) -> f32 {
    let turn = look(a).dot(look(b)).clamp(-1.0, 1.0).acos();
    let small = a.distance.min(b.distance).max(1e-9);
    let ratio = (a.distance / b.distance).max(b.distance / a.distance) * (1.0 + a.target.distance(b.target) / small);
    if worth_flying(turn, ratio) {
        flight_seconds(turn, ratio)
    } else {
        0.0
    }
}

/// Critically damped and integrated exactly, so the path does not depend on frame slicing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Spring {
    v: f32,
}

impl Spring {
    fn step(&mut self, x: f32, goal: f32, tau: f32, dt: f32) -> f32 {
        let w = 2.0 / tau;
        let y = x - goal;
        let k = self.v + w * y;
        let e = (-w * dt).exp();
        self.v = (self.v - w * k * dt) * e;
        goal + (y + k * dt) * e
    }
}

#[derive(Clone, Debug)]
struct Flight {
    from: Camera,
    to: Camera,
    t: f32,
    dur: f32,
}

impl Flight {
    fn pose(&self, u: f32) -> Camera {
        let (a, b) = (&self.from, &self.to);
        if u >= 1.0 {
            return b.clone();
        }
        Camera {
            target: a.target.lerp(b.target, u),
            yaw: a.yaw + (b.yaw - a.yaw) * u,
            pitch: a.pitch + (b.pitch - a.pitch) * u,
            distance: (a.distance.ln() + (b.distance.ln() - a.distance.ln()) * u).exp(),
        }
    }
}

/// Moves the camera on screen toward the one input asked for.
#[derive(Debug, Default)]
pub struct Motion {
    goal: Option<Camera>,
    /// What the last step showed, so a camera written directly is taken as the new pose rather than eased away from.
    shown: Option<Camera>,
    flight: Option<Flight>,
    springs: [Spring; 6],
    last: Option<Instant>,
    /// Frames drawn in the current motion and their intervals, for the frame time log.
    frames: Vec<f32>,
    /// How long the view took to paint each of those frames.
    costs: Vec<f32>,
}

impl Motion {
    pub fn moving(&self) -> bool {
        self.flight.is_some() || self.goal.is_some()
    }

    fn adopt(&mut self, cam: &Camera) {
        if self.shown.as_ref() != Some(cam) {
            self.goal = None;
            self.flight = None;
            self.springs = Default::default();
        }
    }

    /// The pose input changes, eased onto by the following frames. A flight in the air stops where it is.
    pub fn goal(&mut self, cam: &Camera) -> &mut Camera {
        self.adopt(cam);
        self.flight = None;
        self.shown = Some(cam.clone());
        self.goal.get_or_insert_with(|| cam.clone())
    }

    /// Flies from `cam` to `to`, or lands at once when the view is already about there or motion is reduced.
    pub fn fly(&mut self, cam: &mut Camera, mut to: Camera, reduce: bool) {
        self.adopt(cam);
        to.yaw = cam.yaw + wrap(to.yaw - cam.yaw);
        let dur = if reduce { 0.0 } else { flight_duration(cam, &to) };
        self.goal = None;
        self.springs = Default::default();
        if dur > 0.0 {
            self.flight = Some(Flight { from: cam.clone(), to, t: 0.0, dur });
        } else {
            self.flight = None;
            *cam = to;
        }
        self.shown = Some(cam.clone());
    }

    /// Advances one frame, true while there is more to show. Reduced motion takes a gesture's goal at once.
    pub fn step(&mut self, cam: &mut Camera, now: Instant, reduce: bool) -> bool {
        self.adopt(cam);
        if reduce && self.flight.is_none() {
            if let Some(goal) = self.goal.take() {
                *cam = goal;
                self.springs = Default::default();
                self.shown = Some(cam.clone());
            }
        }
        if !self.moving() {
            self.finish();
            return false;
        }
        let dt = self.last.map_or(1.0 / 60.0, |l| now.saturating_duration_since(l).as_secs_f32());
        if self.last.is_some() && self.frames.len() < 100_000 {
            self.frames.push(dt);
        }
        self.last = Some(now);
        let dt = dt.clamp(1e-4, MAX_DT) / slow();
        if let Some(f) = &mut self.flight {
            f.t += dt;
            let done = f.t >= f.dur;
            *cam = f.pose(if done { 1.0 } else { ease(f.t / f.dur) });
            if done {
                self.flight = None;
            }
        } else if let Some(goal) = &self.goal {
            let s = &mut self.springs;
            let d = goal.distance.max(1e-6);
            let mut settled = true;
            let mut settle = |spring: &mut Spring, x: &mut f32, to: f32, eps: f32| {
                // Far from the origin f32 rounds the last step back to a few ulps short of the goal for good.
                let eps = eps.max(to.abs() * 8.0 * f32::EPSILON);
                *x = spring.step(*x, to, SMOOTH_TIME, dt);
                if (*x - to).abs() < eps && spring.v.abs() < eps * 100.0 {
                    *x = to;
                    spring.v = 0.0;
                } else {
                    settled = false;
                }
            };
            settle(&mut s[0], &mut cam.yaw, goal.yaw, SETTLE_ANGLE);
            settle(&mut s[1], &mut cam.pitch, goal.pitch, SETTLE_ANGLE);
            settle(&mut s[2], &mut cam.distance, goal.distance, d * SETTLE_SHARE);
            // A fast zoom stopped hard at the clamp can carry the spring past it.
            cam.distance = cam.distance.max(1e-3);
            settle(&mut s[3], &mut cam.target.x, goal.target.x, d * SETTLE_SHARE);
            settle(&mut s[4], &mut cam.target.y, goal.target.y, d * SETTLE_SHARE);
            settle(&mut s[5], &mut cam.target.z, goal.target.z, d * SETTLE_SHARE);
            if settled {
                *cam = goal.clone();
                self.goal = None;
            }
        }
        self.shown = Some(cam.clone());
        true
    }

    /// Notes how long the view took to paint a frame of this motion.
    pub fn painted(&mut self, took: Duration) {
        if self.moving() && self.costs.len() < 100_000 {
            self.costs.push(took.as_secs_f32());
        }
    }

    fn finish(&mut self) {
        self.last = None;
        if self.frames.len() >= 10 {
            let mut f = std::mem::take(&mut self.frames);
            f.sort_by(f32::total_cmp);
            let mean = f.iter().sum::<f32>() / f.len() as f32;
            let p95 = f[(f.len() * 95 / 100).min(f.len() - 1)];
            let cost = self.costs.iter().sum::<f32>() / self.costs.len().max(1) as f32;
            let worst = self.costs.iter().copied().fold(0.0, f32::max);
            log::info!(
                "view motion: {} frames {:.2} ms apart on average, p95 {:.2} ms, worst {:.2} ms; the view painted in {:.2} ms on average, worst {:.2} ms",
                f.len() + 1,
                mean * 1e3,
                p95 * 1e3,
                f[f.len() - 1] * 1e3,
                cost * 1e3,
                worst * 1e3
            );
        }
        self.frames.clear();
        self.costs.clear();
    }
}

/// A highlight easing in on what it marks and out of what it marked.
#[derive(Clone, Debug, Default)]
pub struct Fade<K: PartialEq + Clone> {
    pub on: Option<(K, f32)>,
    pub off: Option<(K, f32)>,
    last: Option<Instant>,
}

impl<K: PartialEq + Clone> Fade<K> {
    pub fn set(&mut self, want: Option<K>, reduce: bool) {
        if self.on.as_ref().map(|(k, _)| k) == want.as_ref() {
            return;
        }
        let old = self.on.take();
        self.on = want.map(|k| match &self.off {
            Some((o, a)) if *o == k => (k, *a),
            _ => (k, if reduce { 1.0 } else { 0.0 }),
        });
        self.off = old.filter(|_| !reduce);
    }

    /// Advances one frame, true while there is more to show.
    pub fn step(&mut self, now: Instant) -> bool {
        let dt = self.last.map_or(Duration::from_millis(16), |l| now.saturating_duration_since(l));
        let dt = dt.as_secs_f32().min(MAX_DT) / slow();
        if let Some((_, a)) = &mut self.on {
            *a = (*a + dt / HOVER_IN_S).min(1.0);
        }
        if let Some((_, a)) = &mut self.off {
            *a -= dt / HOVER_OUT_S;
        }
        if self.off.as_ref().is_some_and(|(_, a)| *a <= 0.0) {
            self.off = None;
        }
        let busy = self.off.is_some() || self.on.as_ref().is_some_and(|(_, a)| *a < 1.0);
        self.last = busy.then_some(now);
        busy
    }
}

/// From 0 to 1 each time `key` changes, for what switches over as a whole.
#[derive(Clone, Debug)]
pub struct Ramp {
    key: u64,
    pub t: f32,
    last: Option<Instant>,
}

impl Default for Ramp {
    fn default() -> Self {
        Self { key: 0, t: 1.0, last: None }
    }
}

impl Ramp {
    /// Advances one frame, true while there is more to show.
    pub fn step(&mut self, key: u64, reduce: bool, now: Instant) -> bool {
        if key != self.key {
            self.key = key;
            self.t = if reduce { 1.0 } else { 0.0 };
            self.last = None;
        }
        if self.t >= 1.0 {
            return false;
        }
        let dt = self.last.map_or(1.0 / 60.0, |l| now.saturating_duration_since(l).as_secs_f32()).min(MAX_DT) / slow();
        self.last = Some(now);
        self.t = (self.t + dt / SELECT_S).min(1.0);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(m: &mut Motion, cam: &mut Camera, frames: usize) -> usize {
        let t0 = Instant::now();
        for i in 0..frames {
            if !m.step(cam, t0 + Duration::from_micros(16_667 * i as u64), false) {
                return i;
            }
        }
        frames
    }

    #[test]
    fn ease_is_flat_at_both_ends() {
        assert_eq!(ease(0.0), 0.0);
        assert_eq!(ease(1.0), 1.0);
        assert!((ease(0.5) - 0.5).abs() < 1e-6);
        assert!(ease(0.01) < 0.001);
    }

    #[test]
    fn a_flight_lands_exactly_and_takes_its_time() {
        let mut cam = Camera::default();
        let mut to = cam.clone();
        to.yaw += 3.0;
        to.target = Vec3::new(1.0, 2.0, 3.0);
        let mut m = Motion::default();
        m.fly(&mut cam, to.clone(), false);
        assert!(m.moving());
        let frames = run(&mut m, &mut cam, 200);
        assert!((10..40).contains(&frames), "{frames}");
        assert!((cam.target - to.target).length() < 1e-6);
        assert!((cam.yaw - to.yaw).abs() < 1e-6);
    }

    #[test]
    fn a_flight_turns_the_short_way() {
        let mut cam = Camera { yaw: 3.0, ..Default::default() };
        let to = Camera { yaw: -3.0, ..Default::default() };
        let mut m = Motion::default();
        m.fly(&mut cam, to, false);
        run(&mut m, &mut cam, 200);
        assert!((cam.yaw - (-3.0 + 2.0 * PI)).abs() < 1e-5, "{}", cam.yaw);
    }

    #[test]
    fn reduced_motion_lands_at_once() {
        let mut cam = Camera::default();
        let to = Camera { yaw: 1.0, ..Default::default() };
        let mut m = Motion::default();
        m.fly(&mut cam, to, true);
        assert!(!m.moving());
        assert_eq!(cam.yaw, 1.0);
    }

    #[test]
    fn a_gesture_eases_onto_its_goal_and_stops() {
        let mut cam = Camera::default();
        let mut m = Motion::default();
        m.goal(&cam).orbit(glam::Vec2::new(100.0, 0.0));
        let want = cam.yaw - 0.8;
        let t0 = Instant::now();
        m.step(&mut cam, t0, false);
        assert!(cam.yaw > want + 0.1, "the first frame is part way");
        let frames = run(&mut m, &mut cam, 600);
        assert!(frames < 120, "{frames}");
        assert_eq!(cam.yaw, want);
        assert!(!m.moving());
    }

    #[test]
    fn a_camera_written_directly_is_kept() {
        let mut cam = Camera::default();
        let mut m = Motion::default();
        m.goal(&cam).yaw += 1.0;
        m.step(&mut cam, Instant::now(), false);
        cam = Camera { yaw: 5.0, ..Default::default() };
        assert!(!m.step(&mut cam, Instant::now(), false));
        assert_eq!(cam.yaw, 5.0);
    }

    #[test]
    fn a_gesture_far_from_the_origin_settles() {
        let mut cam =
            Camera { target: Vec3::new(20_000.0, 5_000.0, 1_000.0), yaw: 200.0, distance: 10.0, ..Default::default() };
        let mut m = Motion::default();
        let goal = m.goal(&cam);
        goal.orbit(glam::Vec2::new(37.0, 11.0));
        goal.pan(glam::Vec2::new(13.0, -7.0), 700.0);
        assert!(run(&mut m, &mut cam, 2000) < 300);
        assert!(!m.moving());
    }

    #[test]
    fn reduced_motion_takes_a_gesture_at_once() {
        let mut cam = Camera::default();
        let mut m = Motion::default();
        m.goal(&cam).yaw += 1.0;
        let want = cam.yaw + 1.0;
        assert!(!m.step(&mut cam, Instant::now(), true));
        assert_eq!(cam.yaw, want);
    }

    #[test]
    fn input_stops_a_flight_where_it_is() {
        let mut cam = Camera::default();
        let mut m = Motion::default();
        m.fly(&mut cam, Camera { yaw: 2.0, ..Default::default() }, false);
        run(&mut m, &mut cam, 5);
        let mid = cam.yaw;
        assert_eq!(m.goal(&cam).yaw, mid);
    }

    #[test]
    fn a_ramp_restarts_on_a_new_key() {
        let mut r = Ramp::default();
        let t0 = Instant::now();
        assert!(!r.step(0, false, t0));
        assert!(r.step(1, false, t0));
        assert!(r.t < 1.0);
        for i in 1..20 {
            r.step(1, false, t0 + Duration::from_millis(16 * i));
        }
        assert_eq!(r.t, 1.0);
        r.step(2, true, t0);
        assert_eq!(r.t, 1.0);
    }

    #[test]
    fn a_fade_eases_in_and_hands_its_level_back() {
        let mut f = Fade::default();
        f.set(Some(1), false);
        let t0 = Instant::now();
        assert!(f.step(t0));
        f.set(Some(2), false);
        assert!(f.off.as_ref().is_some_and(|(k, _)| *k == 1));
        for i in 1..30 {
            f.step(t0 + Duration::from_millis(16 * i));
        }
        assert_eq!(f.on, Some((2, 1.0)));
        assert!(f.off.is_none());
        assert!(!f.step(t0 + Duration::from_millis(600)));
    }
}
