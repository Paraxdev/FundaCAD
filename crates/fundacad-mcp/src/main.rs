//! `fundacad-mcp`, the standalone MCP server on stdio.

fn main() -> std::process::ExitCode {
    match fundacad_mcp::run_stdio() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(()) => std::process::ExitCode::FAILURE,
    }
}
