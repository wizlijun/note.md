use std::path::PathBuf;

#[test]
fn vault_path_under_documents() {
    let base = PathBuf::from("/tmp/foo");
    let p = crate::vault_ios::path::resolve_vault_path(&base);
    assert_eq!(p, PathBuf::from("/tmp/foo/Vault"));
}

#[test]
fn vault_path_handles_trailing_slash() {
    let base = PathBuf::from("/tmp/foo/");
    let p = crate::vault_ios::path::resolve_vault_path(&base);
    assert_eq!(p, PathBuf::from("/tmp/foo/Vault"));
}

use std::fs;
use tempfile::tempdir;

#[test]
fn list_dir_filters_by_whitelist_and_hides_dotgit() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    fs::write(root.join("readme.md"), "x").unwrap();
    fs::write(root.join("a.txt"), "y").unwrap();
    fs::write(root.join("photo.png"), &[0u8; 8]).unwrap();
    fs::create_dir(root.join("subdir")).unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join("ignore.pdf"), "z").unwrap();
    fs::write(root.join(".DS_Store"), "").unwrap();

    let entries = crate::vault_ios::list_dir::list(root, "").unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

    assert!(names.contains(&"readme.md"));
    assert!(names.contains(&"a.txt"));
    assert!(names.contains(&"photo.png"));
    assert!(names.contains(&"subdir"));
    assert!(!names.contains(&".git"));
    assert!(!names.contains(&"ignore.pdf"));
    assert!(!names.contains(&".DS_Store"));
}

#[test]
fn list_dir_returns_kind_and_size() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("foo.md"), "hello world").unwrap();
    fs::create_dir(root.join("sub")).unwrap();

    let entries = crate::vault_ios::list_dir::list(root, "").unwrap();
    let md = entries.iter().find(|e| e.name == "foo.md").unwrap();
    assert_eq!(md.kind, "file");
    assert_eq!(md.size, Some(11));
    assert_eq!(md.ext.as_deref(), Some("md"));

    let sub = entries.iter().find(|e| e.name == "sub").unwrap();
    assert_eq!(sub.kind, "dir");
    assert_eq!(sub.size, None);
}

#[test]
fn list_dir_relative_path_navigates() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join("notes")).unwrap();
    fs::write(root.join("notes/today.md"), "x").unwrap();

    let entries = crate::vault_ios::list_dir::list(root, "notes").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "today.md");
}

#[test]
fn list_dir_rejects_path_traversal() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let result = crate::vault_ios::list_dir::list(root, "../etc");
    assert!(result.is_err());
}

#[test]
fn keychain_stub_roundtrip() {
    let dir = tempdir().unwrap();
    std::env::set_var("MDEDITOR_KEYCHAIN_STUB_DIR", dir.path());
    crate::vault_ios::keychain::stub::set("pat", "secret-token").unwrap();
    let got = crate::vault_ios::keychain::stub::get("pat").unwrap();
    assert_eq!(got.as_deref(), Some("secret-token"));
    crate::vault_ios::keychain::stub::delete("pat").unwrap();
    let gone = crate::vault_ios::keychain::stub::get("pat").unwrap();
    assert_eq!(gone, None);
    std::env::remove_var("MDEDITOR_KEYCHAIN_STUB_DIR");
}

#[test]
fn sig_uses_configured_name_and_email() {
    let mgr = crate::vault_ios::VaultIosManager::new();
    *mgr.author_name.lock().unwrap() = "Alice".into();
    *mgr.author_email.lock().unwrap() = "a@example.com".into();
    let sig = crate::vault_ios::sig::author_sig(&mgr).unwrap();
    assert_eq!(sig.name(), Some("Alice"));
    assert_eq!(sig.email(), Some("a@example.com"));
}

#[test]
fn sig_falls_back_when_email_empty() {
    let mgr = crate::vault_ios::VaultIosManager::new();
    *mgr.author_name.lock().unwrap() = "Bob".into();
    // email left empty
    let sig = crate::vault_ios::sig::author_sig(&mgr).unwrap();
    assert_eq!(sig.email(), Some("noreply@mdeditor.local"));
}
