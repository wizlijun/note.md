//! The Worker key belongs to the operating-system credential store, never to
//! config.json, the vault, CLI arguments, stdout or plugin logs.

const SERVICE: &str = "net.notemd.assistant-mail";
const ACCOUNT: &str = "worker-access-key";

pub trait CredentialStore {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemCredentialStore;

#[cfg(target_os = "macos")]
impl CredentialStore for SystemCredentialStore {
    fn get(&self) -> Result<Option<String>, String> {
        match security_framework::passwords::get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "credential store returned invalid UTF-8".to_string()),
            Err(err) if err.code() == -25300 => Ok(None), // errSecItemNotFound
            Err(_) => Err("could not read Assistant Mail key from Keychain".to_string()),
        }
    }

    fn set(&self, value: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, value.as_bytes())
            .map_err(|_| "could not save Assistant Mail key to Keychain".to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == -25300 => Ok(()),
            Err(_) => Err("could not delete Assistant Mail key from Keychain".to_string()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl CredentialStore for SystemCredentialStore {
    fn get(&self) -> Result<Option<String>, String> {
        Err("Assistant Mail secure credentials are currently supported on macOS only".into())
    }
    fn set(&self, _value: &str) -> Result<(), String> {
        Err("Assistant Mail secure credentials are currently supported on macOS only".into())
    }
    fn delete(&self) -> Result<(), String> {
        Err("Assistant Mail secure credentials are currently supported on macOS only".into())
    }
}

pub fn validate_access_key(value: &str) -> Result<(), String> {
    let len = value.as_bytes().len();
    if !(32..=512).contains(&len) {
        return Err("access key must contain 32 to 512 bytes".into());
    }
    if value.chars().any(char::is_whitespace) {
        return Err("access key must not contain whitespace".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_key_validation_rejects_short_and_whitespace() {
        assert!(validate_access_key("short").is_err());
        assert!(validate_access_key(&format!("{} {}", "a".repeat(20), "b".repeat(20))).is_err());
        assert!(validate_access_key(&"a".repeat(32)).is_ok());
    }
}
