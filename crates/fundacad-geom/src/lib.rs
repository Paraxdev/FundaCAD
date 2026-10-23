//! FundaCAD geometry engine over a statically linked OpenCASCADE.

pub mod bench;
pub mod builder;
pub mod cache;
pub mod cancel;
pub mod export;
pub mod faces;
pub mod features;
pub mod fem;
pub mod heartbeat;
pub mod import;
pub mod inspect;
pub mod jobs;
pub mod kernel;
pub mod measure;
pub mod mesh;
pub mod par;
#[cfg(feature = "plugins")]
pub mod plugins;
pub mod printcheck;
pub mod projection;
pub mod reply;
pub mod select;
pub mod soundness;
pub mod stress;
pub mod text;
pub mod topo;
pub mod trace;

pub use opencascade;

/// Build time constant from the `occt-sys` crate, the number to quote in a geometry bug report.
pub const OCCT_VERSION: &str = "7.8.1";
