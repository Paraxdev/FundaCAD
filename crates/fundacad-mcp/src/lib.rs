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
pub mod blobs;
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

/// Runs the MCP server on stdio for either the standalone binary or the
/// desktop executable's `--mcp` mode.
pub fn run_stdio() -> Result<(), ()> {
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.map_err(|e| {
			server::log(&format!("[mcp] could not start the runtime: {e}"));
		})?;
	runtime.block_on(async {
		use rmcp::ServiceExt;

		let service = match server::FundaCad::attach(link::mode_from_env()).await {
			Ok(service) => service,
			Err(why) => {
				server::log(&format!("[mcp] {why}"));
				return Err(());
			}
		};
		let running = match service.clone().serve(rmcp::transport::stdio()).await {
			Ok(running) => running,
			Err(e) => {
				server::log(&format!("[mcp] the stdio transport failed: {e}"));
				service.shutdown().await;
				return Err(());
			}
		};
		let _ = running.waiting().await;
		service.shutdown().await;
		Ok(())
	})
}
