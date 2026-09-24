//! Safe calls into the builder's OpenCASCADE operations (opencascade-sys
//! `builder_ops`), over the `Shape` the rest of the crate uses.

use cxx::UniquePtr;
use opencascade::primitives::Shape;
use opencascade_sys::builder_ops as ffi;
use opencascade_sys::feature_ops as fo;
use opencascade_sys::topo_ds::TopoDS_Shape;

/// An OpenCASCADE exception, by class name (`StdFail_NotDone`, ...).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct KernelError(pub String);

pub type KResult<T> = Result<T, KernelError>;

fn wrap(r: Result<UniquePtr<TopoDS_Shape>, cxx::Exception>) -> KResult<Shape> {
    match r {
        Ok(p) if !p.is_null() => Ok(Shape::from_raw(p)),
        Ok(_) => Err(KernelError("Standard_NullObject".into())),
        Err(e) => Err(KernelError(e.what().to_owned())),
    }
}

fn run(
    op: &'static str,
    args: impl FnOnce() -> String,
    f: impl FnOnce() -> Result<UniquePtr<TopoDS_Shape>, cxx::Exception>,
) -> KResult<Shape> {
    crate::trace::call(op, args, || wrap(f()))
}

/// A shape as one line of an error report: its type, topology and extent.
pub fn describe(s: &Shape) -> String {
    let Some(t) = shape_type(s) else {
        return "null shape".into();
    };
    let mut out = format!(
        "{t:?}(solids={}, faces={}, edges={}",
        count(s, Kind::Solid),
        count(s, Kind::Face),
        count(s, Kind::Edge)
    );
    if let Some(b) = bbox_remembered(s) {
        let r = |v: f64| (v * 1e4).round() / 1e4;
        out.push_str(&format!(
            ", bbox=[{}, {}, {}]..[{}, {}, {}]",
            r(b[0]), r(b[1]), r(b[2]), r(b[3]), r(b[4]), r(b[5])
        ));
    }
    out.push(')');
    out
}

fn bool_args(base: &Shape, tools: &[&Shape], fuzz: f64) -> String {
    let listed: Vec<String> = tools.iter().take(4).map(|t| describe(t)).collect();
    let more = tools.len().saturating_sub(4);
    let tail = if more > 0 { format!(" and {more} more") } else { String::new() };
    format!("base={}, tools=[{}]{tail}, fuzzy={fuzz}", describe(base), listed.join("; "))
}

fn own(p: UniquePtr<TopoDS_Shape>) -> Shape {
    Shape::from_raw(p)
}

fn list(v: UniquePtr<cxx::CxxVector<TopoDS_Shape>>) -> Vec<Shape> {
    match v.as_ref() {
        Some(v) => v.iter().map(Shape::from_raw_ref).collect(),
        None => Vec::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Solid = 0,
    Shell = 1,
    Face = 2,
    Wire = 3,
    Edge = 4,
    Vertex = 5,
}

/// TopAbs_ShapeEnum order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeType {
    Compound,
    CompSolid,
    Solid,
    Shell,
    Face,
    Wire,
    Edge,
    Vertex,
    Other,
}

pub fn shape_type(s: &Shape) -> Option<ShapeType> {
    Some(match ffi::bo_shape_type(s.raw()) {
        0 => ShapeType::Compound,
        1 => ShapeType::CompSolid,
        2 => ShapeType::Solid,
        3 => ShapeType::Shell,
        4 => ShapeType::Face,
        5 => ShapeType::Wire,
        6 => ShapeType::Edge,
        7 => ShapeType::Vertex,
        -1 => return None,
        _ => ShapeType::Other,
    })
}

pub fn is_null(s: &Shape) -> bool {
    ffi::bo_is_null(s.raw())
}

/// Same TShape, location and orientation.
pub fn is_equal(a: &Shape, b: &Shape) -> bool {
    ffi::bo_is_equal(a.raw(), b.raw())
}

/// The address of the shape's TShape, what faces sharing one have in common.
pub fn tshape_id(s: &Shape) -> u64 {
    opencascade_sys::face_query::FQ_tshape(s.raw())
}

