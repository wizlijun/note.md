use super::args::Parsed;

#[derive(Debug)]
pub enum Route {
    Builtin(Builtin),
    Plugin(PluginRoute),
    Disabled { plugin_id: String, subcommand: String },
    Unknown(String),
}

#[derive(Debug)]
pub enum Builtin {
    Help { topic: Option<String>, all: bool },
    Version,
    PluginList,
    PluginEnable(String),
    PluginDisable(String),
    PluginInfo(String),
}

#[derive(Debug)]
pub struct PluginRoute {
    pub plugin_id: String,
    pub subcommand: String,
    pub remaining: Vec<String>,
}

pub fn resolve(_parsed: &Parsed) -> Route {
    Route::Unknown("(unimplemented)".to_string())
}
