//! The closed-loop joint solver behind `mechanism`, plain Rust with no kernel:
//! rigid poses for the moving bodies that meet every joint, found by damped
//! least squares from the pose they were modelled in, with the drive moved in
//! small steps so the linkage stays on the branch it was modelled on.
//!
//! Each moving body's pose turns it about its own centre `c` and shifts it,
//! `p -> rot (p - c) + c + shift`. A step changes the turn by `exp(w / scale)`
//! and the shift by `v`, so all six unknowns of a body are millimetres and the
//! residuals of turns are scaled by the model's size to weigh alike.

use glam::{DMat3, DQuat, DVec3};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Rigid,
    Revolute,
    Slider,
}

/// A connector frame as modelled: an origin, a unit z and a unit x square to it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub p: DVec3,
    pub z: DVec3,
    pub x: DVec3,
}

impl Frame {
    /// The given x made square to z, else the x OpenCASCADE's `gp_Ax3(p, z)`
    /// picks, so a mechanism and a joint measure angles from the same zero.
    /// `None` for a zero z or an x along it.
    pub fn new(p: DVec3, z: DVec3, x: Option<DVec3>) -> Option<Frame> {
        let z = z.try_normalize()?;
        let x = match x.filter(|x| x.length() > 1e-9) {
            Some(x) => x,
            // Rounding in an axis along a world axis must not pick another
            // component as the smallest and swing x a quarter turn.
            None => auto_x(DVec3::select(z.abs().cmplt(DVec3::splat(1e-9)), DVec3::ZERO, z)),
        };
        Some(Frame { p, z, x: (x - z * x.dot(z)).try_normalize()? })
    }

    /// This frame with `other`'s x laid square to its z, for two connectors
    /// that both leave x to the kernel: they then read 0 as modelled whatever
    /// rounding their axes carry. Kept as it is when `other`'s x runs along z.
    pub fn x_from(self, other: &Frame) -> Frame {
        let x = other.x - self.z * other.x.dot(self.z);
        Frame { x: if x.length() > 1e-6 { x.normalize() } else { self.x }, ..self }
    }
}

/// `gp_Ax3(P, V)`'s x direction: the smallest component of `z` is dropped and
/// the other two swapped with a sign, which is square to `z` by construction.
pub fn auto_x(z: DVec3) -> DVec3 {
    let (a, b, c) = (z.x, z.y, z.z);
    let (aa, ba, ca) = (a.abs(), b.abs(), c.abs());
    let d = if ba <= aa && ba <= ca {
        if aa > ca { DVec3::new(-c, 0.0, a) } else { DVec3::new(c, 0.0, -a) }
    } else if aa <= ba && aa <= ca {
        if ba > ca { DVec3::new(0.0, -c, b) } else { DVec3::new(0.0, c, -b) }
    } else if aa > ba {
        DVec3::new(-b, a, 0.0)
    } else {
        DVec3::new(b, -a, 0.0)
    };
    d.normalize()
}

/// One joint: frame `fa` rides on body `a`, `fb` on body `b`, `None` being a
/// body that does not move. B is the reference the coordinate is measured in.
#[derive(Debug, Clone)]
pub struct Joint {
    pub kind: Kind,
    pub a: Option<usize>,
    pub b: Option<usize>,
    pub fa: Frame,
    pub fb: Frame,
}

impl Joint {
    fn rows(&self) -> usize {
        match self.kind {
            Kind::Rigid => 6,
            Kind::Revolute | Kind::Slider => 5,
        }
    }
}

/// Where each moving body is, relative to where it was modelled.
#[derive(Debug, Clone, PartialEq)]
pub struct Pose {
    pub rot: Vec<DQuat>,
    pub shift: Vec<DVec3>,
}

impl Pose {
    pub fn modelled(bodies: usize) -> Pose {
        Pose {
            rot: vec![DQuat::IDENTITY; bodies],
            shift: vec![DVec3::ZERO; bodies],
        }
    }
}

/// The joint the drive moves and the value it should read: millimetres along
/// a slider, radians about a revolute, unwrapped.
#[derive(Debug, Clone, Copy)]
pub struct Drive {
    pub joint: usize,
    pub target: f64,
}

/// The job was cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// The joint that stays furthest from being met, and by how much (mm, turns
/// counted at the model's size).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gap {
    pub joint: usize,
    pub size: f64,
}