pub fn compound<'a>(parts: impl IntoIterator<Item = &'a Shape>) -> Shape {
    let mut c = ffi::bo_compound_new();
    for p in parts {
        ffi::bo_compound_add(c.pin_mut(), p.raw());
    }
    own(c)
}

pub fn children(s: &Shape) -> Vec<Shape> {
    list(ffi::bo_children(s.raw()))
}

pub fn subshapes(s: &Shape, kind: Kind) -> Vec<Shape> {
    list(ffi::bo_subshapes(s.raw(), kind as i32))
}

pub fn count(s: &Shape, kind: Kind) -> usize {
    usize::try_from(ffi::bo_count(s.raw(), kind as i32)).unwrap_or(0)
}

pub fn copy(s: &Shape) -> KResult<Shape> {
    run("BRepBuilderAPI_Copy", || format!("shape={}", describe(s)), || ffi::bo_copy(s.raw()))
}

pub fn volume(s: &Shape) -> f64 {
    ffi::bo_volume(s.raw())
}

pub fn area(s: &Shape) -> f64 {
    ffi::bo_area(s.raw())
}

/// `[xmin, ymin, zmin, xmax, ymax, zmax]`, build123d's exact box.
pub fn bbox(s: &Shape) -> Option<[f64; 6]> {
    let mut out = [0.0; 6];
    ffi::bo_bbox(s.raw(), true, &mut out).then_some(out)
}

type Remembered<T> = std::cell::RefCell<Vec<(Shape, T)>>;

thread_local! {
    static BOXES: Remembered<Option<[f64; 6]>> = const { std::cell::RefCell::new(Vec::new()) };
    static DIAGONALS: Remembered<f64> = const { std::cell::RefCell::new(Vec::new()) };
}

/// An exact box of a B-spline body takes 200 ms, and a blend asks for the same
/// body's again with every selector it matches and every retry that fails. The
/// shapes are held, so a freed one's address is never read as another's.
fn remembered<T: Copy>(
    memo: &'static std::thread::LocalKey<Remembered<T>>,
    s: &Shape,
    measure: impl FnOnce() -> T,
) -> T {
    const KEEP: usize = 4;
    if let Some(v) = memo.with(|m| m.borrow().iter().find(|(k, _)| k.is_same(s)).map(|e| e.1)) {
        return v;
    }
    let v = measure();
    memo.with(|m| {
        let mut m = m.borrow_mut();
        if m.len() >= KEEP {
            m.remove(0);
        }
        m.push((s.clone(), v));
    });
    v
}

/// `bbox`, remembered for the last few shapes.
fn bbox_remembered(s: &Shape) -> Option<[f64; 6]> {
    remembered(&BOXES, s, || bbox(s))
}

/// The exact box's diagonal, what selector drift allowances scale by.
pub fn bbox_diagonal(s: &Shape) -> f64 {
    remembered(&DIAGONALS, s, || opencascade::select_access::bbox_diagonal(s))
}

/// The coarse control point box's largest |coordinate|.
pub fn extent(s: &Shape) -> Option<f64> {
    let e = ffi::bo_extent(s.raw());
    (e >= 0.0).then_some(e)
}

pub fn face_area_centre(face: &Shape) -> Option<[f64; 4]> {
    let mut out = [0.0; 4];
    ffi::bo_face_fp(face.raw(), &mut out).then_some(out)
}

pub fn center_of_mass(s: &Shape) -> Option<[f64; 3]> {
    let mut out = [0.0; 3];
    ffi::bo_center_of_mass(s.raw(), &mut out).then_some(out)
}

pub fn euler_point(r: [f64; 3], d: [f64; 3], p: [f64; 3]) -> [f64; 3] {
    let mut xyz = p;
    ffi::bo_euler_point(r[0], r[1], r[2], d[0], d[1], d[2], &mut xyz);
    xyz
}

pub fn void_count(s: &Shape) -> i32 {
    ffi::bo_void_count(s.raw())
}

pub fn location_translation(s: &Shape) -> [f64; 3] {
    let mut out = [0.0; 3];
    ffi::bo_location_translation(s.raw(), &mut out);
    out
}

