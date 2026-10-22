use fundacad_lib::plugins::web::{check_target, host_allowed};

fn list(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_leading_dot_is_one_level_of_subdomain() {
    let l = list(&[".onshape.com"]);
    assert!(host_allowed("cad.onshape.com", &l));
    assert!(host_allowed("ACME.onshape.com", &l));
    for bad in ["onshape.com", "evilonshape.com", "a.b.onshape.com", "onshape.com.evil.net", "cad.onshape.co"] {
        assert!(!host_allowed(bad, &l), "{bad}");
    }
    assert!(host_allowed("api.example.com", &list(&["api.example.com"])));
    assert!(!host_allowed("x.api.example.com", &list(&["api.example.com"])));
    assert!(!host_allowed("cad.onshape.com", &[]));
}

#[test]
fn only_https_to_a_named_allowed_host() {
    let l = list(&[".onshape.com"]);
    let t = |s: &str| check_target(&reqwest::Url::parse(s).unwrap(), &l);
    assert_eq!(t("https://cad.onshape.com/api/x").unwrap(), ("cad.onshape.com".into(), 443));
    assert!(t("http://cad.onshape.com/api/x").is_err());
    assert!(t("https://evil.com/api/x").is_err());
    assert!(t("https://1.2.3.4/").is_err());
    assert!(t("https://[::1]/").is_err());
    assert!(t("https://user:pw@cad.onshape.com/").is_err());
}