/// A drive that could not go all the way: the last value it reached, and
/// the joint that gives, `None` at a dead point where every joint still meets.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Locked {
    pub reached: f64,
    pub gap: Option<Gap>,
}

pub struct Problem {
    pub joints: Vec<Joint>,
    /// Each moving body's centre, which it turns about.
    pub centres: Vec<DVec3>,
    /// The model's size (mm), weighing turns against lengths.
    pub scale: f64,
    /// What each joint keeps from the modelled pose: a revolute's axial
    /// offset, a slider's offsets across its axis, a weld's offset.
    modelled: Vec<DVec3>,
}

/// The rotation vector of `q`, the short way round.
fn log(q: DQuat) -> DVec3 {
    let q = if q.w < 0.0 { -q } else { q };
    let v = DVec3::new(q.x, q.y, q.z);
    let s = v.length();
    if s < 1e-12 {
        return v * 2.0;
    }
    v * (2.0 * s.atan2(q.w) / s)
}

/// `a - b` folded into (-pi, pi].
pub fn wrap(a: f64) -> f64 {
    let t = std::f64::consts::TAU;
    let r = a - t * (a / t).round();
    if r <= -std::f64::consts::PI { r + t } else { r }
}

const STEP_LIMIT: usize = 60;

impl Problem {
    pub fn new(joints: Vec<Joint>, centres: Vec<DVec3>, scale: f64) -> Problem {
        let mut p = Problem {
            joints,
            centres,
            scale: if scale > 1e-9 { scale } else { 1.0 },
            modelled: Vec::new(),
        };
        let pose = Pose::modelled(p.centres.len());
        p.modelled = (0..p.joints.len())
            .map(|j| {
                let (a, b) = p.frames(&pose, j);
                let d = a.p - b.p;
                match p.joints[j].kind {
                    Kind::Revolute => DVec3::new(d.dot(b.z), 0.0, 0.0),
                    Kind::Slider => DVec3::new(d.dot(b.x), d.dot(b.z.cross(b.x)), 0.0),
                    Kind::Rigid => d,
                }
            })
            .collect();
        p
    }

    /// Unknowns: six per moving body.
    pub fn size(&self) -> usize {
        self.centres.len() * 6
    }

    /// Every residual below this is met: a micron, or a billionth of the model.
    pub fn tolerance(&self) -> f64 {
        (1e-9 * self.scale).max(1e-6)
    }

    fn place(&self, pose: &Pose, body: Option<usize>, f: &Frame) -> Frame {
        let Some(i) = body else { return *f };
        let (q, c) = (pose.rot[i], self.centres[i]);
        Frame {
            p: q * (f.p - c) + c + pose.shift[i],
            z: q * f.z,
            x: q * f.x,
        }
    }

    /// Joint `j`'s two frames at `pose`.
    pub fn frames(&self, pose: &Pose, j: usize) -> (Frame, Frame) {
        let jt = &self.joints[j];
        (self.place(pose, jt.a, &jt.fa), self.place(pose, jt.b, &jt.fb))
    }

    fn turn(pose: &Pose, body: Option<usize>) -> DQuat {
        body.map_or(DQuat::IDENTITY, |i| pose.rot[i])
    }

    /// The world move of body `i`: `p -> rot p + shift`.
    pub fn placement(&self, pose: &Pose, i: usize) -> (DMat3, DVec3) {
        let r = DMat3::from_quat(pose.rot[i]);
        let c = self.centres[i];
        (r, c + pose.shift[i] - r * c)
    }

    fn joint_rows(&self, pose: &Pose, j: usize, out: &mut Vec<f64>) {
        let jt = &self.joints[j];
        let (a, b) = self.frames(pose, j);
        let (u, v) = (b.x, b.z.cross(b.x));
        let d = a.p - b.p;
        let m = self.modelled[j];
        let l = self.scale;
        match jt.kind {
            Kind::Revolute => {
                let c = a.z.cross(b.z);
                out.extend([l * c.dot(u), l * c.dot(v), d.dot(u), d.dot(v), d.dot(b.z) - m.x]);
            }
            Kind::Slider | Kind::Rigid => {
                let rel = Self::turn(pose, jt.b).conjugate() * Self::turn(pose, jt.a);
                let w = log(rel) * l;
                out.extend([w.x, w.y, w.z]);
                if jt.kind == Kind::Slider {
                    out.extend([d.dot(u) - m.x, d.dot(v) - m.y]);
                } else {
                    let local = Self::turn(pose, jt.b).conjugate() * d - m;
                    out.extend([local.x, local.y, local.z]);
                }
            }
        }
    }