pub fn rotated(s: &Shape, r: [f64; 3]) -> KResult<Shape> {
    run("BRepBuilderAPI_Transform (rotate)", || format!("shape={}, euler_deg={r:?}", describe(s)), || ffi::bo_rotated(s.raw(), r[0], r[1], r[2]))
}

pub fn translated(s: &Shape, d: [f64; 3]) -> KResult<Shape> {
    run("BRepBuilderAPI_Transform (translate)", || format!("shape={}, by={d:?}", describe(s)), || ffi::bo_translated(s.raw(), d[0], d[1], d[2]))
}

pub fn scaled(s: &Shape, f: [f64; 3], about: [f64; 3], uniform: bool) -> KResult<Shape> {
    run("BRepBuilderAPI_GTransform (scale)", || format!("shape={}, factor={f:?}, about={about:?}, uniform={uniform}", describe(s)), || ffi::bo_scaled(
        s.raw(),
        f[0],
        f[1],
        f[2],
        about[0],
        about[1],
        about[2],
        uniform,
    ))
}

pub fn mirrored(s: &Shape, origin: [f64; 3], normal: [f64; 3]) -> KResult<Shape> {
    run("BRepBuilderAPI_Transform (mirror)", || format!("shape={}, origin={origin:?}, normal={normal:?}", describe(s)), || ffi::bo_mirrored(
        s.raw(),
        origin[0],
        origin[1],
        origin[2],
        normal[0],
        normal[1],
        normal[2],
    ))
}

/// A plane as the kernel sees it: origin and orthonormal axes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub origin: [f64; 3],
    pub x: [f64; 3],
    pub y: [f64; 3],
    pub z: [f64; 3],
}

impl Frame {
    /// gp_Ax3's frame for this origin, normal and x hint, as build123d's Plane.
    pub fn new(origin: [f64; 3], xdir: [f64; 3], normal: [f64; 3]) -> Frame {
        let mut out = [0.0; 12];
        ffi::bo_plane_frame(
            origin[0], origin[1], origin[2], xdir[0], xdir[1], xdir[2], normal[0], normal[1],
            normal[2], &mut out,
        );
        Frame {
            origin: [out[0], out[1], out[2]],
            x: [out[3], out[4], out[5]],
            y: [out[6], out[7], out[8]],
            z: [out[9], out[10], out[11]],
        }
    }

    pub fn locate(&self, s: &Shape) -> KResult<Shape> {
        let (o, x, n) = (self.origin, self.x, self.z);
        run("BRepBuilderAPI_Transform (to plane)", || format!("shape={}, frame={self:?}", describe(s)), || ffi::bo_on_plane(
            s.raw(),
            o[0],
            o[1],
            o[2],
            x[0],
            x[1],
            x[2],
            n[0],
            n[1],
            n[2],
        ))
    }
}

pub fn make_box(l: f64, w: f64, h: f64) -> KResult<Shape> {
    run("BRepPrimAPI_MakeBox", || format!("l={l}, w={w}, h={h}"), || ffi::bo_box(l, w, h))
}

pub fn make_cylinder(r: f64, h: f64) -> KResult<Shape> {
    run("BRepPrimAPI_MakeCylinder", || format!("r={r}, h={h}"), || ffi::bo_cylinder(r, h))
}

pub fn make_sphere(r: f64) -> KResult<Shape> {
    run("BRepPrimAPI_MakeSphere", || format!("r={r}"), || ffi::bo_sphere(r))
}

pub fn make_cone(r1: f64, r2: f64, h: f64) -> KResult<Shape> {
    run("BRepPrimAPI_MakeCone", || format!("r1={r1}, r2={r2}, h={h}"), || ffi::bo_cone(r1, r2, h))
}

pub fn make_torus(big: f64, small: f64) -> KResult<Shape> {
    run("BRepPrimAPI_MakeTorus", || format!("major={big}, minor={small}"), || ffi::bo_torus(big, small))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoolKind {
    Fuse = 0,
    Cut = 1,
    Common = 2,
}

impl BoolKind {
    pub fn occt(self) -> &'static str {
        match self {
            BoolKind::Fuse => "BRepAlgoAPI_Fuse",
            BoolKind::Cut => "BRepAlgoAPI_Cut",
            BoolKind::Common => "BRepAlgoAPI_Common",
        }
    }
}

