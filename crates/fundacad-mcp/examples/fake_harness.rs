//! A stand in for `python -m fundacad_harness serve`, so `tests/ui_tools.rs`
//! needs no Python, browser or engine. Its `open` reply says how it was started.
//!
//! A `do` step with `"do": "fail"` fails. With `FAKE_HARNESS_HOLD=1` it does
//! not exit when stdin ends, so only something holding it can end it. With
//! `FAKE_HARNESS_MISSING=1` it fails the way a Python without the package does.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

fn answer(req: &Value) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let args = req.get("args").cloned().unwrap_or_else(|| json!({}));
    let status = "mode model, no tool";
    match req.get("call").and_then(Value::as_str) {
        Some("open") => json!({"id": id, "ok": true, "text": format!(
            "opened a private copy of the app, not your window, pid {}, argv {}, engine {}, args {}\n{status}",
            std::process::id(),
            std::env::args().skip(1).collect::<Vec<_>>().join(" "),
            std::env::var("FUNDACAD_ENGINE_CMD").unwrap_or_else(|_| "unset".into()),
            args
        )}),
        Some("do") => {
            let mut lines = Vec::new();
            let steps = args.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
            for (i, step) in steps.iter().enumerate() {
                let verb = step.get("do").and_then(Value::as_str).unwrap_or("?");
                if verb == "fail" {
                    lines.push(format!("{}. failed: NotFound no control called \"Nope\"", i + 1));
                    lines.push(String::new());
                    lines.push(status.into());
                    return json!({"id": id, "ok": false, "text": lines.join("\n")});
                }
                lines.push(format!("{}. did {verb} {step}", i + 1));
            }
            lines.push(String::new());
            lines.push(status.into());
            json!({"id": id, "ok": true, "text": lines.join("\n")})
        }
        Some("read") => json!({"id": id, "ok": true, "text": format!("read {args}")}),
        Some("shot") => json!({"id": id, "ok": true, "text": format!("screenshot {args}"), "png": PNG_1PX}),
        Some("close") => json!({"id": id, "ok": true, "text": "closed the app, its browser and its engine"}),
        other => json!({"id": id, "ok": false, "text": format!("unknown call {other:?}")}),
    }
}

fn main() {
    if std::env::var("FAKE_HARNESS_MISSING").as_deref() == Ok("1") {
        eprintln!("No module named fundacad_harness");
        std::process::exit(1);
    }
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let req: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        let _ = writeln!(out, "{}", answer(&req));
        let _ = out.flush();
    }
    if std::env::var("FAKE_HARNESS_HOLD").as_deref() == Ok("1") {
        std::thread::sleep(std::time::Duration::from_secs(600));
    }
}