    /// Joint `j`'s coordinate: the offset of A along B's z (mm) for a slider,
    /// the angle from B's x to A's x about B's z (radians) for a revolute.
    pub fn coordinate(&self, pose: &Pose, j: usize) -> f64 {
        let (a, b) = self.frames(pose, j);
        match self.joints[j].kind {
            Kind::Revolute => {
                let xa = a.x - b.z * a.x.dot(b.z);
                b.z.dot(b.x.cross(xa)).atan2(b.x.dot(xa))
            }
            _ => (a.p - b.p).dot(b.z),
        }
    }

    fn drive_row(&self, pose: &Pose, drive: &Drive) -> f64 {
        let q = self.coordinate(pose, drive.joint);
        match self.joints[drive.joint].kind {
            Kind::Revolute => self.scale * wrap(q - drive.target),
            _ => q - drive.target,
        }
    }

    pub fn residuals(&self, pose: &Pose, drive: Option<&Drive>) -> Vec<f64> {
        let mut out = Vec::new();
        for j in 0..self.joints.len() {
            self.joint_rows(pose, j, &mut out);
        }
        if let Some(d) = drive {
            out.push(self.drive_row(pose, d));
        }
        out
    }

    /// The joint furthest from being met at `pose`.
    pub fn worst(&self, pose: &Pose) -> Gap {
        let mut worst = Gap { joint: 0, size: -1.0 };
        let mut rows = Vec::new();
        for j in 0..self.joints.len() {
            rows.clear();
            self.joint_rows(pose, j, &mut rows);
            let size = rows.iter().map(|r| r * r).sum::<f64>().sqrt();
            if size > worst.size {
                worst = Gap { joint: j, size };
            }
        }
        worst
    }

    fn step(&self, pose: &Pose, delta: &[f64]) -> Pose {
        let mut next = pose.clone();
        for i in 0..self.centres.len() {
            let k = 6 * i;
            let w = DVec3::new(delta[k], delta[k + 1], delta[k + 2]) / self.scale;
            next.rot[i] = (DQuat::from_scaled_axis(w) * pose.rot[i]).normalize();
            next.shift[i] = pose.shift[i] + DVec3::new(delta[k + 3], delta[k + 4], delta[k + 5]);
        }
        next
    }

    /// The residuals' derivatives by central differences, one column per
    /// unknown. A joint only reads its own two bodies, so only those columns
    /// are measured.
    fn jacobian(&self, pose: &Pose, drive: Option<&Drive>) -> Vec<Vec<f64>> {
        let n = self.size();
        let m = self.joints.iter().map(Joint::rows).sum::<usize>() + usize::from(drive.is_some());
        let mut cols = vec![vec![0.0; m]; n];
        let h = 1e-5;
        let mut delta = vec![0.0; n];
        let mut row = 0;
        let mut plus = Vec::new();
        let mut minus = Vec::new();
        let blocks = (0..self.joints.len()).map(|j| (Some(j), self.joints[j].rows()));
        let drive_block = drive.map(|_| (None, 1)).into_iter();
        for (j, rows) in blocks.chain(drive_block) {
            let jt = &self.joints[j.unwrap_or_else(|| drive.map_or(0, |d| d.joint))];
            for body in [jt.a, jt.b].into_iter().flatten() {
                for k in 6 * body..6 * body + 6 {
                    let mut eval = |s: f64, out: &mut Vec<f64>| {
                        delta[k] = s;
                        let p = self.step(pose, &delta);
                        delta[k] = 0.0;
                        out.clear();
                        match (j, drive) {
                            (Some(j), _) => self.joint_rows(&p, j, out),
                            (None, Some(d)) => out.push(self.drive_row(&p, d)),
                            (None, None) => {}
                        }
                    };
                    eval(h, &mut plus);
                    eval(-h, &mut minus);
                    for r in 0..rows {
                        cols[k][row + r] += (plus[r] - minus[r]) / (2.0 * h);
                    }
                }
            }
            row += rows;
        }
        cols
    }