/// build123d's operator: parallel, no fuzz, cleaned, a lone child unwrapped.
pub fn boolean_op(base: &Shape, tools: &[&Shape], kind: BoolKind) -> KResult<Shape> {
    let t = compound(tools.iter().copied());
    run(kind.occt(), || bool_args(base, tools, 0.0), || ffi::bo_boolean(
        base.raw(),
        t.raw(),
        kind as i32,
        true,
        0.0,
        true,
    ))
}

/// booleans.py `_serial_bool`: serial, with the pick fuzz, cleaned.
pub fn serial_bool(base: &Shape, tools: &[&Shape], kind: BoolKind) -> KResult<Shape> {
    serial_bool_known(base, tools, kind, &[]).map(|(s, _)| s)
}

/// `serial_bool` handed the operands' signed volumes, the base's then each
/// tool's, so the plausibility check does not integrate them again; empty
/// measures them. Also gives the result's signed volume when the clean left
/// the checked result exactly as it was.
pub fn serial_bool_known(
    base: &Shape,
    tools: &[&Shape],
    kind: BoolKind,
    vols: &[f64],
) -> KResult<(Shape, Option<f64>)> {
    let t = compound(tools.iter().copied());
    let mut ext: Option<f64> = extent(base);
    for tool in tools {
        if let Some(e) = extent(tool) {
            ext = Some(ext.map_or(e, |m| m.max(e)));
        }
    }
    let fuzz = pick_fuzz(ext);
    let k = kind as i32;
    let mut checked_vol = f64::NAN;
    let mut unchanged = false;
    let out = run(kind.occt(), || bool_args(base, tools, fuzz), || {
        let raw = crate::bench::phase("bool_build", || ffi::bo_bool_build(base.raw(), t.raw(), k, false, fuzz))?;
        let checked = crate::bench::phase("bool_check", || {
            ffi::bo_bool_check(&raw, base.raw(), t.raw(), k, false, fuzz, vols, &mut checked_vol)
        })?;
        let out = crate::bench::phase("bool_unify", || ffi::bo_clean(&checked))?;
        unchanged = ffi::bo_is_equal(&checked, &out);
        Ok(out)
    })?;
    Ok((out, unchanged.then_some(checked_vol)))
}

/// the Python engine's `pick_fuzz.py`.
pub fn pick_fuzz(extent_mm: Option<f64>) -> f64 {
    const FLOOR_MM: f64 = 1e-6;
    const CEILING_MM: f64 = 1e-3;
    match extent_mm {
        Some(e) if e.is_finite() && e > 0.0 => {
            let ulp = 2f64.powi(-24);
            CEILING_MM.min(FLOOR_MM.max(e * ulp * 8.0))
        }
        _ => FLOOR_MM,
    }
}

pub fn clean(s: &Shape) -> KResult<Shape> {
    run("ShapeUpgrade_UnifySameDomain", || format!("shape={}", describe(s)), || ffi::bo_clean(s.raw()))
}

pub fn unwrap_compound(s: &Shape) -> Shape {
    own(ffi::bo_unwrap_compound(s.raw()))
}

pub fn drop_debris(s: &Shape) -> Shape {
    own(ffi::bo_drop_debris(s.raw()))
}

pub fn unify_body(s: &Shape) -> Shape {
    own(ffi::bo_unify_body(s.raw()))
}

/// `unify_body` of a shape whose signed volume the caller has measured.
pub fn unify_body_known(s: &Shape, volume: f64) -> Shape {
    own(ffi::bo_unify_body_known(s.raw(), volume))
}

pub fn edge_line(a: [f64; 2], b: [f64; 2]) -> KResult<Shape> {
    run("BRepBuilderAPI_MakeEdge (line)", || format!("from={a:?}, to={b:?}"), || ffi::bo_edge_line(a[0], a[1], b[0], b[1]))
}

