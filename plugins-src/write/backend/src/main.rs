#[tokio::main]
async fn main() {
    notemd_plugin_sdk::serve(notemd_sumi_backend::runtime::Plugin::new()).await;
}
