use std::net::IpAddr;

use fundacad_lib::plugins::localnet::{is_local, target_of};

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

#[test]
fn only_local_addresses_are_local() {
    for ok in ["192.168.0.46", "10.1.2.3", "172.16.0.1", "169.254.10.10", "fd00::1", "fe80::1", "::ffff:192.168.1.2"] {
        assert!(is_local(ip(ok)), "{ok}");
    }
    for bad in ["127.0.0.1", "8.8.8.8", "172.32.0.1", "::1", "2001:db8::1", "0.0.0.0", "::ffff:8.8.8.8"] {
        assert!(!is_local(ip(bad)), "{bad}");
    }
}

#[test]
fn targets_are_http_with_a_host_and_port() {
    let t = |s: &str| target_of(&reqwest::Url::parse(s).unwrap());
    assert_eq!(t("http://192.168.0.46:7125/x").unwrap(), ("192.168.0.46".into(), 7125, Some(ip("192.168.0.46"))));
    assert_eq!(t("http://device.local/").unwrap().1, 80);
    assert_eq!(t("http://[fe80::1]:8080/").unwrap().2, Some(ip("fe80::1")));
    assert!(t("file:///etc/passwd").is_err());
    assert!(t("http://user:pw@192.168.0.2/").is_err());
}
