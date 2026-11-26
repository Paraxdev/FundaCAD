//! Import and export as FundaCAD 1 did them (src/io/*.ts at 49675e407^), without the dialogs: what they ask for,
//! the requests they send and the features a reply adds.

pub mod export;
pub mod files;
pub mod import;
pub mod insert;

#[cfg(test)]
mod export_tests;
#[cfg(test)]
mod files_tests;
#[cfg(test)]
mod import_tests;
#[cfg(test)]
mod insert_tests;