    /// Levenberg-Marquardt from `pose`. True when every residual is met;
    /// `pose` is the best found either way.
    pub fn settle(
        &self,
        pose: &mut Pose,
        drive: Option<&Drive>,
        tick: &mut dyn FnMut() -> bool,
    ) -> Result<bool, Cancelled> {
        let n = self.size();
        let tol = self.tolerance();
        let met = |r: &[f64]| r.iter().all(|x| x.abs() < tol);
        let cost = |r: &[f64]| r.iter().map(|x| x * x).sum::<f64>();
        let mut r = self.residuals(pose, drive);
        let mut mu = -1.0;
        for _ in 0..STEP_LIMIT {
            if !tick() {
                return Err(Cancelled);
            }
            if met(&r) {
                return Ok(true);
            }
            let cols = self.jacobian(pose, drive);
            let nz: Vec<Vec<(usize, f64)>> = (0..r.len())
                .map(|i| (0..n).filter(|&k| cols[k][i] != 0.0).map(|k| (k, cols[k][i])).collect())
                .collect();
            let mut a = vec![0.0; n * n];
            let mut g = vec![0.0; n];
            for (i, row) in nz.iter().enumerate() {
                for &(p, vp) in row {
                    g[p] += vp * r[i];
                    for &(q, vq) in row {
                        a[p * n + q] += vp * vq;
                    }
                }
            }
            let top = (0..n).map(|k| a[k * n + k]).fold(0.0, f64::max).max(1e-300);
            if mu < 0.0 {
                mu = 1e-6 * top;
            }
            let before = cost(&r);
            let mut improved = false;
            while mu < 1e12 * top {
                let mut damped = a.clone();
                for k in 0..n {
                    damped[k * n + k] += mu;
                }
                let rhs: Vec<f64> = g.iter().map(|x| -x).collect();
                if let Some(delta) = cholesky_solve(&mut damped, n, rhs) {
                    let trial = self.step(pose, &delta);
                    let rt = self.residuals(&trial, drive);
                    if cost(&rt) < before {
                        *pose = trial;
                        r = rt;
                        mu = (mu / 3.0).max(1e-12 * top);
                        improved = true;
                        break;
                    }
                }
                mu *= 4.0;
            }
            if !improved {
                return Ok(met(&r));
            }
        }
        Ok(met(&r))
    }

    /// Moves the drive from `from` to `to` in steps of at most `most`,
    /// settling the linkage after each. A step that fails is halved; once a
    /// step ten halvings short of `most` fails, the drive is locked. Every
    /// step taken is at least that long, so the walk always ends. `to` must
    /// be on the branch of `from`: a revolute drive reads within a half turn
    /// of its target, so a walk that ends further than that would stop early.
    pub fn sweep(
        &self,
        pose: &mut Pose,
        joint: usize,
        from: f64,
        to: f64,
        most: f64,
        tick: &mut dyn FnMut() -> bool,
    ) -> Result<Result<(), Locked>, Cancelled> {
        let least = most / 1024.0;
        let mut at = from;
        let mut step = most;
        while at != to {
            if !tick() {
                return Err(Cancelled);
            }
            let next = if (to - at).abs() <= step { to } else { at + step * (to - at).signum() };
            let mut trial = pose.clone();
            if self.settle(&mut trial, Some(&Drive { joint, target: next }), tick)? {
                *pose = trial;
                at = next;
                step = (step * 2.0).min(most);
            } else if step > least {
                step = (step / 2.0).max(least);
            } else {
                // Pushed to the value asked for, the worst joint says what
                // gives and by how much. At a dead point the solve can stall
                // with every joint met, so then the step that failed says it,
                // and when that too is noise no joint is named.
                let mut pushed = pose.clone();
                self.settle(&mut pushed, Some(&Drive { joint, target: to }), tick)?;
                let tol = self.tolerance();
                let gap = [self.worst(&pushed), self.worst(&trial)].into_iter().find(|g| g.size > tol);
                return Ok(Err(Locked { reached: at, gap }));
            }
        }
        Ok(Ok(()))
    }

