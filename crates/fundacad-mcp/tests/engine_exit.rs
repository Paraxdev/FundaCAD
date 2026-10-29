use fundacad_mcp::link::EngineLink;
use serde_json::json;
use std::io::ErrorKind;

// One test per binary: FUNDACAD_ENGINE_CMD is process wide.
#[tokio::test]
async fn an_engine_that_exits_on_a_taken_port_every_time_is_given_up_after_the_tries() {
    let cmd = if cfg!(windows) { "cmd /c exit 3" } else { "sh -c 'exit 3'" };
    std::env::set_var("FUNDACAD_ENGINE_CMD", cmd);
    let link = EngineLink::private();
    let first = link.port();
    let err = link.call("ping", json!({})).await.expect_err("no engine ever starts");
    assert_eq!(err.kind(), ErrorKind::AddrInUse, "{err}");
    assert_ne!(link.port(), first);

    std::env::set_var("FUNDACAD_ENGINE_CMD", if cfg!(windows) { "cmd /c exit 1" } else { "sh -c 'exit 1'" });
    let link = EngineLink::private();
    let kept = link.port();
    let err = link.call("ping", json!({})).await.expect_err("the engine fails to start");
    assert_eq!(err.to_string(), "the geometry engine exited before it was ready");
    assert_eq!(link.port(), kept, "an exit for another reason is not retried on a new port");
}
