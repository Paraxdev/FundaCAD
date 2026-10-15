//! A plugin's secrets, such as API keys, in the operating system's credential
//! store: Credential Manager on Windows, the Keychain on macOS, the Secret
//! Service on Linux. Never a file, never the document. When the store is not
//! there the call fails and says so, it does not fall back to plain text.

use keyring::Entry;

use super::bundle::safe_id;
use super::data::safe_name;

const SERVICE: &str = "FundaCAD";

fn entry(plugin: &str, name: &str) -> Result<Entry, String> {
    let user = format!("{}/{}", safe_id(plugin)?, safe_name(name)?);
    Entry::new(SERVICE, &user).map_err(store_error)
}

fn store_error(e: keyring::Error) -> String {
    format!("the system's credential store could not be used: {e}")
}

fn get(e: &Entry) -> Result<Option<String>, String> {
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(store_error(err)),
    }
}

fn delete(e: &Entry) -> Result<(), String> {
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(store_error(err)),
    }
}

#[tauri::command]
pub fn plugin_secret_set(plugin: String, name: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 2048 {
        return Err("a secret is 1 to 2048 characters".into());
    }
    entry(&plugin, &name)?.set_password(&value).map_err(store_error)
}

#[tauri::command]
pub fn plugin_secret_get(plugin: String, name: String) -> Result<Option<String>, String> {
    get(&entry(&plugin, &name)?)
}

#[tauri::command]
pub fn plugin_secret_delete(plugin: String, name: String) -> Result<(), String> {
    delete(&entry(&plugin, &name)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_round_trips_and_a_missing_one_is_none() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        // The mock keeps a value per Entry, not per name, so one Entry is reused.
        let e = entry("FundaCAD.Onshape", "secret-key").unwrap();
        assert_eq!(get(&e).unwrap(), None);
        e.set_password("s3cr3t").unwrap();
        assert_eq!(get(&e).unwrap().as_deref(), Some("s3cr3t"));
        delete(&e).unwrap();
        assert_eq!(get(&e).unwrap(), None);
        delete(&e).unwrap();
    }

    #[test]
    fn names_that_could_reach_another_entry_are_refused() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        assert!(entry("FundaCAD.Onshape", "../Other/key").is_err());
        assert!(entry("FundaCAD.Onshape", "a/b").is_err());
        assert!(entry("../x", "key").is_err());
        assert!(plugin_secret_set("FundaCAD.Onshape".into(), "key".into(), String::new()).is_err());
    }
}