    /// The motions left free at `pose` with the drive held: their count and
    /// the moving bodies that take part in them, in order.
    pub fn free_motions(&self, pose: &Pose, drive: Option<usize>) -> (usize, Vec<usize>) {
        let n = self.size();
        if n == 0 {
            return (0, Vec::new());
        }
        let d = drive.map(|joint| Drive { joint, target: self.coordinate(pose, joint) });
        let mut cols = self.jacobian(pose, d.as_ref());
        let (sigma, v) = singular(&mut cols);
        let top = sigma.iter().copied().fold(0.0, f64::max);
        let free: Vec<usize> = (0..n).filter(|&k| sigma[k] <= 1e-6 * top || top == 0.0).collect();
        let mut weight = vec![0.0; self.centres.len()];
        for &k in &free {
            for (i, w) in weight.iter_mut().enumerate() {
                *w += (0..6).map(|c| v[k][6 * i + c].powi(2)).sum::<f64>();
            }
        }
        let most = weight.iter().copied().fold(0.0, f64::max);
        // A free motion can move a slide by a millimetre while it swings a far
        // arm by a centimetre: any part it moves by a hundredth as much is named.
        let moving = (0..weight.len()).filter(|&i| weight[i] > 1e-4 * most && most > 1e-9).collect();
        (free.len(), moving)
    }
}

/// Solves `a x = b` for a symmetric positive definite `a` (n by n, row major),
/// `None` when a pivot is not positive.
fn cholesky_solve(a: &mut [f64], n: usize, mut b: Vec<f64>) -> Option<Vec<f64>> {
    for j in 0..n {
        let mut d = a[j * n + j];
        for k in 0..j {
            d -= a[j * n + k] * a[j * n + k];
        }
        if !(d > 0.0) {
            return None;
        }
        let d = d.sqrt();
        a[j * n + j] = d;
        for i in j + 1..n {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= a[i * n + k] * a[j * n + k];
            }
            a[i * n + j] = s / d;
        }
    }
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= a[i * n + k] * b[k];
        }
        b[i] = s / a[i * n + i];
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for k in i + 1..n {
            s -= a[k * n + i] * b[k];
        }
        b[i] = s / a[i * n + i];
    }
    Some(b)
}