pub fn edge_arc3(a: [f64; 2], m: [f64; 2], b: [f64; 2]) -> KResult<Shape> {
    run("GC_MakeArcOfCircle", || format!("start={a:?}, mid={m:?}, end={b:?}"), || ffi::bo_edge_arc3(a[0], a[1], m[0], m[1], b[0], b[1]))
}

pub fn edge_circle(c: [f64; 2], r: f64) -> KResult<Shape> {
    run("BRepBuilderAPI_MakeEdge (circle)", || format!("centre={c:?}, r={r}"), || ffi::bo_edge_circle(c[0], c[1], r))
}

pub fn edge_ellipse(c: [f64; 2], rx: f64, ry: f64, angle: f64) -> KResult<Shape> {
    run("BRepBuilderAPI_MakeEdge (ellipse)", || format!("centre={c:?}, rx={rx}, ry={ry}, angle={angle}"), || ffi::bo_edge_ellipse(c[0], c[1], rx, ry, angle))
}

pub fn edge_spline(points: &[[f64; 2]]) -> KResult<Shape> {
    let flat: Vec<f64> = points.iter().flatten().copied().collect();
    run("GeomAPI_Interpolate", || format!("{} points {points:?}", points.len()), || ffi::bo_edge_spline(&flat))
}

/// The degree and distinct knots a control-point B-spline is built with, the rule
/// src/sketch/bspline.ts evaluates: the degree lowered to fit the poles, stored
/// knots when they are well formed, else uniform 0, 1, 2, ...
pub fn bspline_knots(n: usize, degree: Option<f64>, closed: bool, stored: Option<&[f64]>) -> (usize, Vec<f64>) {
    let want = degree.filter(|d| d.is_finite()).map_or(3.0, |d| d.round().max(1.0));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let p = (want as usize).min(n.saturating_sub(1)).max(1);
    let m = if closed { n + 1 } else { (n + 1).saturating_sub(p) };
    if let Some(k) = stored {
        if k.len() == m && k.iter().all(|v| v.is_finite()) && k.windows(2).all(|w| w[1] > w[0]) {
            return (p, k.to_vec());
        }
    }
    #[allow(clippy::cast_precision_loss)]
    (p, (0..m).map(|i| i as f64).collect())
}

pub fn edge_bspline(poles: &[[f64; 2]], degree: Option<f64>, closed: bool, knots: Option<&[f64]>) -> KResult<Shape> {
    let (p, k) = bspline_knots(poles.len(), degree, closed, knots);
    let last = k.len().saturating_sub(1);
    #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
    let end = if closed { 1 } else { p as i32 + 1 };
    let mults: Vec<i32> = (0..k.len()).map(|i| if i == 0 || i == last { end } else { 1 }).collect();
    let flat: Vec<f64> = poles.iter().flatten().copied().collect();
    #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
    let deg = p as i32;
    run(
        "Geom_BSplineCurve",
        || format!("{} poles, degree {p}, closed {closed}, knots {k:?}", poles.len()),
        || ffi::bo_edge_bspline(&flat, &k, &mults, deg, closed),
    )
}

/// The point at parameter `t` on an edge's curve, with the curve's parameter range.
pub fn edge_eval(e: &Shape, t: f64) -> Option<([f64; 3], [f64; 2])> {
    let mut o = [0.0; 5];
    ffi::bo_edge_eval(e.raw(), t, &mut o).then_some(([o[0], o[1], o[2]], [o[3], o[4]]))
}

pub fn face_rect(x: f64, y: f64, w: f64, h: f64, angle: f64) -> KResult<Shape> {
    run("BRepBuilderAPI_MakeFace (rectangle)", || format!("x={x}, y={y}, w={w}, h={h}, angle={angle}"), || ffi::bo_face_rect(x, y, w, h, angle))
}

pub fn wires_from_edges(edges: &[Shape], tol: f64) -> KResult<Vec<Shape>> {
    let c = compound(edges);
    crate::trace::call(
        "ShapeAnalysis_FreeBounds::ConnectEdgesToWires",
        || format!("{} edges, tol={tol}", edges.len()),
        || ffi::bo_wires_from_edges(c.raw(), tol).map(list).map_err(|e| KernelError(e.what().to_owned())),
    )
}

