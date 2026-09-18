//! The generic kernel behind the plugin host API (include/plugin_ops.hxx).

pub use inner::*;

#[cxx::bridge]
mod inner {
    unsafe extern "C++" {
        include!("opencascade-sys/include/plugin_ops.hxx");

        type TopoDS_Shape = crate::topo_ds::TopoDS_Shape;

        pub fn po_items(s: &TopoDS_Shape, kind: i32) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        pub fn po_outer_wire(face: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn po_surface(face: &TopoDS_Shape, out: &mut [f64]) -> i32;
        pub fn po_curve(edge: &TopoDS_Shape, out: &mut [f64]) -> i32;
        pub fn po_sample_edges(s: &TopoDS_Shape, segments: i32) -> Vec<f64>;
        pub fn po_point_at(edge: &TopoDS_Shape, position: f64, out: &mut [f64]) -> bool;
        pub fn po_center(s: &TopoDS_Shape, out: &mut [f64]) -> bool;
        pub fn po_normal_at(face: &TopoDS_Shape, x: f64, y: f64, z: f64, out: &mut [f64]) -> bool;
        pub fn po_classify(s: &TopoDS_Shape, x: f64, y: f64, z: f64, tol: f64) -> i32;
        pub fn po_faces_of_edge(
            s: &TopoDS_Shape,
            edge: &TopoDS_Shape,
        ) -> UniquePtr<CxxVector<TopoDS_Shape>>;
        pub fn po_is_valid(s: &TopoDS_Shape) -> bool;

        pub fn po_box(x: f64, y: f64, z: f64, dx: f64, dy: f64, dz: f64) -> UniquePtr<TopoDS_Shape>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_cylinder(
            bx: f64,
            by: f64,
            bz: f64,
            ax: f64,
            ay: f64,
            az: f64,
            r: f64,
            h: f64,
        ) -> UniquePtr<TopoDS_Shape>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_cone(
            bx: f64,
            by: f64,
            bz: f64,
            ax: f64,
            ay: f64,
            az: f64,
            r1: f64,
            r2: f64,
            h: f64,
        ) -> UniquePtr<TopoDS_Shape>;
        pub fn po_sphere(cx: f64, cy: f64, cz: f64, r: f64) -> UniquePtr<TopoDS_Shape>;
        pub fn po_polygon_face(pts: &[f64]) -> UniquePtr<TopoDS_Shape>;
        pub fn po_face_from_wire(wire: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn po_prism(profile: &TopoDS_Shape, dx: f64, dy: f64, dz: f64) -> UniquePtr<TopoDS_Shape>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_revolve(
            profile: &TopoDS_Shape,
            ox: f64,
            oy: f64,
            oz: f64,
            ax: f64,
            ay: f64,
            az: f64,
            degrees: f64,
        ) -> UniquePtr<TopoDS_Shape>;
        pub fn po_boolean(
            kind: i32,
            base: &TopoDS_Shape,
            tools: &TopoDS_Shape,
            status: &mut i32,
        ) -> UniquePtr<TopoDS_Shape>;
        pub fn po_unify(s: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        pub fn po_translate(s: &TopoDS_Shape, dx: f64, dy: f64, dz: f64) -> UniquePtr<TopoDS_Shape>;
        pub fn po_is_reversed(s: &TopoDS_Shape) -> bool;
        pub fn po_surface_frame(face: &TopoDS_Shape, out: &mut [f64]) -> i32;
        pub fn po_surface_samples(face: &TopoDS_Shape, uvs: &[f64], tol: f64) -> Vec<f64>;
        pub fn po_triangulation(face: &TopoDS_Shape) -> Vec<f64>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_rotate(
            s: &TopoDS_Shape,
            ox: f64,
            oy: f64,
            oz: f64,
            ax: f64,
            ay: f64,
            az: f64,
            degrees: f64,
        ) -> UniquePtr<TopoDS_Shape>;
        pub fn po_line_edge(ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64) -> UniquePtr<TopoDS_Shape>;
        pub fn po_arc_edge(points: &[f64]) -> UniquePtr<TopoDS_Shape>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_circle_edge(
            cx: f64,
            cy: f64,
            cz: f64,
            nx: f64,
            ny: f64,
            nz: f64,
            r: f64,
        ) -> UniquePtr<TopoDS_Shape>;
        pub fn po_wire(edges: &TopoDS_Shape) -> UniquePtr<TopoDS_Shape>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_helical_sweep(
            profile: &TopoDS_Shape,
            ox: f64,
            oy: f64,
            oz: f64,
            dx: f64,
            dy: f64,
            dz: f64,
            degrees: f64,
            pitch: f64,
        ) -> UniquePtr<TopoDS_Shape>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_boolean_with(
            kind: i32,
            base: &TopoDS_Shape,
            tools: &TopoDS_Shape,
            parallel: bool,
            fuzzy: f64,
            clean: bool,
            status: &mut i32,
        ) -> UniquePtr<TopoDS_Shape>;
        #[allow(clippy::too_many_arguments)]
        pub fn po_place(
            s: &TopoDS_Shape,
            ox: f64,
            oy: f64,
            oz: f64,
            zx: f64,
            zy: f64,
            zz: f64,
        ) -> UniquePtr<TopoDS_Shape>;
    }
}
