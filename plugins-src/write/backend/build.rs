fn main() {
    println!("cargo:rerun-if-changed=native/sound.m");
    println!("cargo:rerun-if-changed=native/sound.h");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new().file("native/sound.m").flag("-fobjc-arc")
            .flag("-mmacosx-version-min=13.0").compile("sumi_sound");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
    }
}
