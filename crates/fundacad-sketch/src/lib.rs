//! The 2D sketch solver: planegcs (FreeCAD's PlaneGCS) through a small C shim, plus the sketch compiler that
//! turns document entities and constraints into solver primitives, as FundaCAD 1's sketchSolve.ts did.

mod ffi;

pub mod compile;
pub mod freedom;
pub mod geom;
pub mod model;
pub mod solver;

pub use compile::{compile_and_solve, solve_keeping_axes, DragRefused, DragReq, SolveOpts, SolvePass};
pub use freedom::{shape_freedom, Freedom};
pub use model::{constraints_from_core, resolve_entities, write_back, Constraint, Curve, Entity};

#[cfg(test)]
mod solver_tests;
#[cfg(test)]
mod solver_variant_tests;

#[cfg(test)]
mod test_fixtures;
#[cfg(test)]
mod compile_tests;
#[cfg(test)]
mod compile_guard_tests;
#[cfg(test)]
mod compile_rule_tests;
#[cfg(test)]
mod compile_curve_tests;
#[cfg(test)]
mod freedom_tests;
