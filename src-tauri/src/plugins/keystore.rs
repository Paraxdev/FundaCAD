//! A plugin's secrets in the OS credential store (Credential Manager, Keychain, Secret Service), never a file. Without
//! a store the call fails, it never falls back to plain text.

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
}
