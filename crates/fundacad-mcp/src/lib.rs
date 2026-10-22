//! FundaCAD over MCP (docs/MCP.md), on the Rust MCP SDK `rmcp` over stdio. PRIVATE holds the document
//! here and spawns its own engine, LIVE edits the one a running FundaCAD has open; `server` knows which.

pub mod app_session;
pub mod blobs;
pub mod clash;
pub mod describe;
pub mod docfile;
pub mod edits;
pub mod guide;
pub mod layflat;
pub mod link;
pub mod live;
pub mod looseends;
pub mod measure;
pub mod mesh;
pub mod model;
pub mod png;
pub mod render;
pub mod schema;
pub mod scope;
pub mod section;
pub mod server;
pub mod shadow;
pub mod shortcuts;
pub mod sketchmerge;
pub mod stress;
pub mod tools;
pub mod ui;
pub mod upload;

/// For both the standalone binary and the desktop executable's `--mcp` mode.
pub fn run_stdio() -> Result<(), ()> {
    if let Some(code) = shadow::run_from_copy() {
        return if code == 0 { Ok(()) } else { Err(()) };
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| {
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