pub fn wire_closed(w: &Shape) -> bool {
    ffi::bo_wire_closed(w.raw())
}

pub fn wire_from_edge(e: &Shape) -> KResult<Shape> {
    run("BRepBuilderAPI_MakeWire", || format!("edge={}", describe(e)), || ffi::bo_wire_from_edge(e.raw()))
}

pub fn face_from_wire(w: &Shape) -> KResult<Shape> {
    run("BRepBuilderAPI_MakeFace", || format!("wire={}", describe(w)), || ffi::bo_face_from_wire(w.raw()))
}

/// The normal at the middle of the face's UV bounds, build123d `normal_at()`.
pub fn face_normal_mid(f: &Shape) -> Option<[f64; 3]> {
    let mut out = [0.0; 3];
    ffi::bo_face_normal_mid(f.raw(), &mut out).then_some(out)
}

pub fn reversed(s: &Shape) -> Shape {
    own(ffi::bo_reversed(s.raw()))
}

pub fn subdivide(edges: &[Shape]) -> Vec<Shape> {
    let c = compound(edges);
    list(ffi::bo_subdivide(c.raw()))
}

pub fn split_profile_cells(
    cells: &[Shape],
    origin: [f64; 3],
    normal: [f64; 3],
    shapes: &[&Shape],
    model_scale: f64,
) -> Vec<Shape> {
    let c = compound(cells);
    let s = compound(shapes.iter().copied());
    list(ffi::bo_split_profile_cells(
        c.raw(),
        origin[0],
        origin[1],
        origin[2],
        normal[0],
        normal[1],
        normal[2],
        s.raw(),
        model_scale,
    ))
}

pub fn face_contains(face: &Shape, p: [f64; 3], tol: f64) -> bool {
    ffi::bo_face_contains(face.raw(), p[0], p[1], p[2], tol)
}

pub fn face_is_planar(f: &Shape) -> bool {
    ffi::bo_face_is_planar(f.raw())
}

/// build123d `Plane(face).z_dir`.
pub fn face_plane_normal(f: &Shape) -> Option<[f64; 3]> {
    let mut out = [0.0; 3];
    ffi::bo_face_plane_normal(f.raw(), &mut out).then_some(out)
}

pub fn face_has_holes(f: &Shape) -> bool {
    ffi::bo_face_has_holes(f.raw())
}

pub fn prism(face: &Shape, d: [f64; 3]) -> KResult<Shape> {
    run("BRepPrimAPI_MakePrism", || format!("face={}, vector={d:?}", describe(face)), || ffi::bo_prism(face.raw(), d[0], d[1], d[2]))
}

pub fn prism_taper(
    face: &Shape,
    d: [f64; 3],
    taper: f64,
    plane: &Frame,
    dprism: bool,
) -> KResult<Shape> {
    let (o, x, n) = (plane.origin, plane.x, plane.z);
    run("LocOpe_DPrism (tapered prism)", || format!("face={}, vector={d:?}, taper_deg={taper}, dprism={dprism}, plane={plane:?}", describe(face)), || ffi::bo_prism_taper(
        face.raw(),
        d[0],
        d[1],
        d[2],
        taper,
        o[0],
        o[1],
        o[2],
        x[0],
        x[1],
        x[2],
        n[0],
        n[1],
        n[2],
        dprism,
    ))
}

/// `s` with every arc centred within `tol` of the axis rebuilt centred on it,
/// None when no arc needed that. See `bo_snap_axis_arcs`.
pub fn snap_axis_arcs(s: &Shape, origin: [f64; 3], dir: [f64; 3], tol: f64) -> Option<Shape> {
    let [ox, oy, oz] = origin;
    let [dx, dy, dz] = dir;
    let inner = ffi::bo_snap_axis_arcs(s.raw(), ox, oy, oz, dx, dy, dz, tol).ok()?;
    (!inner.is_null()).then(|| Shape::from_raw(inner))
}

