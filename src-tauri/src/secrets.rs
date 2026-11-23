// API keys for the optional cloud cleanup live in the system keychain
// (macOS Keychain, Windows Credential Manager, Linux Secret Service).

const SERVICE: &str = "Photo Stories Desktop";

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    entry(&provider)?.set_password(key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_api_key(provider: String) -> Result<Option<String>, String> {
    match entry(&provider)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
