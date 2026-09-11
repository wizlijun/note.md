mod client;
mod credentials;
mod plugin;
mod storage;

fn main() {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(notemd_plugin_sdk::serve(plugin::AssistantMailPlugin::new()));
}
