//! Offline compilation world. Files are immutable snapshots; the font store is
//! shared across books and loads each font only once, as in Typst's CLI.
use std::collections::HashMap;
use std::sync::OnceLock;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Dict, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
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

fn fonts() -> &'static FontStore {
    static FONTS: OnceLock<FontStore> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut store = FontStore::new();
        store.extend(typst_kit::fonts::embedded());
        store.extend(typst_kit::fonts::system());
        store
    })
}

pub struct RenderWorld {
    library: LazyHash<Library>,
    main: FileId,
    sources: HashMap<FileId, Source>,
    files: HashMap<FileId, Bytes>,
    fonts: &'static FontStore,
}

impl RenderWorld {
    pub fn new(
        main: &str,
        sources: &[(&str, &str)],
        files: impl IntoIterator<Item = (String, Bytes)>,
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
            fonts: fonts(),
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
        self.fonts.book()
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
        self.fonts.font(id)
    }
    fn today(&self, _: Option<Duration>) -> Option<Datetime> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worlds_share_fonts_and_only_expose_snapshotted_files() {
        let first = RenderWorld::new("Hello", &[], [("image.svg".into(), Bytes::new("snapshot"))]);
        let second = RenderWorld::new("Other book", &[], []);
        assert!(std::ptr::eq(first.fonts, second.fonts));
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
