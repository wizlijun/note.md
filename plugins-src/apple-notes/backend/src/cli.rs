use std::path::PathBuf;

#[derive(Debug, PartialEq)]
pub struct SyncArgs {
    pub vault: PathBuf,
    pub dry_run: bool,
}

pub const USAGE: &str = "Usage: notemd-apple-notes sync --vault PATH [--dry-run]";

pub fn parse(args: &[String]) -> Result<SyncArgs, String> {
    if args.first().map(String::as_str) != Some("sync") {
        return Err(USAGE.into());
    }
    let mut vault = None;
    let mut dry_run = false;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--vault" if vault.is_none() => {
                i += 1;
                let value = args
                    .get(i)
                    .filter(|v| !v.is_empty() && !v.starts_with("--"))
                    .ok_or("--vault requires a path")?;
                vault = Some(PathBuf::from(value));
            }
            "--dry-run" if !dry_run => dry_run = true,
            other => return Err(format!("Unknown or repeated argument: {other}. {USAGE}")),
        }
        i += 1;
    }
    Ok(SyncArgs {
        vault: vault.ok_or("--vault is required")?,
        dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).into()).collect()
    }
    #[test]
    fn requires_explicit_vault_and_rejects_typos() {
        assert!(parse(&args(&["sync"])).is_err());
        assert!(parse(&args(&["sync", "--vault", "--dry-run"])).is_err());
        assert!(parse(&args(&["sync", "--vault", "/tmp/v", "--dryrun"])).is_err());
        assert_eq!(
            parse(&args(&["sync", "--dry-run", "--vault", "/tmp/my vault"])).unwrap(),
            SyncArgs {
                vault: PathBuf::from("/tmp/my vault"),
                dry_run: true
            }
        );
    }
}
