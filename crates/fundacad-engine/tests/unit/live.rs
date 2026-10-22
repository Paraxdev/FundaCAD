use fundacad_engine::live::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const APP: &str = "app";
const AGENT: &str = "agent";
const OTHER: &str = "other";

fn session() -> (LiveSession, Arc<AtomicU64>) {
    let t = Arc::new(AtomicU64::new(1000.0f64.to_bits()));
    let c = t.clone();
    (LiveSession::new(Box::new(move || f64::from_bits(c.load(Ordering::SeqCst)))), t)
}

fn advance(t: &AtomicU64, by: f64) {
    t.store((f64::from_bits(t.load(Ordering::SeqCst)) + by).to_bits(), Ordering::SeqCst);
}

fn doc(n: usize) -> Value {
    json!({"parameters": {}, "features": (0..n).map(|i| json!({"id": format!("f{i}"), "type": "box"})).collect::<Vec<_>>()})
}

fn publish(s: &mut LiveSession, host: &str, d: Value, rev: i64) -> Value {
    s.publish(host, d, rev, Value::Null, Value::Null)
}

fn features(v: &Value) -> usize {
    v["features"].as_array().map_or(0, Vec::len)
}

#[test]
fn nothing_is_shared_until_an_app_shares_it() {
    let (mut s, _) = session();
    let st = s.state(Some(AGENT), None);
    assert_eq!(st["attached"], false);
    assert!(st["document"].is_null());
    let r = s.propose(AGENT, doc(1), 0, None, None);
    assert_eq!((r["ok"].clone(), r["reason"].clone()), (json!(false), json!("no-host")));
}

#[test]
fn a_guest_reads_exactly_what_the_app_published() {
    let (mut s, _) = session();
    s.publish(APP, doc(3), 7, json!("spool.funda"), json!({"errors": []}));
    let st = s.state(Some(AGENT), None);
    assert_eq!(st["attached"], true);
    assert_eq!((st["revision"].clone(), st["title"].clone()), (json!(7), json!("spool.funda")));
    assert_eq!(features(&st["document"]), 3);
}

#[test]
fn a_guest_cannot_install_a_document_only_offer_one() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(3), 7);
    let r = s.propose(AGENT, doc(99), 7, Some(&json!("add a hole")), None);
    assert_eq!(r["ok"], true);
    assert_eq!(r["proposal"], "p1");
    let st = s.state(Some(OTHER), None);
    assert_eq!(features(&st["document"]), 3);
    assert_eq!(st["revision"], 7);
}

#[test]
fn the_host_collects_proposals_once() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(3), 7);
    s.propose(AGENT, doc(4), 7, Some(&json!("add a hole")), None);
    let got = publish(&mut s, APP, doc(3), 7);
    let p = &got["proposals"];
    assert_eq!(p.as_array().unwrap().len(), 1);
    assert_eq!(p[0]["note"], "add a hole");
    assert_eq!(features(&p[0]["document"]), 4);
    let keys: Vec<&String> = p[0].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["id", "guest", "name", "note", "baseRevision", "document", "at"]);
    assert_eq!(publish(&mut s, APP, doc(4), 8)["proposals"], json!([]));
}

#[test]
fn an_edit_against_an_older_document_is_refused() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(3), 7);
    publish(&mut s, APP, doc(5), 8);
    let r = s.propose(AGENT, doc(4), 7, None, None);
    assert_eq!((r["ok"].clone(), r["reason"].clone(), r["revision"].clone()), (json!(false), json!("stale"), json!(8)));
    assert!(r["message"].as_str().unwrap().contains("8"));
    assert_eq!(s.propose(AGENT, doc(4), 8, None, None)["ok"], true);
}

#[test]
fn a_backlog_is_refused_rather_than_grown() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    for _ in 0..MAX_PENDING {
        assert_eq!(s.propose(AGENT, doc(2), 1, None, None)["ok"], true);
    }
    assert_eq!(s.propose(AGENT, doc(2), 1, None, None)["reason"], "backlog");
}

#[test]
fn a_guest_lease_is_refreshed_by_working_and_expires_by_not() {
    let (mut s, t) = session();
    publish(&mut s, APP, doc(1), 1);
    s.state(Some(AGENT), Some(&json!("an assistant")));
    assert_eq!(s.guest_names(), ["an assistant"]);
    advance(&t, GUEST_TTL - 1.0);
    assert_eq!(s.guest_names(), ["an assistant"]);
    advance(&t, 2.0);
    assert!(s.guest_names().is_empty());
}

#[test]
fn an_expired_guest_takes_its_unread_proposals_with_it() {
    let (mut s, t) = session();
    publish(&mut s, APP, doc(1), 1);
    s.propose(AGENT, doc(2), 1, None, Some(&json!("an assistant")));
    advance(&t, GUEST_TTL + 1.0);
    assert_eq!(publish(&mut s, APP, doc(1), 1)["proposals"], json!([]));
}

