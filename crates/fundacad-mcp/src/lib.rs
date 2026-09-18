//! FundaCAD over MCP, the Rust port of the Python MCP server (docs/MCP.md).
//!
//! The tools another model uses to build, measure and look at a part. The
//! protocol is the official Rust MCP SDK (`rmcp`) over stdio; everything below
//! it is the same design the Python server had, module for module:
//!
//!   `model`        server.py's document half, ids, the timeline, parameters
//!   `docfile`      .funda and .fundab on disk
//!   `link`         the geometry engine, spawned or joined
//!   `app_session`  is FundaCAD open, and how do I reach it
//!   `live`         the agent's half of a live session
//!   `upload`       a file arriving inline, in one piece or several
//!   `render`       the z-buffered flat rasteriser `view` draws with
//!   `describe`     an inspect report, as something worth reading
//!   `schema`       the feature reference the agent reads first
//!
//! There are two worlds, as there were: PRIVATE holds the document in this
//! process and spawns its own engine, LIVE works on the document a running
//! FundaCAD has open. `server` is what knows which.

pub mod app_session;
pub mod describe;
pub mod docfile;
pub mod link;
pub mod live;
pub mod model;
pub mod png;
pub mod render;
pub mod schema;
pub mod server;
pub mod tools;
pub mod upload;
