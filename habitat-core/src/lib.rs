//! Shared contract: no filesystem writes, network, or model invocation.
pub mod codec;
pub mod diff;
pub mod extract;
pub mod model;
pub mod organize;
pub use codec::{decode, encode, finalize, validate};
pub use model::*;

pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

pub fn stable_id(kind: &str, key: &str) -> String {
    format!("{kind}:{}", &hash(key)[..24])
}
