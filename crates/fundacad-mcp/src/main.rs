//! `fundacad-mcp`, the MCP server, on stdio.
//!
//! The entry point, and the one place a start-up refusal is phrased.
//! `FUNDACAD_MCP_MODE=attach` with no app open refuses on purpose. A backtrace
//! would say the same thing in twenty lines of a log the user may never open,
//! so it is caught and stated once: stderr is what an MCP host shows.

use fundacad_mcp::link::mode_from_env;
use fundacad_mcp::server::{log, FundaCad};
use rmcp::transport::stdio;
use rmcp::ServiceExt;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let server = match FundaCad::attach(mode_from_env()).await {
        Ok(s) => s,
        Err(why) => {
            log(&format!("[mcp] {why}"));
            return std::process::ExitCode::FAILURE;
        }
    };
    let running = match server.clone().serve(stdio()).await {
        Ok(r) => r,
        Err(e) => {
            log(&format!("[mcp] the stdio transport failed: {e}"));
            server.shutdown().await;
            return std::process::ExitCode::FAILURE;
        }
    };
    let _ = running.waiting().await;
    server.shutdown().await;
    std::process::ExitCode::SUCCESS
}
