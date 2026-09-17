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

/// One thread on purpose. The SDK spawns a task per request, so on a
/// multi-threaded runtime two tool calls arriving together reach the server's
/// turn lock in whichever order the scheduler picked, and an agent that sends
/// `feature_add` and `build` in one turn can get them the other way round. A
/// current-thread runtime polls tasks in the order they were spawned, which is
/// the order the messages arrived, which is what the Python server's single
/// read loop gave for free.
#[tokio::main(flavor = "current_thread")]
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
