//! FundaCAD's document core: the schema the engine rebuilds from, the
//! parameter expression language, body ids and face colour packing. No kernel
//! (docs/RUST-PIVOT.md, section 2.2).

pub mod body_ids;
pub mod face_colors;
pub mod hole_standards;
pub mod params;
pub mod schema;

pub use schema::CadDocument;
