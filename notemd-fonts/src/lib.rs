//! Fixed open-source font bundles shared by the host and Typeset Reader.
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy)]
pub struct FontSpec {
    pub file: &'static str,
    pub family: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

const WENKAI_REGULAR: FontSpec = FontSpec {
    file: "LXGWWenKaiLite-Regular.ttf",
    family: "LXGW WenKai Lite",
    url: "https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKai-Lite@v1.522/fonts/TTF/LXGWWenKaiLite-Regular.ttf",
    sha256: "140c99ba4e28e817cec49bf82a0c5fcdc4fe633fb9dfda16d0ee8d59a8545f15",
    bytes: 13_872_424,
};

const CJK: &[FontSpec] = &[
    FontSpec {
        file: "SourceHanSerifCN-Regular.otf",
        family: "Source Han Serif CN",
        url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-han-serif@2.003R/SubsetOTF/CN/SourceHanSerifCN-Regular.otf",
        sha256: "3754ea669c530e2473354f8f6d9f79680a44d7e26ec7d00eeabee4a7e0753c5d",
        bytes: 11_626_108,
    },
    WENKAI_REGULAR,
    FontSpec {
        file: "SourceHanSansCN-Regular.otf",
        family: "Source Han Sans CN",
        url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-han-sans@2.004R/SubsetOTF/CN/SourceHanSansCN-Regular.otf",
        sha256: "c0aa89a70f92a820ff95490fea6d472cd19621a71c9a748a4950eb2eafe6438e",
        bytes: 8_331_636,
    },
];

const WONDEROUS: &[FontSpec] = &[FontSpec {
    file: "texgyrepagella-regular.otf",
    family: "TeX Gyre Pagella",
    url: "https://mirrors.ctan.org/fonts/tex-gyre/opentype/texgyrepagella-regular.otf",
    sha256: "44e64260716d8f2bbe412baa1ee99b7c995190ac4573177c24def0b9200438c7",
    bytes: 218_100,
}];

const EFFIE: &[FontSpec] = &[
    WENKAI_REGULAR,
    // Medium is the nearest official Lite weight to the web template's bold face.
    FontSpec {
        file: "LXGWWenKaiLite-Medium.ttf",
        family: "LXGW WenKai Lite",
        url: "https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKai-Lite@v1.522/fonts/TTF/LXGWWenKaiLite-Medium.ttf",
        sha256: "02eb0f8deed11b00481393f5720630ae1a44424f37f4157ea160a69a1c72a0b6",
        bytes: 13_700_636,
    },
    FontSpec {
        file: "LXGWWenKaiMonoLite-Regular.ttf",
        family: "LXGW WenKai Mono Lite",
        url: "https://cdn.jsdelivr.net/gh/lxgw/LxgwWenKai-Lite@v1.522/fonts/TTF/LXGWWenKaiMonoLite-Regular.ttf",
        sha256: "5f60e1f071ad1a15869da7e02e995b332243ef4c6ec575bad5bbef827d015ce5",
        bytes: 13_900_940,
    },
];

pub fn bundle(style: &str) -> Result<&'static [FontSpec], String> {
    match style {
        "cjk" => Ok(CJK),
        "wonderous" => Ok(WONDEROUS),
        "effie" => Ok(EFFIE),
        _ => Err("unknown font bundle".into()),
    }
}

pub fn user_font_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
    Ok(PathBuf::from(home).join("Library/Fonts"))
}

pub fn verify(path: &Path, spec: &FontSpec) -> Result<(), String> {
    let data = fs::read(path).map_err(|error| format!("read {}: {error}", spec.file))?;
    if data.len() as u64 != spec.bytes || format!("{:x}", Sha256::digest(&data)) != spec.sha256 {
        return Err(format!(
            "{} failed the published size or SHA-256 check",
            spec.file
        ));
    }
    let mut database = fontdb::Database::new();
    database.load_font_data(data);
    if !database
        .faces()
        .any(|face| face.families.iter().any(|(name, _)| name == spec.family))
    {
        return Err(format!("{} has an unexpected font family", spec.file));
    }
    Ok(())
}