#[test]
fn leaving_withdraws_only_that_guests_edits() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    s.propose(AGENT, doc(2), 1, None, None);
    s.propose(OTHER, doc(3), 1, None, None);
    s.leave(AGENT);
    let got = publish(&mut s, APP, doc(1), 1);
    assert_eq!(got["proposals"].as_array().unwrap().len(), 1);
    assert_eq!(got["proposals"][0]["guest"], OTHER);
}

#[test]
fn a_new_host_takes_over_and_inherits_no_edits() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(3), 7);
    s.propose(AGENT, doc(4), 7, None, None);
    assert_eq!(publish(&mut s, "app2", doc(9), 1)["proposals"], json!([]));
    assert_eq!(s.state(None, None)["revision"], 1);
}

#[test]
fn only_the_host_can_end_the_session() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(3), 7);
    assert_eq!(s.release(AGENT)["ok"], false);
    assert_eq!(s.state(None, None)["attached"], true);
    assert_eq!(s.release(APP)["ok"], true);
    let st = s.state(None, None);
    assert_eq!(st["attached"], false);
    assert!(st["document"].is_null());
}

#[test]
fn a_connection_is_named_by_its_part_in_the_session() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    s.state(Some(AGENT), Some(&json!("Claude")));
    assert_eq!(s.role_of(APP), json!({"who": "app"}));
    assert_eq!(s.role_of(AGENT), json!({"who": "assistant", "name": "Claude"}));
    assert_eq!(s.role_of(OTHER), json!({"who": "session"}));
}

#[test]
fn a_guest_note_is_capped() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    s.propose(AGENT, doc(2), 1, Some(&json!("x".repeat(10_000))), None);
    let note = publish(&mut s, APP, doc(1), 1)["proposals"][0]["note"].as_str().unwrap().len();
    assert_eq!(note, MAX_NOTE);
}

#[test]
fn the_wire_ops_read_revisions_like_python() {
    let (mut s, _) = session();
    let req = |v: Value| v.as_object().unwrap().clone();
    let r =
        session_reply(&mut s, "c1", "session_host", &req(json!({"document": doc(1), "revision": 3.0, "title": "t"})))
            .unwrap();
    assert_eq!(r, json!({"ok": true, "guests": [], "proposals": []}));
    let r =
        session_reply(&mut s, "c2", "session_propose", &req(json!({"document": doc(2), "baseRevision": 3}))).unwrap();
    assert_eq!(r, json!({"ok": true, "proposal": "p1", "revision": 3}));
    let st = session_reply(&mut s, "c2", "session_state", &req(json!({}))).unwrap();
    assert_eq!(st["guests"], json!(["c2"]));
    assert!(session_reply(&mut s, "c2", "session_nope", &req(json!({}))).is_err());
}

fn wire(s: &mut LiveSession, who: &str, op: &str, v: Value) -> Value {
    session_reply(s, who, op, v.as_object().unwrap()).unwrap()
}

fn highlight(ui: &str) -> Value {
    json!({"command": {"kind": "highlight", "target": {"ui": ui}, "caption": "here", "step": 1, "of": 3}})
}

#[test]
fn a_guide_command_reaches_the_host_once_and_never_carries_the_document() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(3), 1);
    let r = wire(&mut s, AGENT, "session_guide", highlight("pick:fillet"));
    assert_eq!(r["ok"], true);
    assert!(r.get("document").is_none());
    let seq = r["seq"].as_i64().unwrap();
    let h = wire(&mut s, APP, "session_guide", json!({"state": {"ack": seq}}));
    let cmds = h["commands"].as_array().unwrap();
    assert_eq!(cmds.len(), 1);
    assert_eq!((cmds[0]["seq"].clone(), cmds[0]["target"]["ui"].clone()), (json!(seq), json!("pick:fillet")));
    let h = wire(&mut s, APP, "session_guide", json!({"state": {"ack": seq}}));
    assert_eq!(h["commands"], json!([]));
    let g = wire(&mut s, AGENT, "session_guide", json!({}));
    assert_eq!(g["guide"]["ack"], seq);
    assert!(g["seq"].is_null());
    assert!(g.get("document").is_none());
    assert_eq!(s.guest_names(), [AGENT]);
}

#[test]
fn a_guide_needs_a_window_sharing_its_document() {
    let (mut s, _) = session();
    let r = wire(&mut s, AGENT, "session_guide", highlight("pick:fillet"));
    assert_eq!((r["ok"].clone(), r["reason"].clone()), (json!(false), json!("no-host")));
}

