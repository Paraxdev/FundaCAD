//! Shape modifications with a bearing on features: 3D offsets and thick
//! solids, draft angles, feature removal and same-domain unification.

use crate::{
    boolean_op::{shape_list, shapes_of},
    primitives::{Face, Shape},
    progress::ProgressRange,
    Error,
};
use cxx::UniquePtr;
use glam::DVec3;
use opencascade_sys as ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OffsetJoin {
    #[default]
    Arc,
    Tangent,
    Intersection,
}

impl OffsetJoin {
    fn code(self) -> i32 {
        match self {
            Self::Arc => 0,
            Self::Tangent => 1,
            Self::Intersection => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OffsetMode {
    #[default]
    Skin,
    Pipe,
    RectoVerso,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OffsetOptions {
    pub tolerance: f64,
    pub mode: OffsetMode,
    pub join: OffsetJoin,
    pub intersection: bool,
    pub self_intersection: bool,
    /// A face or shell grows into a solid instead of a parallel skin.
    pub thickening: bool,
    pub remove_internal_edges: bool,
}

impl Default for OffsetOptions {
    fn default() -> Self {
        Self {
            tolerance: 1e-4,
            mode: OffsetMode::Skin,
            join: OffsetJoin::Arc,
            intersection: false,
            self_intersection: false,
            thickening: false,
            remove_internal_edges: false,
        }
    }
}

/// A `BRepTools_History` of what an algorithm did to its input sub-shapes.
/// Solids and compounds are not tracked and answer empty.
pub struct ShapeHistory {
    inner: UniquePtr<ffi::b_rep_tools_history::FcHistory>,
}

impl ShapeHistory {
    pub fn is_empty(&self) -> bool {
        ffi::b_rep_tools_history::FcHistory_is_null(&self.inner)
    }

    pub fn modified(&self, input: &Shape) -> Result<Vec<Shape>, Error> {
        Ok(shapes_of(ffi::b_rep_tools_history::FcHistory_modified(&self.inner, &input.inner)?))
    }

    pub fn generated(&self, input: &Shape) -> Result<Vec<Shape>, Error> {
        Ok(shapes_of(ffi::b_rep_tools_history::FcHistory_generated(&self.inner, &input.inner)?))
    }

    pub fn is_removed(&self, input: &Shape) -> Result<bool, Error> {
        Ok(ffi::b_rep_tools_history::FcHistory_is_removed(&self.inner, &input.inner)?)
    }
}

impl Shape {
    /// `BRepOffset_MakeOffset::MakeOffsetShape`. `face_offsets` override
    /// `offset` on those faces, which must be faces of this shape.
    pub fn offset_shape(
        &self,
        offset: f64,
        face_offsets: &[(&Face, f64)],
        options: OffsetOptions,
        progress: &ProgressRange,
    ) -> Result<Shape, Error> {
        self.make_offset(offset, face_offsets, &[], false, options, progress)
    }

    /// `BRepOffset_MakeOffset::MakeThickSolid`, with `closing_faces` opened.
    pub fn offset_thick_solid(
        &self,
        offset: f64,
        closing_faces: &[&Face],
        options: OffsetOptions,
        progress: &ProgressRange,
    ) -> Result<Shape, Error> {
        self.make_offset(offset, &[], closing_faces, true, options, progress)
    }

    fn make_offset(
        &self,
        offset: f64,
        face_offsets: &[(&Face, f64)],
        closing_faces: &[&Face],
        thick_solid: bool,
        options: OffsetOptions,
        progress: &ProgressRange,
    ) -> Result<Shape, Error> {
        let faces: Vec<Shape> = face_offsets.iter().map(|(f, _)| Shape::from(*f)).collect();
        let values: Vec<f64> = face_offsets.iter().map(|(_, d)| *d).collect();
        let closing: Vec<Shape> = closing_faces.iter().map(|f| Shape::from(*f)).collect();
        let mode = match options.mode {
            OffsetMode::Skin => 0,
            OffsetMode::Pipe => 1,
            OffsetMode::RectoVerso => 2,
        };
        let mut error = 0;
        let inner = ffi::offset_shape::BRepOffset_MakeOffset_run(
            &self.inner,
            offset,
            options.tolerance,
            mode,
            options.intersection,
            options.self_intersection,
            options.join.code(),
            options.thickening,
            options.remove_internal_edges,
            &shape_list(&faces),
            &values,
            &shape_list(&closing),
            thick_solid,
            &progress.inner,
            &mut error,
        )?;
        // BRepOffset_Error: 9 is UserBreak.
        match error {
            0 if !ffi::builder_ops::bo_is_null(&inner) => Ok(Shape { inner }),
            9 => Err(Error::Cancelled),
            _ => Err(Error::Occt(format!("BRepOffset_MakeOffset error {error}"))),
        }
    }

    /// `BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin`, the shell command:
    /// `closing_faces` are opened and the rest offset by `offset`.
    pub fn thick_solid_by_join(
        &self,
        closing_faces: &[&Face],
        offset: f64,
        options: OffsetOptions,
        progress: &ProgressRange,
    ) -> Result<Shape, Error> {
        let closing: Vec<Shape> = closing_faces.iter().map(|f| Shape::from(*f)).collect();
        let inner = ffi::offset_shape::BRepOffsetAPI_MakeThickSolid_join(
            &self.inner,
            &shape_list(&closing),
            offset,
            options.tolerance,
            options.intersection,
            options.self_intersection,
            options.join.code(),
            options.remove_internal_edges,
            &progress.inner,
        )?;
        Ok(Shape { inner })
    }

    /// `MakeThickSolidBySimple`: a wall around a face or shell without joins.
    pub fn thick_solid_by_simple(&self, offset: f64) -> Result<Shape, Error> {
        Ok(Shape { inner: ffi::offset_shape::BRepOffsetAPI_MakeThickSolid_simple(&self.inner, offset)? })
    }

    /// `BRepOffsetAPI_DraftAngle`: tilt `faces` by `angle` radians about their
    /// intersection with the neutral plane, pulled along `direction`.
    pub fn draft(
        &self,
        faces: &[&Face],
        direction: DVec3,
        angle: f64,
        plane_origin: DVec3,
        plane_normal: DVec3,
    ) -> Result<Shape, Error> {
        let faces: Vec<Shape> = faces.iter().map(|f| Shape::from(*f)).collect();
        let mut refused = 0;
        let inner = ffi::draft_angle::BRepOffsetAPI_DraftAngle_run(
            &self.inner,
            &shape_list(&faces),
            &direction.to_array(),
            angle,
            &plane_origin.to_array(),
            &plane_normal.to_array(),
            &mut refused,
        )?;
        if refused > 0 {
            return Err(Error::Occt(format!("the draft refused face {refused}")));
        }
        Ok(Shape { inner })
    }

    /// `BOPAlgo_RemoveFeatures`. OCCT reports a feature it cannot remove as a
    /// warning and returns the shape unchanged, so compare face counts.
    pub fn remove_features(
        &self,
        faces: &[&Face],
        parallel: bool,
        progress: &ProgressRange,
    ) -> Result<RemovedFeatures, Error> {
        let faces: Vec<Shape> = faces.iter().map(|f| Shape::from(*f)).collect();
        let mut algo = ffi::remove_features::BOPAlgo_RemoveFeatures_run(
            &self.inner,
            &shape_list(&faces),
            parallel,
            &progress.inner,
        )?;
        let alerts: Vec<String> = ffi::remove_features::BOPAlgo_RemoveFeatures_alerts(&algo)
            .lines()
            .map(str::to_owned)
            .collect();
        if algo.HasErrors() {
            if alerts.iter().any(|a| a.contains("UserBreak")) {
                return Err(Error::Cancelled);
            }
            return Err(Error::Occt(alerts.join(", ")));
        }
        Ok(RemovedFeatures {
            shape: Shape { inner: ffi::remove_features::BOPAlgo_RemoveFeatures_shape(&algo) },
            history: ShapeHistory {
                inner: ffi::remove_features::BOPAlgo_RemoveFeatures_history(algo.pin_mut()),
            },
            alerts,
        })
    }

    /// `ShapeUpgrade_UnifySameDomain` with its options.
    pub fn unify_same_domain(&self, options: UnifyOptions, keep: &[&Shape]) -> Result<Unified, Error> {
        let unify = ffi::unify_same_domain::ShapeUpgrade_UnifySameDomain_run(
            &self.inner,
            options.unify_edges,
            options.unify_faces,
            options.concat_bsplines,
            options.allow_internal_edges,
            options.safe_input,
            options.linear_tolerance,
            options.angular_tolerance,
            &shape_list(keep.iter().copied()),
        )?;
        Ok(Unified {
            shape: Shape { inner: ffi::unify_same_domain::ShapeUpgrade_UnifySameDomain_result(&unify) },
            history: ShapeHistory {
                inner: ffi::unify_same_domain::ShapeUpgrade_UnifySameDomain_history(&unify),
            },
        })
    }
}

pub struct RemovedFeatures {
    pub shape: Shape,
    pub history: ShapeHistory,
    /// Alert keys prefixed by gravity, e.g. `W BOPAlgo_AlertUnableToRemoveTheFeature`.
    pub alerts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnifyOptions {
    pub unify_edges: bool,
    pub unify_faces: bool,
    pub concat_bsplines: bool,
    pub allow_internal_edges: bool,
    /// Work on a copy, never modifying the input.
    pub safe_input: bool,
    /// Non-positive keeps the default.
    pub linear_tolerance: f64,
    /// Radians, non-positive keeps the default.
    pub angular_tolerance: f64,
}

impl Default for UnifyOptions {
    fn default() -> Self {
        Self {
            unify_edges: true,
            unify_faces: true,
            concat_bsplines: false,
            allow_internal_edges: false,
            safe_input: true,
            linear_tolerance: 0.0,
            angular_tolerance: 0.0,
        }
    }
}

pub struct Unified {
    pub shape: Shape,
    pub history: ShapeHistory,
}