/// One-sided Jacobi: the singular values of the matrix whose columns are
/// `cols`, and the matching right singular vectors, one per column.
fn singular(cols: &mut [Vec<f64>]) -> (Vec<f64>, Vec<Vec<f64>>) {
    let n = cols.len();
    let mut v: Vec<Vec<f64>> = (0..n).map(|k| (0..n).map(|i| f64::from(u8::from(i == k))).collect()).collect();
    let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>();
    for _ in 0..60 {
        let mut off: f64 = 0.0;
        for p in 0..n {
            for q in p + 1..n {
                let alpha = dot(&cols[p], &cols[p]);
                let beta = dot(&cols[q], &cols[q]);
                let gamma = dot(&cols[p], &cols[q]);
                if gamma == 0.0 || alpha == 0.0 || beta == 0.0 {
                    continue;
                }
                let rel = gamma.abs() / (alpha * beta).sqrt();
                if rel < 1e-15 {
                    continue;
                }
                off = off.max(rel);
                let zeta = (beta - alpha) / (2.0 * gamma);
                let t = zeta.signum() / (zeta.abs() + (1.0 + zeta * zeta).sqrt());
                let c = 1.0 / (1.0 + t * t).sqrt();
                let s = c * t;
                for m in [&mut *cols, &mut v[..]] {
                    let (lo, hi) = m.split_at_mut(q);
                    for (x, y) in lo[p].iter_mut().zip(hi[0].iter_mut()) {
                        let (xp, xq) = (*x, *y);
                        *x = c * xp - s * xq;
                        *y = s * xp + c * xq;
                    }
                }
            }
        }
        if off < 1e-14 {
            break;
        }
    }
    let sigma = cols.iter().map(|c| dot(c, c).sqrt()).collect();
    (sigma, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(p: [f64; 3], z: [f64; 3]) -> Frame {
        Frame::new(DVec3::from_array(p), DVec3::from_array(z), None).unwrap()
    }

    fn run() -> impl FnMut() -> bool {
        || true
    }

    #[test]
    fn the_automatic_x_is_the_kernels() {
        assert_eq!(auto_x(DVec3::Z), DVec3::X);
        assert_eq!(auto_x(-DVec3::Z), -DVec3::X);
        assert_eq!(auto_x(DVec3::X), DVec3::Z);
        assert_eq!(auto_x(DVec3::Y), DVec3::Z);
        assert_eq!(auto_x(-DVec3::Y), -DVec3::Z);
        let z = DVec3::new(1.0, 2.0, 3.0).normalize();
        assert!(auto_x(z).dot(z).abs() < 1e-15);
        // Rounding in an axis along y does not swing x to world x.
        let noisy = frame([0.0; 3], [1e-13, 1.0, -1e-14]);
        assert!((noisy.x - DVec3::Z).length() < 1e-12, "{}", noisy.x);
    }

    #[test]
    fn two_automatic_frames_on_one_pin_share_their_x() {
        let b = frame([0.0; 3], [0.0, 0.0, 1.0]);
        let a = frame([0.0; 3], [0.0, 1e-7, 1.0]).x_from(&b);
        assert!(a.x.dot(a.z).abs() < 1e-15 && (a.x - DVec3::X).length() < 1e-12);
        // Square to each other, a's own x stays.
        let a = frame([0.0; 3], [1.0, 0.0, 0.0]).x_from(&b);
        assert_eq!(a.x, DVec3::Z);
    }

    #[test]
    fn a_rotation_logs_back_to_its_vector() {
        let w = DVec3::new(0.3, -0.2, 0.9);
        assert!((log(DQuat::from_scaled_axis(w)) - w).length() < 1e-12);
        assert!((wrap(3.5 * std::f64::consts::PI) + 0.5 * std::f64::consts::PI).abs() < 1e-12);
    }

    #[test]
    fn a_pin_that_is_apart_is_pulled_onto_its_hole() {
        // A link on a revolute to the ground, modelled 1 mm off its pin.
        let j = Joint {
            kind: Kind::Revolute,
            a: Some(0),
            b: None,
            fa: frame([1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            fb: frame([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        };
        let p = Problem::new(vec![j], vec![DVec3::new(10.0, 0.0, 0.0)], 20.0);
        let mut pose = Pose::modelled(1);
        assert!(p.settle(&mut pose, None, &mut run()).unwrap());
        let (a, b) = p.frames(&pose, 0);
        assert!((a.p - b.p).length() < 1e-6);
        // Only the turn about the pin is left.
        assert_eq!(p.free_motions(&pose, None), (1, vec![0]));
        assert_eq!(p.free_motions(&pose, Some(0)), (0, vec![]));
    }

    #[test]
    fn a_driven_pin_turns_its_link() {
        let j = Joint {
            kind: Kind::Revolute,
            a: Some(0),
            b: None,
            fa: frame([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            fb: frame([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        };
        let p = Problem::new(vec![j], vec![DVec3::new(10.0, 0.0, 0.0)], 20.0);
        let mut pose = Pose::modelled(1);
        let target = 200f64.to_radians();
        let r = p.sweep(&mut pose, 0, 0.0, target, 2f64.to_radians(), &mut run()).unwrap();
        assert_eq!(r, Ok(()));
        let (rot, shift) = p.placement(&pose, 0);
        let tip = rot * DVec3::new(10.0, 0.0, 0.0) + shift;
        let want = DVec3::new(10.0 * target.cos(), 10.0 * target.sin(), 0.0);
        assert!((tip - want).length() < 1e-5, "{tip} {want}");
    }

    #[test]
    fn the_solve_is_symmetric_positive_definite_safe() {
        let mut a = vec![4.0, 2.0, 2.0, 3.0];
        let x = cholesky_solve(&mut a, 2, vec![2.0, 1.0]).unwrap();
        assert!((x[0] - 0.5).abs() < 1e-15 && x[1].abs() < 1e-15);
        assert!(cholesky_solve(&mut vec![0.0], 1, vec![1.0]).is_none());
    }

    #[test]
    fn singular_values_find_the_rank() {
        // Columns (1,0,0), (0,2,0), (1,2,0): rank 2.
        let mut cols = vec![vec![1.0, 0.0, 0.0], vec![0.0, 2.0, 0.0], vec![1.0, 2.0, 0.0]];
        let (s, _) = singular(&mut cols);
        let mut s = s;
        s.sort_by(f64::total_cmp);
        assert!(s[0] < 1e-12, "{s:?}");
        assert!(s[1] > 0.5);
    }
}