pub fn revolve(s: &Shape, origin: [f64; 3], dir: [f64; 3], angle_deg: f64) -> KResult<Shape> {
    run("BRepPrimAPI_MakeRevol", || format!("shape={}, axis_origin={origin:?}, axis_dir={dir:?}, angle_deg={angle_deg}", describe(s)), || ffi::bo_revolve(
        s.raw(),
        origin[0],
        origin[1],
        origin[2],
        dir[0],
        dir[1],
        dir[2],
        angle_deg,
    ))
}

/// build123d `Face(Wire.make_polygon(pts, close=True))`.
pub fn polygon_face(points: &[[f64; 3]]) -> KResult<Shape> {
    let flat: Vec<f64> = points.iter().flatten().copied().collect();
    run("BRepBuilderAPI_MakePolygon", || format!("{} points {points:?}", points.len()), || fo::fo_polygon_face(&flat))
}

pub fn distance_to_point(s: &Shape, p: [f64; 3]) -> Option<f64> {
    let d = fo::fo_distance_to_point(s.raw(), p[0], p[1], p[2]);
    (d >= 0.0).then_some(d)
}

pub fn length(s: &Shape) -> f64 {
    fo::fo_length(s.raw())
}

/// build123d `loft(sections)`, smooth.
pub fn loft(sections: &[Shape]) -> KResult<Shape> {
    let c = compound(sections);
    let ruled = sections.len() == 2;
    run("BRepOffsetAPI_ThruSections", || format!("sections=[{}]", sections.iter().map(describe).collect::<Vec<_>>().join("; ")), || fo::fo_loft(c.raw(), ruled))
}

/// build123d `sweep` with `Transition.RIGHT` and no Frenet frame.
pub fn sweep(profile: &Shape, path: &Shape) -> KResult<Shape> {
    run("BRepOffsetAPI_MakePipeShell", || format!("profile={}, path={}", describe(profile), describe(path)), || fo::fo_sweep(profile.raw(), path.raw()))
}

/// `(zmin, zmax)` of the shape in a frame at `origin` whose z is `dir`.
pub fn axial_extent(s: &Shape, origin: [f64; 3], dir: [f64; 3]) -> Option<(f64, f64)> {
    let mut out = [0.0; 2];
    let [ox, oy, oz] = origin;
    let [dx, dy, dz] = dir;
    fo::fo_axial_extent(s.raw(), ox, oy, oz, dx, dy, dz, &mut out).then_some((out[0], out[1]))
}

/// The face's outer wire followed by its inner wires.
pub fn face_wire_list(face: &Shape) -> KResult<Vec<Shape>> {
    Ok(children(&wrap(fo::fo_face_wire_list(face.raw()))?))
}

pub fn axial_scale(s: &Shape, factor: f64, dir: [f64; 3], hold: f64) -> KResult<Shape> {
    run("BRepBuilderAPI_GTransform (axial scale)", || format!("shape={}, factor={factor}, dir={dir:?}, hold={hold}", describe(s)), || fo::fo_axial_scale(s.raw(), factor, dir[0], dir[1], dir[2], hold))
}

/// A helix of `pitch` rising `height`, radius `radius`, on the plane at `origin`
/// with axes `x` and `z`, swept by `wire` with its binormal pinned to `axis`.
#[allow(clippy::too_many_arguments)]
pub fn screw_sweep(
    wire: &Shape,
    origin: [f64; 3],
    x: [f64; 3],
    z: [f64; 3],
    axis: [f64; 3],
    radius: f64,
    pitch: f64,
    height: f64,
    lefthand: bool,
) -> KResult<Shape> {
    let p = origin;
    run("BRepOffsetAPI_MakePipeShell (helix)", || format!("profile={}, origin={origin:?}, radius={radius}, pitch={pitch}, height={height}, lefthand={lefthand}", describe(wire)), || fo::fo_screw_sweep(
        wire.raw(),
        p[0],
        p[1],
        p[2],
        x[0],
        x[1],
        x[2],
        z[0],
        z[1],
        z[2],
        axis[0],
        axis[1],
        axis[2],
        radius,
        pitch,
        height,
        lefthand,
    ))
}
