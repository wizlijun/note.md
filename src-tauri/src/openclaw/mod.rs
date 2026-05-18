pub mod commands;
pub mod config;
pub mod pair;       // NEW
pub mod protocol;
pub mod state;
pub mod uds_client;
// later tasks: pub mod relay_client; pub mod relay_bridge; pub mod devices;

pub use state::{OpenClawState, init_state};
