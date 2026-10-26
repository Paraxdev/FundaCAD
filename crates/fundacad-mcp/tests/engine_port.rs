use fundacad_mcp::link::EngineLink;
use serde_json::json;

#[tokio::test]
async fn a_private_engine_whose_port_was_taken_starts_on_a_fresh_one() {
    let link = EngineLink::private();
    let taken = link.port();
    let _held = std::net::TcpListener::bind(("127.0.0.1", taken)).expect("the picked port is still free");
    link.call("ping", json!({})).await.expect("the engine answers on another port");
    assert_ne!(link.port(), taken);
}

#[tokio::test]
async fn a_free_port_is_kept() {
    let link = EngineLink::private();
    let picked = link.port();
    link.call("ping", json!({})).await.expect("the engine answers");
    assert_eq!(link.port(), picked);
}