#[test]
fn only_the_newest_step_and_the_newest_wait_are_kept() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    wire(&mut s, AGENT, "session_guide", highlight("a"));
    wire(&mut s, AGENT, "session_guide", json!({"command": {"kind": "wait", "until": "next"}}));
    wire(&mut s, AGENT, "session_guide", highlight("b"));
    let w = wire(&mut s, AGENT, "session_guide", json!({"command": {"kind": "wait", "until": "tool"}}))["seq"].clone();
    let cmds = wire(&mut s, APP, "session_guide", json!({"state": {}}))["commands"].clone();
    let got: Vec<(Value, Value)> =
        cmds.as_array().unwrap().iter().map(|c| (c["kind"].clone(), c["seq"].clone())).collect();
    assert_eq!(got, [(json!("highlight"), json!(3)), (json!("wait"), w)]);
    assert_eq!(cmds[0]["target"]["ui"], "b");
}

#[test]
fn a_leaving_or_expired_guest_takes_its_guide_commands_with_it() {
    let (mut s, t) = session();
    publish(&mut s, APP, doc(1), 1);
    wire(&mut s, AGENT, "session_guide", highlight("a"));
    s.leave(AGENT);
    assert_eq!(wire(&mut s, APP, "session_guide", json!({"state": {}}))["commands"], json!([]));
    wire(&mut s, AGENT, "session_guide", highlight("a"));
    advance(&t, GUEST_TTL + 1.0);
    assert_eq!(wire(&mut s, APP, "session_guide", json!({"state": {}}))["commands"], json!([]));
}

#[test]
fn a_new_host_inherits_no_guide() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    wire(&mut s, APP, "session_guide", json!({"state": {"ack": 4}}));
    wire(&mut s, AGENT, "session_guide", highlight("a"));
    publish(&mut s, "app2", doc(1), 1);
    assert!(wire(&mut s, AGENT, "session_guide", json!({}))["guide"].is_null());
    assert_eq!(wire(&mut s, "app2", "session_guide", json!({"state": null}))["commands"], json!([]));
}

#[test]
fn only_the_host_reports_what_the_guide_shows() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    let r = wire(&mut s, AGENT, "session_guide", json!({"state": {"ack": 9}}));
    assert_eq!((r["ok"].clone(), r["reason"].clone()), (json!(false), json!("not the host")));
    assert!(wire(&mut s, OTHER, "session_guide", json!({}))["guide"].is_null());
    assert!(is_session_op("session_guide"));
}

#[test]
fn a_guide_caption_is_capped() {
    let (mut s, _) = session();
    publish(&mut s, APP, doc(1), 1);
    wire(&mut s, AGENT, "session_guide", json!({"command": {"kind": "highlight", "caption": "x".repeat(5000)}}));
    let c = wire(&mut s, APP, "session_guide", json!({"state": {}}))["commands"][0]["caption"].as_str().unwrap().len();
    assert_eq!(c, MAX_CAPTION);
}

#[test]
fn a_proposal_for_a_document_the_app_closed_never_reaches_the_next_one() {
    let (mut s, _) = session();
    s.publish_doc(APP, json!("doc-a"), doc(3), 7, Value::Null, Value::Null);
    assert_eq!(s.state(Some(AGENT), None)["doc"], "doc-a");
    let accepted = s.propose_doc(AGENT, doc(4), 7, Some(&json!("doc-a")), None, None);
    s.guide_guest(AGENT, Some(&json!({"kind": "wait", "text": "Press Next"})), None);

    // The app opened B before its next publish: what was asked for A is dropped, not handed to B.
    let handed = s.publish_doc(APP, json!("doc-b"), doc(0), 8, Value::Null, Value::Null);
    let late = s.propose_doc(AGENT, doc(5), 8, Some(&json!("doc-a")), None, None);
    let for_b = s.propose_doc(AGENT, doc(1), 8, Some(&json!("doc-b")), None, None);
    let unnamed = s.propose(AGENT, doc(2), 8, None, None);
    let next = s.publish_doc(APP, json!("doc-b"), doc(0), 8, Value::Null, Value::Null);
    let proposals: Vec<(Value, usize)> = next["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p.get("doc").cloned().unwrap_or(Value::Null), features(&p["document"])))
        .collect();
    assert_eq!(
        (accepted["ok"].clone(), handed["proposals"].clone(), late["reason"].clone(), late["message"].clone()),
        (json!(true), json!([]), json!("doc-changed"), json!("the document in the app changed, nothing was applied"))
    );
    assert_eq!((for_b["ok"].clone(), unnamed["ok"].clone()), (json!(true), json!(true)));
    assert_eq!(proposals, vec![(json!("doc-b"), 1), (json!("doc-b"), 2)]);
    assert_eq!(s.guide_host(APP, Value::Null)["commands"], json!([]), "a guide command made for A reached B");

    // A host that names no document keeps today's behaviour, and its state carries no doc.
    let (mut plain, _) = session();
    publish(&mut plain, APP, doc(1), 1);
    plain.propose(AGENT, doc(2), 1, None, None);
    assert_eq!(features(&publish(&mut plain, APP, doc(1), 1)["proposals"][0]["document"]), 2);
    assert!(plain.state(Some(AGENT), None).get("doc").is_none());
}
