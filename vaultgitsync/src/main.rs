use std::path::PathBuf;

use clap::{Parser, Subcommand};

mod config;
mod daemon;
mod git_ops;
mod watcher;

#[derive(Parser)]
#[command(name = "vaultgitsync", about = "File vault auto-sync daemon using Git/GitHub")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the sync daemon
    Daemon {
        /// Path to the sync repository
        #[arg(short, long)]
        repo: PathBuf,

        /// Remote name (default: origin)
        #[arg(long, default_value = "origin")]
        remote: String,

        /// Branch name (default: main)
        #[arg(long, default_value = "main")]
        branch: String,
    },
    /// Show sync status
    Status {
        #[arg(short, long)]
        repo: PathBuf,
    },
    /// List unresolved conflict files
    Conflicts {
        #[arg(short, long)]
        repo: PathBuf,
    },
    /// Initialize a new sync repository
    Init {
        /// Local directory to sync
        #[arg(short, long)]
        path: PathBuf,

        /// GitHub remote URL
        #[arg(long)]
        remote_url: String,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("vaultgitsync=info".parse().unwrap()),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Daemon {
            repo,
            remote,
            branch,
        } => {
            if let Err(e) = daemon::run(repo, remote, branch).await {
                tracing::error!("Daemon error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Status { repo } => {
            if let Err(e) = git_ops::print_status(&repo) {
                tracing::error!("Status error: {e}");
                std::process::exit(1);
            }
        }
        Commands::Conflicts { repo } => {
            git_ops::list_conflicts(&repo);
        }
        Commands::Init { path, remote_url } => {
            if let Err(e) = git_ops::init_repo(&path, &remote_url) {
                tracing::error!("Init error: {e}");
                std::process::exit(1);
            }
        }
    }
}
