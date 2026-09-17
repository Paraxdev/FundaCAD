use thiserror::Error;

pub mod angle;
pub mod boolean_op;
pub mod bounding_box;
pub mod extrema;
pub mod heal;
pub mod kicad;
pub mod mesh;
pub mod mesh_access;
pub mod primitives;
pub mod progress;
pub mod query;
pub mod raw;
pub mod section;
pub mod topology;
pub mod workplane;

mod law_function;
mod make_pipe_shell;

#[derive(Error, Debug)]
pub enum Error {
    #[error("failed to write STL file")]
    StlWriteFailed,
    #[error("failed to read STEP file")]
    StepReadFailed,
    #[error("failed to read IGES file")]
    IgesReadFailed,
    #[error("failed to read KiCAD PCB file: {0}")]
    KicadReadFailed(#[from] kicad_parser::Error),
    #[error("at least one shape is required to write a STEP file")]
    StepWriteNoShapes,
    #[error("failed to transfer shape to STEP writer")]
    StepWriteTransferFailed,
    #[error("failed to write STEP file")]
    StepWriteFailed,
    #[error("failed to write IGES file")]
    IgesWriteFailed,
    #[error("failed to read BREP file")]
    BrepReadFailed,
    #[error("failed to write BREP file")]
    BrepWriteFailed,
    #[error("failed to triangulate Shape")]
    TriangulationFailed,
    #[error("encountered a face with no triangulation")]
    UntriangulatedFace,
    #[error("at least 2 points are required for creating a wire")]
    NotEnoughPoints,
    #[error("failed to offset face")]
    OffsetFaceFailed,
    #[error("OpenCASCADE raised {0}")]
    Occt(String),
    #[error("{0} did not produce a result")]
    OperationFailed(&'static str),
    #[error("{0}")]
    InvalidInput(&'static str),
    #[error("the operation was cancelled")]
    Cancelled,
}

impl From<cxx::Exception> for Error {
    fn from(err: cxx::Exception) -> Self {
        Self::Occt(err.what().to_string())
    }
}
