//! Whole operations the FundaCAD timeline builder calls, one binding each
//! (include/builder_ops.hxx). Fallible ones surface an OpenCASCADE exception as
//! an error carrying the exception class name.

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/builder_ops.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn bo_null() -> UniquePtr<TopoDS_Shape>;
        pub fn bo_is_null(s: &TopoDS_Shape) -> bool;
        pub fn bo_shape_type(s: &TopoDS_Shape) -> i32;
        pub fn bo_is_same(a: &TopoDS_Shape, b: &TopoDS_Shape) -> bool;
        pub fn bo_is_equal(a: &TopoDS_Shape, b: &TopoDS_Shape) -> bool;
        pub fn bo_compound_new() -> UniquePtr<TopoDS_Shape>;
        pub fn bo_compound_add(compound: Pin<&mut TopoDS_Shape>, s: &TopoDS_Shape);
        pub fn bo_children(s: &TopoDS_Shape) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        pub fn bo_subshapes(s: &TopoDS_Shape, kind: i32) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        pub fn bo_count(s: &TopoDS_Shape, kind: i32) -> i32;
        pub fn bo_copy(s: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;

        pub fn bo_volume(s: &TopoDS_Shape) -> f64;
        pub fn bo_area(s: &TopoDS_Shape) -> f64;
        pub fn bo_bbox(s: &TopoDS_Shape, optimal: bool, out: &mut [f64]) -> bool;
        pub fn bo_extent(s: &TopoDS_Shape) -> f64;
        pub fn bo_face_fp(face: &TopoDS_Shape, out: &mut [f64]) -> bool;
        pub fn bo_center_of_mass(s: &TopoDS_Shape, out: &mut [f64]) -> bool;
        pub fn bo_transform_point(s: &TopoDS_Shape, xyz: &mut [f64]);
        pub fn bo_euler_point(rx: f64, ry: f64, rz: f64, dx: f64, dy: f64, dz: f64, xyz: &mut [f64]);
        pub fn bo_void_count(s: &TopoDS_Shape) -> i32;
        pub fn bo_location_translation(s: &TopoDS_Shape, out: &mut [f64]);

        pub fn bo_rotated(s: &TopoDS_Shape, rx: f64, ry: f64, rz: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_translated(s: &TopoDS_Shape, dx: f64, dy: f64, dz: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        #[allow(clippy::too_many_arguments)]
        pub fn bo_on_plane(
            s: &TopoDS_Shape,
            ox: f64, oy: f64, oz: f64,
            xx: f64, xy: f64, xz: f64,
            nx: f64, ny: f64, nz: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        #[allow(clippy::too_many_arguments)]
        pub fn bo_plane_frame(
            ox: f64, oy: f64, oz: f64,
            xx: f64, xy: f64, xz: f64,
            nx: f64, ny: f64, nz: f64,
            out: &mut [f64],
        );
        #[allow(clippy::too_many_arguments)]
        pub fn bo_scaled(
            s: &TopoDS_Shape,
            fx: f64, fy: f64, fz: f64,
            ax: f64, ay: f64, az: f64,
            uniform: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_mirrored(
            s: &TopoDS_Shape,
            ox: f64, oy: f64, oz: f64,
            nx: f64, ny: f64, nz: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;

        pub fn bo_box(l: f64, w: f64, h: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_cylinder(r: f64, h: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_sphere(r: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_cone(r1: f64, r2: f64, h: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_torus(big: f64, small: f64) -> Result<UniquePtr<TopoDS_Shape>>;

        pub fn bo_boolean(
            base: &TopoDS_Shape,
            tools: &TopoDS_Shape,
            kind: i32,
            parallel: bool,
            fuzzy: f64,
            unwrap: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_bool_build(
            base: &TopoDS_Shape,
            tools: &TopoDS_Shape,
            kind: i32,
            parallel: bool,
            fuzzy: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_bool_check(
            result: &TopoDS_Shape,
            base: &TopoDS_Shape,
            tools: &TopoDS_Shape,
            kind: i32,
            parallel: bool,
            fuzzy: f64,
            vols: &[f64],
            out_vol: &mut f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_clean(s: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_unwrap_compound(s: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn bo_drop_debris(s: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn bo_unify_body(s: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn bo_unify_body_known(s: &TopoDS_Shape, known: f64) -> UniquePtr<TopoDS_Shape>;

        pub fn bo_edge_line(x1: f64, y1: f64, x2: f64, y2: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_edge_arc3(
            x1: f64, y1: f64,
            mx: f64, my: f64,
            x2: f64, y2: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_edge_circle(cx: f64, cy: f64, r: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_edge_ellipse(cx: f64, cy: f64, rx: f64, ry: f64, angle: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_edge_spline(xy: &[f64]) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_edge_bspline(
            xy: &[f64],
            knots: &[f64],
            mults: &[i32],
            degree: i32,
            periodic: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_edge_eval(e: &TopoDS_Shape, t: f64, out: &mut [f64]) -> bool;
        pub fn bo_face_rect(x: f64, y: f64, w: f64, h: f64, angle: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_wires_from_edges(edges: &TopoDS_Shape, tol: f64) -> Result<UniquePtr<CxxVector<TopoDS_Shape>>>;
        pub fn bo_wire_closed(w: &TopoDS_Shape) -> bool;
        pub fn bo_wire_from_edge(e: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_face_from_wire(w: &TopoDS_Shape) -> Result<UniquePtr<TopoDS_Shape>>;
        pub fn bo_face_normal_mid(f: &TopoDS_Shape, out: &mut [f64]) -> bool;
        pub fn bo_reversed(s: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn bo_subdivide(edges: &TopoDS_Shape) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        #[allow(clippy::too_many_arguments)]
        pub fn bo_split_profile_cells(
            cells: &TopoDS_Shape,
            ox: f64, oy: f64, oz: f64,
            nx: f64, ny: f64, nz: f64,
            shapes: &TopoDS_Shape,
            model_scale: f64,
        ) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        pub fn bo_face_contains(face: &TopoDS_Shape, x: f64, y: f64, z: f64, tol: f64) -> bool;
        pub fn bo_face_is_planar(f: &TopoDS_Shape) -> bool;
        pub fn bo_face_plane_normal(f: &TopoDS_Shape, out: &mut [f64]) -> bool;
        pub fn bo_face_has_holes(f: &TopoDS_Shape) -> bool;
        pub fn bo_prism(face: &TopoDS_Shape, dx: f64, dy: f64, dz: f64) -> Result<UniquePtr<TopoDS_Shape>>;
        #[allow(clippy::too_many_arguments)]
        pub fn bo_prism_taper(
            face: &TopoDS_Shape,
            dx: f64, dy: f64, dz: f64,
            taper: f64,
            ox: f64, oy: f64, oz: f64,
            xx: f64, xy: f64, xz: f64,
            nx: f64, ny: f64, nz: f64,
            dprism: bool,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        #[allow(clippy::too_many_arguments)]
        pub fn bo_snap_axis_arcs(
            s: &TopoDS_Shape,
            ox: f64, oy: f64, oz: f64,
            dx: f64, dy: f64, dz: f64,
            tol: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
        #[allow(clippy::too_many_arguments)]
        pub fn bo_revolve(
            s: &TopoDS_Shape,
            ox: f64, oy: f64, oz: f64,
            dx: f64, dy: f64, dz: f64,
            angle_deg: f64,
        ) -> Result<UniquePtr<TopoDS_Shape>>;
    }
}
