use super::args::Parsed;
use super::router::PluginRoute;
use std::process::ExitCode;

pub fn run(_p: PluginRoute, _parsed: Parsed) -> ExitCode {
    eprintln!("mdedit: plugin runner not yet implemented");
    ExitCode::from(1)
}
