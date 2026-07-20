//! openclaw v2 plugin entry point. UDS/relay/pair reader tasks are long-lived,
//! so this needs a real multi-thread runtime (unlike md2pdf's current_thread):
//! on_ui_request uses block_in_place + Handle::block_on, which requires ≥2
//! worker threads.

use notemd_openclaw::OpenClawPlugin;
use notemd_plugin_sdk as sdk;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    sdk::serve(OpenClawPlugin::new()).await;
}
