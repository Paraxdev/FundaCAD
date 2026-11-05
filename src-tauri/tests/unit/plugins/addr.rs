use std::net::IpAddr;

use fundacad_lib::plugins::addr::is_public;

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

#[test]
fn an_ipv6_form_that_carries_a_private_ipv4_is_not_public() {
    for bad in [
        "64:ff9b::c0a8:101",
        "64:ff9b::7f00:1",
        "64:ff9b:1::a00:1",
        "2002:c0a8:101::1",
        "2002:7f00:1::",
        "::c0a8:101",
        "::7f00:1",
        "::a00:1",
        "fec0::1",
        "ff02::1",
        "ff0e::1",
        "224.0.0.1",
    ] {
        assert!(!is_public(ip(bad)), "{bad}");
    }
}

#[test]
fn an_ipv6_form_that_carries_a_public_ipv4_stays_public() {
    for ok in ["64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111", "2a00:1450:4001::200e", "8.8.8.8"] {
        assert!(is_public(ip(ok)), "{ok}");
    }
}
