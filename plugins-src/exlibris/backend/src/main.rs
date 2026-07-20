//! exlibris v2 plugin entry point. The two calibre commands
//! (`calibre_extract_meta` / `calibre_convert`) are async (spawn a subprocess
//! and await its exit); on_ui_request drives them with block_in_place +
//! Handle::block_on, which requires ≥2 worker threads — hence multi_thread.

use notemd_exlibris::ExlibrisPlugin;
use notemd_plugin_sdk as sdk;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    sdk::serve(ExlibrisPlugin::new()).await;
}
