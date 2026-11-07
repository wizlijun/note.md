fn main() {
    assert_eq!(
        std::env::var("CARGO_CFG_TARGET_OS").unwrap(),
        "macos",
        "native pipeline requires AppKit"
    );
    let native = "../../../tauri-plugin-native-editor/native";
    println!("cargo:rerun-if-changed={native}/editor.m");
    println!("cargo:rerun-if-changed={native}/editor.h");
    println!("cargo:rerun-if-changed=runner.m");
    cc::Build::new()
        .file("runner.m")
        .include(native)
        .flag("-fobjc-arc")
        .flag("-mmacosx-version-min=13.0")
        .flag("-Wall")
        .flag("-Wextra")
        .flag("-Werror")
        .compile("sumi_native_benchmark");
    for name in ["AppKit", "Foundation", "CoreText", "QuartzCore"] {
        println!("cargo:rustc-link-lib=framework={name}");
    }
}
