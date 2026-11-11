//! libsecret owns transport encryption, unlocking and the system keyring. No
//! credential is placed in command arguments, the Vault, preferences or logs.
use super::*;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;

#[repr(C)]
struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}
#[link(name = "secret-1")]
unsafe extern "C" {
    fn secret_schema_new(name: *const c_char, flags: c_int, ...) -> *mut c_void;
    fn secret_schema_unref(schema: *mut c_void);
    fn secret_password_store_sync(
        schema: *const c_void,
        collection: *const c_char,
        label: *const c_char,
        password: *const c_char,
        cancel: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> c_int;
    fn secret_password_lookup_sync(
        schema: *const c_void,
        cancel: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> *mut c_char;
    fn secret_password_clear_sync(
        schema: *const c_void,
        cancel: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> c_int;
    fn secret_password_free(password: *mut c_char);
    fn secret_password_search_sync(
        schema: *const c_void,
        flags: c_int,
        cancel: *mut c_void,
        error: *mut *mut GError,
        ...
    ) -> *mut c_void;
}
#[link(name = "glib-2.0")]
unsafe extern "C" {
    fn g_error_free(error: *mut GError);
    fn g_list_free_full(list: *mut c_void, free: Option<unsafe extern "C" fn(*mut c_void)>);
}
#[link(name = "gobject-2.0")]
unsafe extern "C" {
    fn g_object_unref(object: *mut c_void);
}
struct Schema(*mut c_void);
impl Schema {
    fn new() -> Result<Self, String> {
        let name = CString::new(SERVICE).unwrap();
        let schema = unsafe {
            secret_schema_new(
                name.as_ptr(),
                0,
                c"profile".as_ptr(),
                0 as c_int,
                ptr::null::<c_char>(),
            )
        };
        if schema.is_null() {
            Err("Sumi Secret Service schema unavailable".into())
        } else {
            Ok(Self(schema))
        }
    }
}
impl Drop for Schema {
    fn drop(&mut self) {
        unsafe { secret_schema_unref(self.0) }
    }
}
fn check(error: *mut GError, operation: &str) -> Result<(), String> {
    if error.is_null() {
        return Ok(());
    }
    // The provider's message is untrusted and may contain private record data.
    let code = unsafe {
        let code = (*error).code;
        g_error_free(error);
        code
    };
    Err(format!("Sumi Secret Service {operation} failed ({code}); check that the system keyring is running and unlocked"))
}
fn exists(schema: &Schema, account: &CStr) -> Result<bool, String> {
    let mut error = ptr::null_mut();
    // Search without unlocking/loading secrets also finds locked items. A
    // dismissed unlock prompt must never turn an existing pairing into None.
    let items = unsafe {
        secret_password_search_sync(
            schema.0,
            0,
            ptr::null_mut(),
            &mut error,
            c"profile".as_ptr(),
            account.as_ptr(),
            ptr::null::<c_char>(),
        )
    };
    let found = !items.is_null();
    if found {
        unsafe { g_list_free_full(items, Some(g_object_unref)) };
    }
    check(error, "read")?;
    Ok(found)
}
pub fn save(profile: &str, credential: &Credentials) -> Result<(), String> {
    let account = CString::new(account(profile)?).unwrap();
    let data = serde_json::to_string(&StoredCredential {
        server_url: credential.server_url.clone(),
        space_id: credential.space_id.clone(),
        device_id: credential.device_id.clone(),
        device_secret: credential.device_secret.clone(),
    })
    .map_err(|_| "cannot encode Sumi credential")?;
    let data = CString::new(data).map_err(|_| "invalid Sumi credential")?;
    let schema = Schema::new()?;
    let mut error = ptr::null_mut();
    let saved = unsafe {
        secret_password_store_sync(
            schema.0,
            ptr::null(),
            c"Sumi Write device credential".as_ptr(),
            data.as_ptr(),
            ptr::null_mut(),
            &mut error,
            c"profile".as_ptr(),
            account.as_ptr(),
            ptr::null::<c_char>(),
        )
    };
    check(error, "write")?;
    if saved == 0 {
        return Err("Sumi Secret Service did not store the credential".into());
    }
    Ok(())
}
pub fn load(profile: &str) -> Result<Option<Credentials>, String> {
    let account = CString::new(account(profile)?).unwrap();
    let schema = Schema::new()?;
    if !exists(&schema, &account)? {
        return Ok(None);
    }
    let mut error = ptr::null_mut();
    let password = unsafe {
        secret_password_lookup_sync(
            schema.0,
            ptr::null_mut(),
            &mut error,
            c"profile".as_ptr(),
            account.as_ptr(),
            ptr::null::<c_char>(),
        )
    };
    // Always release provider-owned secret memory, including malformed records.
    let stored = if password.is_null() {
        None
    } else {
        let result = unsafe {
            serde_json::from_slice::<StoredCredential>(CStr::from_ptr(password).to_bytes())
        };
        unsafe { secret_password_free(password) };
        Some(result)
    };
    check(error, "read")?;
    if stored.is_none() {
        return Err("Sumi Secret Service credential is locked or unavailable".into());
    }
    stored
        .map(|result| {
            let stored = result.map_err(|_| "invalid Sumi Secret Service record")?;
            Credentials::new(
                stored.server_url,
                stored.space_id,
                stored.device_id,
                stored.device_secret,
            )
        })
        .transpose()
}
pub fn remove(profile: &str) -> Result<(), String> {
    let account = CString::new(account(profile)?).unwrap();
    let schema = Schema::new()?;
    let mut error = ptr::null_mut();
    unsafe {
        secret_password_clear_sync(
            schema.0,
            ptr::null_mut(),
            &mut error,
            c"profile".as_ptr(),
            account.as_ptr(),
            ptr::null::<c_char>(),
        )
    };
    // false without GError means that there was no matching item: idempotent.
    check(error, "delete")?;
    if exists(&schema, &account)? {
        return Err("Sumi Secret Service credential could not be deleted".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_service_is_an_error_not_an_absent_credential() {
        const CHILD: &str = "SUMI_SECRET_SERVICE_FAILURE_TEST";
        if std::env::var_os(CHILD).is_some() {
            let profile = "isolated-secret-service-failure-test";
            assert!(load(profile)
                .unwrap_err()
                .contains("Secret Service read failed"));
            let credential = Credentials::new(
                "https://example.test".into(),
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
                "x".repeat(88),
            )
            .unwrap();
            assert!(save(profile, &credential)
                .unwrap_err()
                .contains("Secret Service write failed"));
            assert!(remove(profile)
                .unwrap_err()
                .contains("Secret Service delete failed"));
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "sumi::credentials::linux::tests::unavailable_service_is_an_error_not_an_absent_credential", "--nocapture"])
            .env(CHILD, "1")
            .env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={}", temp.path().join("absent-bus").display()))
            .output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
}
