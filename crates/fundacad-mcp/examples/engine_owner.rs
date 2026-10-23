//! An engine owner for `tests/lifetime.rs` to kill. `job` holds the engine in the kill-on-close job
//! object; `nojob` is the control, whose engine must outlive a hard kill or the test proves nothing.

use std::io::Write;

use fundacad_mcp::link::{engine_command, EngineLink};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let job = std::env::args().nth(1).as_deref() != Some("nojob");
    let pid = if job {
        let link = EngineLink::private();
        // A real request, since an engine that has not finished starting is not what leaks.
        link.call("ping", serde_json::json!({})).await.expect("the engine answers");
        let pid = link.engine_pid().await.expect("it spawned one");
        // Leaked on purpose: dropping the link would kill the engine tidily.
        std::mem::forget(link);
        pid
    } else {
        let argv = engine_command();
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..])
            .arg("--ws")
            .env("FUNDACAD_ENGINE_PORT", "0")
            .env("FUNDACAD_ENGINE_TOKEN", "lifetime-control")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        cmd.spawn().expect("the engine binary is built").id()
    };
    println!("PID {pid}");
    let _ = std::io::stdout().flush();
    std::thread::sleep(std::time::Duration::from_secs(600));
}
