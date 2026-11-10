fn main() {
    println!("cargo:rerun-if-changed=native/editor.m");
    println!("cargo:rerun-if-changed=native/editor.h");
    println!("cargo:rerun-if-changed=native/typing-monitor.h");
    println!("cargo:rerun-if-changed=native/shortcuts.h");
    println!("cargo:rerun-if-changed=native/focus.h");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let mut build = cc::Build::new();
        build
            .file("native/editor.m")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=11.0");
        let compiler = build.get_compiler();
        build.compile("sumi_native_editor");

        // @available emits compiler-rt's platform-version helper when the
        // deployment target predates TextKit 2. Rust links with -nodefaultlibs,
        // so Clang does not add this runtime automatically. Use the runtime
        // belonging to the actual cc compiler, including cross-architecture
        // builds; do not bundle Apple's entire archive into our Rust rlib.
        let output = compiler
            .to_command()
            .arg("-print-file-name=libclang_rt.osx.a")
            .output()
            .expect("query the Objective-C compiler's macOS runtime");
        assert!(output.status.success(), "Clang macOS runtime query failed");
        let path = std::path::PathBuf::from(
            std::str::from_utf8(&output.stdout)
                .expect("Clang runtime path must be UTF-8")
                .trim(),
        );
        assert!(path.is_absolute() && path.is_file(), "Clang macOS runtime not found: {}", path.display());
        println!("cargo:rustc-link-search=native={}", path.parent().unwrap().display());
        println!("cargo:rustc-link-lib=static:-bundle=clang_rt.osx");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=CoreText");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
    }
}
