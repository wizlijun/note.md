fn main() {
    // libgit2 (via git2 crate with vendored-libgit2) links against zlib and
    // iconv. On macOS host they're auto-discovered via pkg-config; on iOS
    // the linker doesn't find them unless we explicitly link the system
    // dylibs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=z");
        println!("cargo:rustc-link-lib=iconv");
    }
    tauri_build::build()
}