fn fetch(url: &str, target: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/curl")
        .args([
            "--http1.1",
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--retry",
            "3",
            "--connect-timeout",
            "15",
            "--max-time",
            "600",
            "--max-filesize",
            "30000000",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--output",
        ])
        .arg(target)
        .arg(url)
        .output()
        .map_err(|error| format!("start font download: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "font download failed (curl exit {})",
            output.status
        ));
    }
    Ok(())
}

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn install_to(
    dir: &Path,
    specs: &[FontSpec],
    mut download: impl FnMut(&str, &Path) -> Result<(), String>,
    mut completed: impl FnMut(usize),
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("create user font directory: {error}"))?;
    for (index, spec) in specs.iter().enumerate() {
        let target = dir.join(spec.file);
        if target.exists() {
            verify(&target, spec)?;
        } else {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos();
            let temporary = TemporaryFile(dir.join(format!(".notemd-{}-{nonce}.part", spec.file)));
            download(spec.url, &temporary.0)?;
            verify(&temporary.0, spec)?;
            if let Err(error) = fs::hard_link(&temporary.0, &target) {
                if target.exists() {
                    verify(&target, spec)?;
                } else {
                    return Err(format!("install {}: {error}", spec.file));
                }
            }
        }
        completed(index + 1);
    }
    Ok(())
}

pub fn install(style: &str, completed: impl FnMut(usize)) -> Result<(), String> {
    install_to(&user_font_dir()?, bundle(style)?, fetch, completed)
}

pub fn installed_count(style: &str) -> Result<(usize, usize), String> {
    let specs = bundle(style)?;
    let dir = user_font_dir()?;
    Ok((
        specs
            .iter()
            .filter(|spec| verify(&dir.join(spec.file), spec).is_ok())
            .count(),
        specs.len(),
    ))
}

pub fn bundle_installed(style: &str) -> Result<bool, String> {
    let (installed, total) = installed_count(style)?;
    Ok(installed == total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_bundles_are_available() {
        assert_eq!(bundle("cjk").unwrap().len(), 3);
        assert_eq!(bundle("wonderous").unwrap().len(), 1);
        assert_eq!(bundle("effie").unwrap().len(), 3);
        assert!(bundle("../other").is_err());
    }

    #[test]
    fn failed_verification_never_installs_or_leaves_a_part_file() {
        let dir = std::env::temp_dir().join(format!("notemd-fonts-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let spec = FontSpec {
            file: "invalid-font.ttf",
            family: "Invalid",
            url: "https://example.test/invalid.ttf",
            sha256: "not-a-real-hash",
            bytes: 3,
        };
        assert!(install_to(
            &dir,
            &[spec],
            |_, path| fs::write(path, b"bad").map_err(|e| e.to_string()),
            |_| {}
        )
        .is_err());
        assert!(!dir.join(spec.file).exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn verified_font_is_installed_once_and_never_overwritten() {
        let mut database = fontdb::Database::new();
        database.load_system_fonts();
        let (path, family) = database
            .faces()
            .find_map(|face| {
                if face.index != 0 {
                    return None;
                }
                let path = match &face.source {
                    fontdb::Source::File(path) => path,
                    _ => return None,
                };
                if !path
                    .extension()
                    .is_some_and(|ext| ext == "ttf" || ext == "otf")
                {
                    return None;
                }
                if !fs::metadata(path).is_ok_and(|meta| meta.len() < 2_000_000) {
                    return None;
                }
                Some((path.clone(), face.families.first()?.0.clone()))
            })
            .expect("test host needs a small system font");
        let data = fs::read(path).unwrap();
        let digest: &'static str =
            Box::leak(format!("{:x}", Sha256::digest(&data)).into_boxed_str());
        let family: &'static str = Box::leak(family.into_boxed_str());
        let spec = FontSpec {
            file: "test-font.ttf",
            family,
            url: "https://example.test/font.ttf",
            sha256: digest,
            bytes: data.len() as u64,
        };
        let dir =
            std::env::temp_dir().join(format!("notemd-fonts-positive-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        install_to(
            &dir,
            &[spec],
            |_, target| fs::write(target, &data).map_err(|e| e.to_string()),
            |_| {},
        )
        .unwrap();
        install_to(&dir, &[spec], |_, _| panic!("must not redownload"), |_| {}).unwrap();
        fs::write(dir.join(spec.file), b"changed").unwrap();
        assert!(install_to(&dir, &[spec], |_, _| panic!("must not overwrite"), |_| {}).is_err());
        assert_eq!(fs::read(dir.join(spec.file)).unwrap(), b"changed");
        fs::remove_dir_all(dir).unwrap();
    }
}
