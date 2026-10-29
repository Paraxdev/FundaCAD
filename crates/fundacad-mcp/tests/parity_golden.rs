//! Replays tools/parity.jsonl on a fresh private server and wants every reply word for word as in the
//! Python server's frozen transcript, tests/golden/mcp_parity.golden.json.

mod common;

use std::path::{Path, PathBuf};

use common::{env, Mcp};
use serde_json::{json, Value};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// An absolute POSIX path as the server resolves it on this machine, which on
/// Windows puts the working directory's drive in front.
fn resolved(p: &str, cwd: &Path) -> String {
    if cfg!(windows) {
        let cwd = cwd.to_string_lossy();
        let drive: String = cwd.trim_start_matches(r"\\?\").chars().take(2).collect();
        format!("{drive}{}", p.replace('/', "\\"))
    } else {
        p.to_owned()
    }
}

/// freeze_goldens.posix_paths on this side's reply.
fn posix_paths(text: &str, args: &Value, cwd: &Path) -> String {
    let mut text = text.to_owned();
    for value in args.as_object().into_iter().flat_map(|m| m.values()) {
        let Some(v) = value.as_str().filter(|v| v.starts_with('/')) else {
            continue;
        };
        let dir = match v.rfind('/') {
            Some(0) => "/",
            Some(i) => &v[..i],
            None => v,
        };
        for p in [v, dir] {
            text = text.replace(&resolved(p, cwd), p);
        }
    }
    text
}

#[test]
fn the_parity_script_answers_as_the_python_server_did() {
    let root = repo();
    let golden: Value = serde_json::from_slice(
        &std::fs::read(root.join("tests/golden/mcp_parity.golden.json")).expect("the golden transcript"),
    )
    .expect("JSON");
    let script = std::fs::read_to_string(root.join("crates/fundacad-mcp/tools/parity.jsonl")).expect("the script");
    let steps: Vec<Value> = script
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("one call per line"))
        .collect();
    let cases = golden["cases"].as_array().expect("cases");
    assert_eq!(steps.len(), cases.len(), "the script and the transcript have different lengths");

    let cwd = std::env::temp_dir().join(format!("fundacad-mcp-parity-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("a working directory");
    let mut mcp = Mcp::start(&env(&[("FUNDACAD_MCP_MODE", "standalone")]), &cwd);
    let mut differences = Vec::new();
    for (i, (step, want)) in steps.iter().zip(cases).enumerate() {
        let tool = step["tool"].as_str().expect("a tool");
        let args = step.get("args").cloned().unwrap_or_else(|| json!({}));
        assert!(want["tool"] == tool && want["args"] == args, "call {i} is not the one the transcript recorded");
        let msg = mcp.rpc("tools/call", json!({"name": tool, "arguments": args}));
        let result = &msg["result"];
        let text: Vec<&str> = result["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["type"] == "text")
            .filter_map(|c| c["text"].as_str())
            .collect();
        let text = posix_paths(&text.join("\n"), &args, &cwd);
        // The transcript was recorded when the document version was 9; a new
        // document is stamped with the current one, which the app writes too.
        let text = text.replace(&format!("\"version\": {}", fundacad_core::schema::DOCUMENT_VERSION), "\"version\": 9");
        // The Python server had no ui, guide or measure tools, so its list of tools lacks them.
        let text = if text.starts_with("No tool '") {
            [
                "guide_clear",
                "guide_highlight",
                "guide_wait",
                "measure",
                "ui_close",
                "ui_do",
                "ui_open",
                "ui_read",
                "ui_shot",
            ]
            .iter()
            .fold(text, |t, n| t.replace(&format!(", {n}"), ""))
        } else {
            text
        };
        // Nor the measure line of the schema's working order.
        let text = text.replace(
            " `measure` gives an exact\n   distance, wall, clearance, radius or angle between two of them, rather than\n   working it out from inspect's numbers.",
            "",
        );
        // Nor did it quote a shared note by its first line in a type's schema.
        let mut want_text = want["text"].as_str().unwrap_or("").to_string();
        if let (true, Some(kind)) = (tool == "schema", args["type"].as_str()) {
            for (field, note) in fundacad_mcp::schema::common() {
                let note = note.as_str().unwrap_or_default();
                let short = fundacad_mcp::schema::field_text(kind, field, note);
                want_text = want_text.replace(&format!("\n  {field}: {note}"), &format!("\n  {field}: {short}"));
            }
        }
        let is_error = result["isError"].as_bool().unwrap_or(false);
        if text != want_text || Some(is_error) != want["isError"].as_bool() {
            differences.push(format!(
                "call {i} {tool}{}:\n  python: {want_text:?}\n  rust:   {text:?}",
                if Some(is_error) != want["isError"].as_bool() { " (isError differs)" } else { "" }
            ));
        }
    }
    drop(mcp);
    let _ = std::fs::remove_dir_all(&cwd);
    assert!(
        differences.is_empty(),
        "{} of {} calls differ from the python server:\n{}",
        differences.len(),
        cases.len(),
        differences.join("\n")
    );
}
