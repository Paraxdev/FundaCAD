//! The solver model and one planegcs solve, FundaCAD 1's `src/sketch/solver.ts` with the wasm GcsWrapper folded in.

use std::collections::HashMap;

use crate::ffi;

#[derive(Debug, Clone, PartialEq)]
pub struct SPoint {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub fixed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SLine {
    pub id: String,
    pub p1: String,
    pub p2: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SCircle {
    pub id: String,
    pub center: String,
    pub radius: f64,
}

/// `start` to `end` counterclockwise. Arc rules keep the end points on the circle at the sweep angles, so lines can
/// share them.
#[derive(Debug, Clone, PartialEq)]
pub struct SArc {
    pub id: String,
    pub center: String,
    pub start: String,
    pub end: String,
    pub radius: f64,
    pub start_angle: f64,
    pub end_angle: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
}

/// A round operand names a circle or an arc, planegcs's Arc derives from Circle.
#[derive(Debug, Clone, PartialEq)]
pub enum SConstraint {
    Coincident { a: String, b: String },
    Horizontal { line: String },
    Vertical { line: String },
    Parallel { l1: String, l2: String },
    Perpendicular { l1: String, l2: String },
    Equal { l1: String, l2: String },
    Distance { a: String, b: String, value: f64 },
    /// `b.axis - a.axis = value`, signed.
    AxisDistance { a: String, b: String, axis: Axis, value: f64 },
    P2lDistance { p: String, line: String, value: f64 },
    Diameter { circle: String, value: f64 },
    TangentLC { line: String, circle: String },
    TangentLA { line: String, arc: String },
    TangentCC { c1: String, c2: String },
    TangentCA { circle: String, arc: String },
    TangentAA { a1: String, a2: String },
    /// Radians.
    AngleLL { l1: String, l2: String, value: f64 },
    CircleRadius { circle: String, value: f64 },
    ArcRadius { arc: String, value: f64 },
    EqualRadiusCC { c1: String, c2: String },
    EqualRadiusCA { circle: String, arc: String },
    EqualRadiusAA { a1: String, a2: String },
    PointOnLine { p: String, line: String },
    PointOnPerpBisector { p: String, line: String },
    PointOnCircle { p: String, circle: String },
    PointOnArc { p: String, arc: String },
    Symmetric { a: String, b: String, line: String },
    RimGap { round1: String, round2: String, value: f64 },
    RimLine { round: String, line: String, value: f64 },
    RimPoint { p: String, round: String, value: f64 },
    /// `outer.radius - inner.radius = value`, signed. c2cdistance's nested branch is unsigned and converges to an
    /// inverted annulus, so wall thickness must use this.
    RadiusDifference { inner: String, outer: String, value: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Constraint {
    pub id: String,
    pub c: SConstraint,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Drag {
    pub point: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SolveInput {
    pub points: Vec<SPoint>,
    pub lines: Vec<SLine>,
    pub circles: Vec<SCircle>,
    pub arcs: Vec<SArc>,
    pub constraints: Vec<Constraint>,
    pub drag: Option<Drag>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SolveResult {
    pub points: HashMap<String, (f64, f64)>,
    /// Solved radii.
    pub circles: HashMap<String, f64>,
    /// Solved radii, the angles follow from the points.
    pub arcs: HashMap<String, f64>,
    pub dof: i32,
    pub ok: bool,
    /// Constraints that cannot all hold, the sketch is inconsistent.
    pub conflicts: Vec<String>,
    /// Constraints removable without changing the DOF, the sketch is over defined.
    pub redundant: Vec<String>,
    pub partially_redundant: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolveError {
    UnknownPrimitive(String),
    Duplicate(String),
    Rejected(String),
    Native,
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SolveError::UnknownPrimitive(id) => write!(f, "sketch object {id} not found"),
            SolveError::Duplicate(id) => write!(f, "object with id {id} already exists"),
            SolveError::Rejected(id) => write!(f, "planegcs rejected constraint {id}"),
            SolveError::Native => write!(f, "planegcs failed"),
        }
    }
}

impl std::error::Error for SolveError {}

// Op codes of crates/fundacad-sketch/cpp/gcs_shim.cpp.
mod op {
    pub const P2P_COINCIDENT: i32 = 0;
    pub const HORIZONTAL_L: i32 = 1;
    pub const VERTICAL_L: i32 = 2;
    pub const PARALLEL: i32 = 3;
    pub const PERPENDICULAR_LL: i32 = 4;
    pub const EQUAL_LENGTH: i32 = 5;
    pub const P2P_DISTANCE: i32 = 6;
    pub const DIFFERENCE: i32 = 7;
    pub const P2L_DISTANCE: i32 = 8;
    pub const CIRCLE_DIAMETER: i32 = 9;
    pub const CIRCLE_RADIUS: i32 = 10;
    pub const ARC_RADIUS: i32 = 11;
    pub const TANGENT_LC: i32 = 12;
    pub const TANGENT_LA: i32 = 13;
    pub const TANGENT_CC: i32 = 14;
    pub const TANGENT_CA: i32 = 15;
    pub const TANGENT_AA: i32 = 16;
    pub const L2L_ANGLE_LL: i32 = 17;
    pub const EQUAL_RADIUS_CC: i32 = 18;
    pub const EQUAL_RADIUS_CA: i32 = 19;
    pub const EQUAL_RADIUS_AA: i32 = 20;
    pub const POINT_ON_LINE: i32 = 21;
    pub const POINT_ON_PERP_BISECTOR: i32 = 22;
    pub const POINT_ON_CIRCLE: i32 = 23;
    pub const POINT_ON_ARC: i32 = 24;
    pub const P2P_SYMMETRIC_PPL: i32 = 25;
    pub const C2C_DISTANCE: i32 = 26;
    pub const C2L_DISTANCE: i32 = 27;
    pub const P2C_DISTANCE: i32 = 28;
    pub const ARC_RULES: i32 = 29;
}

const DOG_LEG: i32 = 2;
const SUCCESS: i32 = 0;

#[derive(Clone, Copy)]
enum Geo {
    Point(usize),
    Line(usize, usize),
    Circle(usize, usize),
    Arc { center: usize, start: usize, end: usize, params: usize },
}

struct PendingConstraint {
    op: i32,
    idx: Vec<i32>,
    flags: i32,
    tag: i32,
}

/// Builds the parameter vector in the order the wasm wrapper pushed it, then hands it to planegcs in one piece.
#[derive(Default)]
struct Builder {
    values: Vec<f64>,
    fixed: Vec<u8>,
    geo: HashMap<String, Geo>,
    /// Primitive ids in push order, a constraint's tag is its 1-based position here.
    ids: Vec<String>,
    pending: Vec<PendingConstraint>,
}

impl Builder {
    fn push_param(&mut self, value: f64, fixed: bool) -> usize {
        self.values.push(value);
        self.fixed.push(u8::from(fixed));
        self.values.len() - 1
    }

    fn register(&mut self, id: &str, g: Option<Geo>) -> Result<(), SolveError> {
        if self.ids.iter().any(|i| i == id) {
            return Err(SolveError::Duplicate(id.to_string()));
        }
        if let Some(g) = g {
            self.geo.insert(id.to_string(), g);
        }
        self.ids.push(id.to_string());
        Ok(())
    }

    fn point(&mut self, p: &SPoint) -> Result<(), SolveError> {
        let x = self.push_param(p.x, p.fixed);
        self.push_param(p.y, p.fixed);
        self.register(&p.id, Some(Geo::Point(x)))
    }

    fn point_at(&self, id: &str) -> Result<usize, SolveError> {
        match self.geo.get(id) {
            Some(Geo::Point(i)) => Ok(*i),
            _ => Err(SolveError::UnknownPrimitive(id.to_string())),
        }
    }

    fn geo(&self, id: &str) -> Result<Geo, SolveError> {
        self.geo.get(id).copied().ok_or_else(|| SolveError::UnknownPrimitive(id.to_string()))
    }

    fn pt(idx: &mut Vec<i32>, p: usize) {
        idx.push(p as i32);
        idx.push(p as i32 + 1);
    }

    fn line_idx(&self, id: &str, idx: &mut Vec<i32>) -> Result<(), SolveError> {
        match self.geo(id)? {
            Geo::Line(a, b) => {
                Self::pt(idx, a);
                Self::pt(idx, b);
                Ok(())
            }
            _ => Err(SolveError::UnknownPrimitive(id.to_string())),
        }
    }

    fn circle_idx(&self, id: &str, idx: &mut Vec<i32>) -> Result<(), SolveError> {
        match self.geo(id)? {
            Geo::Circle(c, r) => {
                Self::pt(idx, c);
                idx.push(r as i32);
                Ok(())
            }
            _ => Err(SolveError::UnknownPrimitive(id.to_string())),
        }
    }

    fn arc_idx(&self, id: &str, idx: &mut Vec<i32>) -> Result<(), SolveError> {
        match self.geo(id)? {
            Geo::Arc { center, start, end, params } => {
                Self::pt(idx, center);
                Self::pt(idx, start);
                Self::pt(idx, end);
                idx.extend([params as i32, params as i32 + 1, params as i32 + 2]);
                Ok(())
            }
            _ => Err(SolveError::UnknownPrimitive(id.to_string())),
        }
    }

    /// Returns whether the round is an arc.
    fn round_idx(&self, id: &str, idx: &mut Vec<i32>) -> Result<bool, SolveError> {
        match self.geo(id)? {
            Geo::Circle(..) => self.circle_idx(id, idx).map(|_| false),
            Geo::Arc { .. } => self.arc_idx(id, idx).map(|_| true),
            _ => Err(SolveError::UnknownPrimitive(id.to_string())),
        }
    }

    fn radius_param(&self, id: &str) -> Result<usize, SolveError> {
        match self.geo(id)? {
            Geo::Circle(_, r) => Ok(r),
            Geo::Arc { params, .. } => Ok(params + 2),
            _ => Err(SolveError::UnknownPrimitive(id.to_string())),
        }
    }

    fn constraint(&mut self, id: &str, c: &SConstraint, temporary: bool) -> Result<(), SolveError> {
        let tag = if temporary { -1 } else { self.ids.len() as i32 + 1 };
        let mut idx = Vec::new();
        let mut flags = 0;
        // A driving constraint's numbers become fixed parameters, pushed in the order its operands are read.
        let op = match c {
            SConstraint::Coincident { a, b } => {
                Self::pt(&mut idx, self.point_at(a)?);
                Self::pt(&mut idx, self.point_at(b)?);
                op::P2P_COINCIDENT
            }
            SConstraint::Horizontal { line } => {
                self.line_idx(line, &mut idx)?;
                op::HORIZONTAL_L
            }
            SConstraint::Vertical { line } => {
                self.line_idx(line, &mut idx)?;
                op::VERTICAL_L
            }
            SConstraint::Parallel { l1, l2 } => {
                self.line_idx(l1, &mut idx)?;
                self.line_idx(l2, &mut idx)?;
                op::PARALLEL
            }
            SConstraint::Perpendicular { l1, l2 } => {
                self.line_idx(l1, &mut idx)?;
                self.line_idx(l2, &mut idx)?;
                op::PERPENDICULAR_LL
            }
            SConstraint::Equal { l1, l2 } => {
                self.line_idx(l1, &mut idx)?;
                self.line_idx(l2, &mut idx)?;
                op::EQUAL_LENGTH
            }
            SConstraint::Distance { a, b, value } => {
                Self::pt(&mut idx, self.point_at(a)?);
                Self::pt(&mut idx, self.point_at(b)?);
                idx.push(self.push_param(*value, true) as i32);
                op::P2P_DISTANCE
            }
            SConstraint::AxisDistance { a, b, axis, value } => {
                let off = usize::from(*axis == Axis::Y);
                idx.push((self.point_at(a)? + off) as i32);
                idx.push((self.point_at(b)? + off) as i32);
                idx.push(self.push_param(*value, true) as i32);
                op::DIFFERENCE
            }
            SConstraint::P2lDistance { p, line, value } => {
                Self::pt(&mut idx, self.point_at(p)?);
                self.line_idx(line, &mut idx)?;
                idx.push(self.push_param(*value, true) as i32);
                op::P2L_DISTANCE
            }
            SConstraint::Diameter { circle, value } => {
                self.circle_idx(circle, &mut idx)?;
                idx.push(self.push_param(*value, true) as i32);
                op::CIRCLE_DIAMETER
            }
            SConstraint::TangentLC { line, circle } => {
                self.line_idx(line, &mut idx)?;
                self.circle_idx(circle, &mut idx)?;
                op::TANGENT_LC
            }
            SConstraint::TangentLA { line, arc } => {
                self.line_idx(line, &mut idx)?;
                self.arc_idx(arc, &mut idx)?;
                op::TANGENT_LA
            }
            SConstraint::TangentCC { c1, c2 } => {
                self.circle_idx(c1, &mut idx)?;
                self.circle_idx(c2, &mut idx)?;
                op::TANGENT_CC
            }
            SConstraint::TangentCA { circle, arc } => {
                self.circle_idx(circle, &mut idx)?;
                self.arc_idx(arc, &mut idx)?;
                op::TANGENT_CA
            }
            SConstraint::TangentAA { a1, a2 } => {
                self.arc_idx(a1, &mut idx)?;
                self.arc_idx(a2, &mut idx)?;
                op::TANGENT_AA
            }
            SConstraint::AngleLL { l1, l2, value } => {
                self.line_idx(l1, &mut idx)?;
                self.line_idx(l2, &mut idx)?;
                idx.push(self.push_param(*value, true) as i32);
                op::L2L_ANGLE_LL
            }
            SConstraint::CircleRadius { circle, value } => {
                self.circle_idx(circle, &mut idx)?;
                idx.push(self.push_param(*value, true) as i32);
                op::CIRCLE_RADIUS
            }
            SConstraint::ArcRadius { arc, value } => {
                self.arc_idx(arc, &mut idx)?;
                idx.push(self.push_param(*value, true) as i32);
                op::ARC_RADIUS
            }
            SConstraint::EqualRadiusCC { c1, c2 } => {
                self.circle_idx(c1, &mut idx)?;
                self.circle_idx(c2, &mut idx)?;
                op::EQUAL_RADIUS_CC
            }
            SConstraint::EqualRadiusCA { circle, arc } => {
                self.circle_idx(circle, &mut idx)?;
                self.arc_idx(arc, &mut idx)?;
                op::EQUAL_RADIUS_CA
            }
            SConstraint::EqualRadiusAA { a1, a2 } => {
                self.arc_idx(a1, &mut idx)?;
                self.arc_idx(a2, &mut idx)?;
                op::EQUAL_RADIUS_AA
            }
            SConstraint::PointOnLine { p, line } => {
                Self::pt(&mut idx, self.point_at(p)?);
                self.line_idx(line, &mut idx)?;
                op::POINT_ON_LINE
            }
            SConstraint::PointOnPerpBisector { p, line } => {
                Self::pt(&mut idx, self.point_at(p)?);
                self.line_idx(line, &mut idx)?;
                op::POINT_ON_PERP_BISECTOR
            }
            SConstraint::PointOnCircle { p, circle } => {
                Self::pt(&mut idx, self.point_at(p)?);
                self.circle_idx(circle, &mut idx)?;
                op::POINT_ON_CIRCLE
            }
            SConstraint::PointOnArc { p, arc } => {
                Self::pt(&mut idx, self.point_at(p)?);
                self.arc_idx(arc, &mut idx)?;
                op::POINT_ON_ARC
            }
            SConstraint::Symmetric { a, b, line } => {
                Self::pt(&mut idx, self.point_at(a)?);
                Self::pt(&mut idx, self.point_at(b)?);
                self.line_idx(line, &mut idx)?;
                op::P2P_SYMMETRIC_PPL
            }
            SConstraint::RimGap { round1, round2, value } => {
                if self.round_idx(round1, &mut idx)? {
                    flags |= 1;
                }
                if self.round_idx(round2, &mut idx)? {
                    flags |= 2;
                }
                idx.push(self.push_param(*value, true) as i32);
                op::C2C_DISTANCE
            }
            SConstraint::RimLine { round, line, value } => {
                if self.round_idx(round, &mut idx)? {
                    flags |= 1;
                }
                self.line_idx(line, &mut idx)?;
                idx.push(self.push_param(*value, true) as i32);
                op::C2L_DISTANCE
            }
            SConstraint::RimPoint { p, round, value } => {
                Self::pt(&mut idx, self.point_at(p)?);
                if self.round_idx(round, &mut idx)? {
                    flags |= 1;
                }
                idx.push(self.push_param(*value, true) as i32);
                op::P2C_DISTANCE
            }
            SConstraint::RadiusDifference { inner, outer, value } => {
                idx.push(self.radius_param(inner)? as i32);
                idx.push(self.radius_param(outer)? as i32);
                idx.push(self.push_param(*value, true) as i32);
                op::DIFFERENCE
            }
        };
        self.pending.push(PendingConstraint { op, idx, flags, tag });
        self.register(id, None)
    }

    /// `param2 - param1 = value` with param1 a fixed zero, the pin FundaCAD 1 put on a fully fixed arc's own params.
    fn pin(&mut self, id: &str, param: usize, value: f64) -> Result<(), SolveError> {
        let tag = self.ids.len() as i32 + 1;
        let zero = self.push_param(0.0, true);
        let v = self.push_param(value, true);
        self.pending.push(PendingConstraint { op: op::DIFFERENCE, idx: vec![zero as i32, param as i32, v as i32], flags: 0, tag });
        self.register(id, None)
    }
}

struct Native(*mut std::ffi::c_void);

impl Drop for Native {
    fn drop(&mut self) {
        // SAFETY: the handle came from fc_gcs_new and is freed once.
        unsafe { ffi::fc_gcs_free(self.0) }
    }
}

pub fn solve_sketch(input: &SolveInput) -> Result<SolveResult, SolveError> {
    let mut b = Builder::default();
    for p in &input.points {
        b.point(p)?;
    }
    for l in &input.lines {
        let (p1, p2) = (b.point_at(&l.p1)?, b.point_at(&l.p2)?);
        b.register(&l.id, Some(Geo::Line(p1, p2)))?;
    }
    for c in &input.circles {
        let center = b.point_at(&c.center)?;
        let r = b.push_param(c.radius, false);
        b.register(&c.id, Some(Geo::Circle(center, r)))?;
    }
    let fixed: std::collections::HashSet<&str> =
        input.points.iter().filter(|p| p.fixed).map(|p| p.id.as_str()).collect();
    for a in &input.arcs {
        let (center, start, end) = (b.point_at(&a.center)?, b.point_at(&a.start)?, b.point_at(&a.end)?);
        let params = b.push_param(a.start_angle, false);
        b.push_param(a.end_angle, false);
        b.push_param(a.radius, false);
        b.register(&a.id, Some(Geo::Arc { center, start, end, params }))?;
        // With all three points fixed, arc rules put 4 equations on the arc's 3 own params, which planegcs reports as
        // redundant, and as a conflict once user geometry is tied to the arc, so pin the params instead.
        if fixed.contains(a.center.as_str()) && fixed.contains(a.start.as_str()) && fixed.contains(a.end.as_str()) {
            b.pin(&format!("{}~start_angle", a.id), params, a.start_angle)?;
            b.pin(&format!("{}~end_angle", a.id), params + 1, a.end_angle)?;
            b.pin(&format!("{}~radius", a.id), params + 2, a.radius)?;
        } else {
            let id = format!("{}_rules", a.id);
            let tag = b.ids.len() as i32 + 1;
            let mut idx = Vec::new();
            b.arc_idx(&a.id, &mut idx)?;
            b.pending.push(PendingConstraint { op: op::ARC_RULES, idx, flags: 0, tag });
            b.register(&id, None)?;
        }
    }
    for c in &input.constraints {
        b.constraint(&c.id, &c.c, false)?;
    }
    if let Some(d) = &input.drag {
        b.point(&SPoint { id: "__drag".into(), x: d.x, y: d.y, fixed: true })?;
        b.constraint("__dragc", &SConstraint::Coincident { a: d.point.clone(), b: "__drag".into() }, true)?;
    }

    let n = b.values.len() as i32;
    // SAFETY: values and fixed both hold n entries, and fc_gcs_new copies them.
    let h = Native(unsafe { ffi::fc_gcs_new(b.values.as_ptr(), b.fixed.as_ptr(), n) });
    if h.0.is_null() {
        return Err(SolveError::Native);
    }
    for (k, c) in b.pending.iter().enumerate() {
        // SAFETY: idx holds idx.len() entries, the shim checks every index against the parameter count.
        let r = unsafe { ffi::fc_gcs_add(h.0, c.op, c.idx.as_ptr(), c.idx.len() as i32, c.flags, c.tag) };
        if r < 0 {
            let id = if c.tag > 0 { b.ids[c.tag as usize - 1].clone() } else { format!("#{k}") };
            return Err(SolveError::Rejected(id));
        }
    }
    // SAFETY: h is a live handle.
    let status = unsafe { ffi::fc_gcs_solve(h.0, DOG_LEG) };
    // GCS threw, FundaCAD 1's wasm call threw there too and the caller kept the old geometry.
    if status < 0 {
        return Err(SolveError::Native);
    }
    // SAFETY: h is a live handle for the calls below, `out` holds n params.
    let (dof, values, lists) = unsafe {
        ffi::fc_gcs_apply(h.0);
        let dof = ffi::fc_gcs_dof(h.0);
        let mut out = vec![0.0; n as usize];
        ffi::fc_gcs_params(h.0, out.as_mut_ptr());
        let mut lists = [Vec::new(), Vec::new(), Vec::new()];
        for (which, list) in lists.iter_mut().enumerate() {
            let count = ffi::fc_gcs_tags(h.0, which as i32, std::ptr::null_mut(), 0);
            let mut tags = vec![0i32; count.max(0) as usize];
            ffi::fc_gcs_tags(h.0, which as i32, tags.as_mut_ptr(), count);
            *list = tags;
        }
        (dof, out, lists)
    };
    let name = |tags: &[i32]| -> Vec<String> {
        tags.iter().filter_map(|&t| (t >= 1).then(|| b.ids.get(t as usize - 1).cloned()).flatten()).collect()
    };

    let mut res = SolveResult { dof, ok: status == SUCCESS, ..Default::default() };
    for p in &input.points {
        let i = b.point_at(&p.id)?;
        res.points.insert(p.id.clone(), (values[i], values[i + 1]));
    }
    for c in &input.circles {
        res.circles.insert(c.id.clone(), values[b.radius_param(&c.id)?]);
    }
    for a in &input.arcs {
        res.arcs.insert(a.id.clone(), values[b.radius_param(&a.id)?]);
    }
    res.conflicts = name(&lists[0]);
    res.redundant = name(&lists[1]);
    res.partially_redundant = name(&lists[2]);
    Ok(res)
}
