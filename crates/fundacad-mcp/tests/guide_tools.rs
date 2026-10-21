//! Guide mode over the real wire: a real engine, `fundacad-mcp` over stdio, and a
//! host loop that answers `session_guide` the way `src/ui/guide/guideSession.ts` does.
//! The window's own rules are in tests/ui/guide; this holds the tools' replies
//! and the refusals, which are what an assistant reads.

mod common;

use common::{env, Host, Mcp, RealEngine, ToolReply};
use fundacad_mcp::guide::{NO_WINDOW, OLD_WINDOW, STANDALONE};
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq)]
enum User {
    /// Takes steps and waits, never decides a wait.
    Watches,
    PressesNext,
    PressesStop,
}

/// What GuideSession publishes, reduced to the fields the tools read.
struct Window {
    host: Host,
    user: User,
    state: Value,
    /// An old window publishes its document and never answers the guide.
    old: bool,
}

impl Window {
    fn new(host: Host, user: User) -> Window {
        Window { host, user, state: json!({"ack": 0, "step": null, "wait": null, "stopped": null}), old: false }
    }

    async fn tick(&mut self) {
        self.host.tick().await;
        if self.old {
            return;
        }
        let reply = self.host.call("session_guide", json!({"state": self.state})).await;
        let commands = reply["result"]["commands"].as_array().cloned().unwrap_or_default();
        for c in commands {
            let seq = c["seq"].clone();
            match c["kind"].as_str() {
                Some("highlight") => {
                    let found = c["target"]["ui"] != json!("nope:x");
                    self.state["step"] = json!({"seq": seq, "step": c["step"], "of": c["of"], "found": found,
                        "via": if c["target"]["ui"] == json!("pick:fillet") { json!("family:cat:MODIFY") } else { Value::Null },
                        "missing": if found { Value::Null } else { json!("no control \"nope:x\" on screen") },
                        "near": ["family:cat:MODIFY"], "next": false});
                }
                Some("clear") => self.state["step"] = Value::Null,
                Some("wait") => {
                    self.state["wait"] = json!({"seq": seq, "until": c["until"], "done": null, "what": null});
                    match self.user {
                        User::PressesNext => {
                            self.state["wait"]["done"] = json!("next");
                            self.state["wait"]["what"] = json!("Next pressed");
                        }
                        User::PressesStop => {
                            let at = self.state["step"].clone();
                            let n = self.state["stopped"]["n"].as_i64().unwrap_or(0) + 1;
                            self.state["stopped"] = json!({"n": n, "step": at["step"], "of": at["of"]});
                            self.state["wait"]["done"] = json!("stopped");
                            self.state["wait"]["what"] = json!(format!(
                                "the user stopped the guide at step {} of {}, everything is cleared", at["step"], at["of"]));
                            self.state["step"] = Value::Null;
                        }
                        User::Watches => {}
                    }
                }
                _ => {}
            }
            self.state["ack"] = seq;
        }
    }

