//! Booleans and splitters on argument and tool lists with the General Fuse
//! options, as the Python engine's `booleans.py` drives BRepAlgoAPI, with history.

use crate::{primitives::Shape, progress::ProgressRange, Error};
use cxx::{CxxVector, UniquePtr};
use opencascade_sys as ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanKind {
    Fuse,
    Cut,
    Common,
    Section,
    /// `BRepAlgoAPI_Splitter`: arguments cut by tools, nothing removed.
    Split,
    /// Arguments only, every intersection imprinted.
    GeneralFuse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Glue {
    #[default]
    Off,
    /// Shapes touching only by coinciding sub-shapes, never crossing.
    Shift,
    /// Shapes sharing whole faces.
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BooleanOptions {
    /// 0 keeps the exact default.
    pub fuzzy: f64,
    pub glue: Glue,
    /// Leave the input shapes untouched (OCCT may otherwise fix tolerances on them).
    pub non_destructive: bool,
    pub parallel: bool,
    pub use_obb: bool,
}

impl Default for BooleanOptions {
    fn default() -> Self {
        Self { fuzzy: 0.0, glue: Glue::Off, non_destructive: false, parallel: false, use_obb: false }
    }
}

/// A finished boolean, kept for its history.
pub struct BooleanOp {
    inner: UniquePtr<ffi::boolean_algo::FcBooleanRun>,
}

pub(crate) fn shape_list<'a>(
    shapes: impl IntoIterator<Item = &'a Shape>,
) -> UniquePtr<ffi::top_tools::TopTools_ListOfShape> {
    let mut list = ffi::top_tools::new_list_of_shape();
    for shape in shapes {
        list.pin_mut().Append(&shape.inner);
    }
    list
}

pub(crate) fn shapes_of(vector: UniquePtr<CxxVector<ffi::topo_ds::TopoDS_Shape>>) -> Vec<Shape> {
    vector.iter().map(Shape::from_shape).collect()
}

impl BooleanOp {
    /// Fails with [`Error::Cancelled`] when the progress was cancelled, and
    /// with the OCCT alert keys when the algorithm reports errors.
    pub fn run<'a>(
        kind: BooleanKind,
        arguments: impl IntoIterator<Item = &'a Shape>,
        tools: impl IntoIterator<Item = &'a Shape>,
        options: BooleanOptions,
        progress: &ProgressRange,
    ) -> Result<Self, Error> {
        let kind = match kind {
            BooleanKind::Fuse => 0,
            BooleanKind::Cut => 1,
            BooleanKind::Common => 2,
            BooleanKind::Section => 3,
            BooleanKind::Split => 4,
            BooleanKind::GeneralFuse => 5,
        };
        let glue = match options.glue {
            Glue::Off => 0,
            Glue::Shift => 1,
            Glue::Full => 2,
        };
        let inner = ffi::boolean_algo::FcBooleanRun_perform(
            kind,
            &shape_list(arguments),
            &shape_list(tools),
            options.fuzzy,
            glue,
            options.non_destructive,
            options.parallel,
            options.use_obb,
            &progress.inner,
        )?;
        let op = Self { inner };
        if op.has_errors() || !ffi::boolean_algo::FcBooleanRun_is_done(&op.inner) {
            let alerts = op.alerts();
            if alerts.iter().any(|a| a.contains("UserBreak")) {
                return Err(Error::Cancelled);
            }
            return Err(Error::Occt(alerts.join(", ")));
        }
        Ok(op)
    }

    pub fn shape(&self) -> Result<Shape, Error> {
        Ok(Shape { inner: ffi::boolean_algo::FcBooleanRun_shape(&self.inner)? })
    }

    pub fn has_errors(&self) -> bool {
        ffi::boolean_algo::FcBooleanRun_has_errors(&self.inner)
    }

    pub fn has_warnings(&self) -> bool {
        ffi::boolean_algo::FcBooleanRun_has_warnings(&self.inner)
    }

    /// Alert keys prefixed by gravity, e.g. `W BOPAlgo_AlertAcquiredSelfIntersection`.
    pub fn alerts(&self) -> Vec<String> {
        ffi::boolean_algo::FcBooleanRun_alerts(&self.inner).lines().map(str::to_owned).collect()
    }

    pub fn modified(&mut self, input: &Shape) -> Result<Vec<Shape>, Error> {
        Ok(shapes_of(ffi::boolean_algo::FcBooleanRun_modified(self.inner.pin_mut(), &input.inner)?))
    }

    pub fn generated(&mut self, input: &Shape) -> Result<Vec<Shape>, Error> {
        Ok(shapes_of(ffi::boolean_algo::FcBooleanRun_generated(self.inner.pin_mut(), &input.inner)?))
    }

    pub fn is_deleted(&mut self, input: &Shape) -> Result<bool, Error> {
        Ok(ffi::boolean_algo::FcBooleanRun_is_deleted(self.inner.pin_mut(), &input.inner)?)
    }

    pub fn section_edges(&mut self) -> Result<Vec<Shape>, Error> {
        Ok(shapes_of(ffi::boolean_algo::FcBooleanRun_section_edges(self.inner.pin_mut())?))
    }

    /// `SimplifyResult`: merge the same-domain faces and edges the operation split.
    pub fn simplify(&mut self, unify_edges: bool, unify_faces: bool, angular_tolerance: f64) -> Result<(), Error> {
        Ok(ffi::boolean_algo::FcBooleanRun_simplify(
            self.inner.pin_mut(),
            unify_edges,
            unify_faces,
            angular_tolerance,
        )?)
    }
}

/// `BOPAlgo_Splitter` without the API layer or history.
pub fn bop_split<'a>(
    arguments: impl IntoIterator<Item = &'a Shape>,
    tools: impl IntoIterator<Item = &'a Shape>,
    options: BooleanOptions,
    progress: &ProgressRange,
) -> Result<Shape, Error> {
    let mut has_errors = false;
    let inner = ffi::boolean_algo::BOPAlgo_Splitter_perform(
        &shape_list(arguments),
        &shape_list(tools),
        options.fuzzy,
        options.non_destructive,
        options.parallel,
        &progress.inner,
        &mut has_errors,
    )?;
    if has_errors {
        return Err(Error::OperationFailed("BOPAlgo_Splitter"));
    }
    Ok(Shape { inner })
}
