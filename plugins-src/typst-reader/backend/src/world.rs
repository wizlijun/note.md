//! Offline compilation world. Files are immutable snapshots; installed system
//! fonts are discovered once and loaded lazily, then refreshed after installs.
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::UNIX_EPOCH;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Dict, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook, FontInfo};
use typst::{Library, LibraryExt, World};
use typst_kit::fonts::FontStore;
use typst_utils::LazyHash;

fn file_id(path: &str) -> FileId {
    RootedPath::new(
        VirtualRoot::Project,
        VirtualPath::new(path).expect("validated virtual path"),
    )
    .intern()
}

pub struct FontCatalog {
    store: FontStore,
    fingerprint: [u8; 32],
}

fn build_catalog(mut fonts: Vec<(typst_kit::fonts::FontPath, FontInfo)>) -> FontCatalog {
    fonts.sort_by(|left, right| (&left.0.path, left.0.index).cmp(&(&right.0.path, right.0.index)));
    let mut fingerprint = Sha256::new();
    for (path, _) in &fonts {
        fingerprint.update(path.path.as_os_str().as_encoded_bytes());
        fingerprint.update(path.index.to_le_bytes());
        if let Ok(metadata) = std::fs::metadata(&path.path) {
            fingerprint.update(metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified().and_then(|time| {
                time.duration_since(UNIX_EPOCH)
                    .map_err(std::io::Error::other)
            }) {
                fingerprint.update(modified.as_nanos().to_le_bytes());
            }
        }
    }
    let mut store = FontStore::new();
    store.extend(fonts);
    FontCatalog {
        store,
        fingerprint: fingerprint.finalize().into(),
    }
}

fn catalog_slot() -> &'static RwLock<Arc<FontCatalog>> {
    static FONTS: OnceLock<RwLock<Arc<FontCatalog>>> = OnceLock::new();
    FONTS.get_or_init(|| {
        RwLock::new(Arc::new(build_catalog(
            typst_kit::fonts::system().collect(),
        )))
    })
}

pub fn font_catalog() -> Arc<FontCatalog> {
    catalog_slot().read().unwrap().clone()
}

pub fn refresh_fonts() {
    let next = Arc::new(build_catalog(typst_kit::fonts::system().collect()));
    *catalog_slot().write().unwrap() = next;
}

impl FontCatalog {
    pub fn fingerprint(&self) -> [u8; 32] {
        self.fingerprint
    }
}

pub struct RenderWorld {
    library: LazyHash<Library>,
    main: FileId,
    sources: HashMap<FileId, Source>,
    files: HashMap<FileId, Bytes>,
    fonts: Arc<FontCatalog>,
}

impl RenderWorld {
    #[cfg(test)]
    pub fn new(
        main: &str,
        sources: &[(&str, &str)],
        files: impl IntoIterator<Item = (String, Bytes)>,
    ) -> Self {
        Self::with_fonts(main, sources, files, font_catalog())
    }

    pub fn with_fonts(
        main: &str,
        sources: &[(&str, &str)],
        files: impl IntoIterator<Item = (String, Bytes)>,
        fonts: Arc<FontCatalog>,
    ) -> Self {
        let id = file_id("main.typ");
        let mut source_map = HashMap::new();
        source_map.insert(id, Source::new(id, main.into()));
        for (path, text) in sources {
            let id = file_id(path);
            source_map.insert(id, Source::new(id, (*text).into()));
        }
        let mut file_map: HashMap<FileId, Bytes> = source_map
            .iter()
            .map(|(id, source)| (*id, Bytes::from_string(source.text().to_owned())))
            .collect();
        // Built-in resources are inserted before book images. A book cannot
        // replace the renderer's source files or its cmarker Wasm module.
        for (path, bytes) in files {
            file_map.entry(file_id(&path)).or_insert(bytes);
        }
        Self {
            library: LazyHash::new(Library::default()),
            main: id,
            sources: source_map,
            files: file_map,
            fonts,
        }
    }

    pub fn set_inputs(&mut self, inputs: Dict) {
        self.library = LazyHash::new(Library::builder().with_inputs(inputs).build());
    }
}

impl World for RenderWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.store.book()
    }
    fn main(&self) -> FileId {
        self.main
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        self.sources
            .get(&id)
            .cloned()
            .ok_or(FileError::AccessDenied)
    }
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.get(&id).cloned().ok_or(FileError::AccessDenied)
    }
    fn font(&self, id: usize) -> Option<Font> {
        self.fonts.store.font(id)
    }
    fn today(&self, _: Option<Duration>) -> Option<Datetime> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_fonts_change_the_cache_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let empty_fingerprint =
            build_catalog(typst_kit::fonts::scan(dir.path()).collect()).fingerprint();

        let system_font = typst_kit::fonts::system()
            .find(|(path, _)| {
                path.index == 0
                    && path
                        .path
                        .extension()
                        .is_some_and(|ext| ext == "ttf" || ext == "otf")
                    && std::fs::metadata(&path.path).is_ok_and(|meta| meta.len() < 2_000_000)
            })
            .expect("test host needs one small system font");
        let path = dir.path().join("reader-font.ttf");
        std::fs::copy(&system_font.0.path, &path).unwrap();
        let installed = build_catalog(typst_kit::fonts::scan(dir.path()).collect());
        assert_eq!(
            installed.store.font(0).unwrap().info().family,
            system_font.1.family
        );
        assert_ne!(installed.fingerprint(), empty_fingerprint);

        std::fs::remove_file(path).unwrap();
        assert_eq!(
            build_catalog(typst_kit::fonts::scan(dir.path()).collect()).fingerprint(),
            empty_fingerprint
        );
    }

    #[test]
    fn worlds_share_fonts_and_only_expose_snapshotted_files() {
        let first = RenderWorld::new("Hello", &[], [("image.svg".into(), Bytes::new("snapshot"))]);
        let second = RenderWorld::new("Other book", &[], []);
        assert!(Arc::ptr_eq(&first.fonts, &second.fonts));
        assert_eq!(
            first.file(file_id("image.svg")).unwrap().as_slice(),
            b"snapshot"
        );
        assert!(second.file(file_id("image.svg")).is_err());
        assert!(first.file(file_id("private.txt")).is_err());
        assert!(first.source(file_id("private.typ")).is_err());
        assert_eq!(first.file(first.main()).unwrap().as_slice(), b"Hello");
    }

    #[test]
    fn book_files_cannot_replace_builtin_sources_or_plugins() {
        let world = RenderWorld::new(
            "Hello",
            &[("library.typ", "Trusted")],
            [
                ("plugin.wasm".into(), Bytes::new("built-in")),
                ("plugin.wasm".into(), Bytes::new("book image")),
                ("library.typ".into(), Bytes::new("book image")),
            ],
        );
        assert_eq!(
            world.file(file_id("plugin.wasm")).unwrap().as_slice(),
            b"built-in"
        );
        assert_eq!(
            world.file(file_id("library.typ")).unwrap().as_slice(),
            b"Trusted"
        );
    }
}
