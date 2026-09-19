mod plugin;

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(notemd_plugin_sdk::serve(
        plugin::ConversationDictionaryPlugin::new(),
    ));
}
