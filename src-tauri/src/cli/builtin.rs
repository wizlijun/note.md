use super::args::Parsed;
use super::router::Builtin;
use std::process::ExitCode;

pub fn run(_b: Builtin, _parsed: &Parsed) -> ExitCode {
    eprintln!("mdedit: builtin command not yet implemented");
    ExitCode::from(1)
}
