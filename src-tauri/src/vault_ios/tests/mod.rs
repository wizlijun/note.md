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
