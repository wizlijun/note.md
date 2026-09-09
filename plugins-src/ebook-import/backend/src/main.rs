mod airead; mod book_assets; mod bookconf; mod calibre; mod htmlz; mod library; mod ocr; mod pipeline; mod plugin; mod settings; mod topic_agent; mod topics;
mod library_assets;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--rebuild-library-indexes") {
        let result = match args.as_slice() {
            [_, root] => library_assets::rebuild(std::path::Path::new(root)),
            _ => Err("Usage: --rebuild-library-indexes <absolute ebooks root>".into()),
        };
        match result {
            Ok(result) => println!("{}", serde_json::json!({"type":"indexes", "result":result})),
            Err(error) => {
                eprintln!("{}", serde_json::json!({"type":"error", "warning":error}));
                std::process::exit(1);
            }
        }
        return;
    }
    if args.first().is_some_and(|arg| arg == "--complete-library-assets") {
        let result = match args.as_slice() {
            [_, root] => library_assets::run(std::path::Path::new(root)),
            [_, root, flag, report] if flag == "--report" => library_assets::run_with_report(
                std::path::Path::new(root), Some(std::path::Path::new(report)),
            ),
            _ => Err("Usage: --complete-library-assets <absolute ebooks root> [--report <absolute temporary report path>]".into()),
        };
        if let Err(error) = result {
            eprintln!("{}", serde_json::json!({"type":"error", "warning":error}));
            std::process::exit(1);
        }
        return;
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2).enable_all().build().expect("tokio runtime");
    rt.block_on(notemd_plugin_sdk::serve(plugin::EbookImportPlugin::new()));
}
