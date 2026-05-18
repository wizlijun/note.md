use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn empty_file_known_hash() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("empty");
        std::fs::write(&p, "").unwrap();
        assert_eq!(
            file_sha256(&p).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn small_file_matches_shasum_output() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("hello");
        std::fs::write(&p, "hello").unwrap();
        assert_eq!(
            file_sha256(&p).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn multi_buffer_file() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("big");
        let data = vec![0u8; 200 * 1024];
        std::fs::write(&p, &data).unwrap();
        let h = file_sha256(&p).unwrap();
        assert_eq!(h.len(), 64);
    }
}