    async fn pump(&mut self, seconds: f64) {
        let end = std::time::Instant::now() + std::time::Duration::from_secs_f64(seconds);
        while std::time::Instant::now() < end {
            self.tick().await;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}

async fn call(mut mcp: Mcp, window: &mut Window, name: &'static str, args: Value) -> (Mcp, ToolReply) {
    let handle = tokio::task::spawn_blocking(move || {
        let reply = mcp.call(name, args);
        (mcp, reply)
    });
    while !handle.is_finished() {
        window.pump(0.2).await;
    }
    handle.await.expect("the tool call thread")
}

async fn attached(user: User) -> (RealEngine, Window, Mcp) {
    let engine = RealEngine::start();
    let mut window = Window::new(Host::new(engine.socket().await), user);
    window.tick().await;
    let mcp = Mcp::start(&engine.mcp_env("auto", true), &std::env::temp_dir());
    (engine, window, mcp)
}

fn names(mcp: &mut Mcp) -> Vec<String> {
    mcp.tools().iter().filter_map(|t| t["name"].as_str().map(String::from)).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_guide_tools_are_listed_in_every_mode() {
    let engine = RealEngine::start();
    for mode in ["auto", "standalone"] {
        let mut mcp = Mcp::start(&engine.mcp_env(mode, false), &std::env::temp_dir());
        let have = names(&mut mcp);
        for t in ["guide_highlight", "guide_wait", "guide_clear"] {
            assert!(have.iter().any(|n| n == t), "{mode} lacks {t}: {have:?}");
        }
    }
}

#[test]
fn standalone_refuses_and_says_why() {
    let mut mcp = Mcp::start(&env(&[("FUNDACAD_MCP_MODE", "standalone")]), &std::env::temp_dir());
    let out = mcp.call("guide_highlight", json!({"ui": "pick:fillet", "caption": "Open Fillet"}));
    assert!(out.is_error);
    assert_eq!(out.text, STANDALONE);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_private_server_refuses_because_no_window_shares() {
    let engine = RealEngine::start();
    let mut mcp = Mcp::start(&engine.mcp_env("auto", false), &std::env::temp_dir());
    let out = mcp.call("guide_wait", json!({}));
    assert!(out.is_error);
    assert!(out.text.starts_with(NO_WINDOW), "{}", out.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_highlight_returns_once_the_window_has_taken_it() {
    let (_engine, mut window, mcp) = attached(User::Watches).await;
    let (mcp, out) = call(mcp, &mut window, "guide_highlight",
        json!({"ui": "pick:fillet", "caption": "Open Fillet", "step": 1, "of": 3})).await;
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(out.text, "step 1 of 3 is up on family:cat:MODIFY: pick:fillet is folded inside it, the ring moves there once the user opens it");
    assert_eq!(window.state["step"]["seq"], window.state["ack"]);

    let (_mcp, out) = call(mcp, &mut window, "guide_highlight", json!({"ui": "nope:x", "caption": "?"})).await;
    assert!(out.is_error);
    assert!(out.text.contains("no control \"nope:x\"") && out.text.contains("Near: family:cat:MODIFY"), "{}", out.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wait_says_next_was_pressed() {
    let (_engine, mut window, mcp) = attached(User::PressesNext).await;
    let (mcp, _) = call(mcp, &mut window, "guide_highlight", json!({"ui": "#browser", "caption": "Items", "step": 1, "of": 2})).await;
    let (mcp, out) = call(mcp, &mut window, "guide_wait", json!({"until": "next"})).await;
    assert_eq!((out.is_error, out.text.as_str()), (false, "Next pressed"));
    let (_mcp, out) = call(mcp, &mut window, "guide_clear", json!({})).await;
    assert_eq!(out.text, "the guide is cleared");
    assert!(window.state["step"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_clears_and_is_told_once() {
    let (_engine, mut window, mcp) = attached(User::PressesStop).await;
    let (mcp, _) = call(mcp, &mut window, "guide_highlight", json!({"ui": "#browser", "caption": "Items", "step": 2, "of": 3})).await;
    let (mcp, out) = call(mcp, &mut window, "guide_wait", json!({"until": ["next", "tool"]})).await;
    assert_eq!(out.text, "the user stopped the guide at step 2 of 3, everything is cleared");
    assert!(window.state["step"].is_null());
    window.user = User::Watches;
    let (_mcp, out) = call(mcp, &mut window, "guide_highlight", json!({"ui": "#browser", "caption": "again"})).await;
    assert!(!out.is_error, "a stop already told was told again: {}", out.text);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_older_than_guide_mode_is_named_after_three_seconds() {
    let (_engine, mut window, mcp) = attached(User::Watches).await;
    window.old = true;
    let started = std::time::Instant::now();
    let (_mcp, out) = call(mcp, &mut window, "guide_highlight", json!({"ui": "#browser", "caption": "Items"})).await;
    assert!(out.is_error);
    assert_eq!(out.text, OLD_WINDOW);
    assert!(started.elapsed().as_secs_f64() < 6.0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_from_before_this_server_is_not_reported() {
    let (_engine, mut window, mcp) = attached(User::Watches).await;
    window.state["stopped"] = json!({"n": 1, "step": 1, "of": 2});
    window.tick().await;
    let (_mcp, out) = call(mcp, &mut window, "guide_highlight", json!({"ui": "#browser", "caption": "Items"})).await;
    assert_eq!((out.is_error, out.text.as_str()), (false, "the step is up on #browser"));
}
