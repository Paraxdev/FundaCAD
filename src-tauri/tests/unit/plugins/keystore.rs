use fundacad_lib::plugins::keystore::{plugin_secret_get, plugin_secret_set};

#[test]
fn names_that_could_reach_another_entry_are_refused() {
    // The mock store reads a good name back as None, so each error below is the name's refusal.
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    assert!(plugin_secret_get("FundaCAD.Onshape".into(), "key".into()).unwrap().is_none());
    assert!(plugin_secret_get("FundaCAD.Onshape".into(), "../Other/key".into()).is_err());
    assert!(plugin_secret_get("FundaCAD.Onshape".into(), "a/b".into()).is_err());
    assert!(plugin_secret_get("../x".into(), "key".into()).is_err());
    assert!(plugin_secret_set("FundaCAD.Onshape".into(), "key".into(), String::new()).is_err());
}
