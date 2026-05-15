use git2::Signature;
use super::{VaultError, VaultIosManager};

pub fn author_sig<'a>(mgr: &VaultIosManager) -> Result<Signature<'a>, VaultError> {
    let name = mgr.author_name.lock().unwrap().clone();
    let mut email = mgr.author_email.lock().unwrap().clone();
    if email.is_empty() {
        email = "noreply@mdeditor.local".into();
    }
    Signature::now(&name, &email).map_err(VaultError::from)
}

pub fn timestamp_compact() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let tod = secs % 86400;
    let h = tod / 3600;
    let m = (tod % 3600) / 60;
    let s = tod % 60;
    let mut y = 1970u64;
    let mut rem = days;
    loop {
        let dy = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 };
        if rem < dy { break; }
        rem -= dy;
        y += 1;
    }
    let mt: [u64; 12] = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
        [31,29,31,30,31,30,31,31,30,31,30,31]
    } else {
        [31,28,31,30,31,30,31,31,30,31,30,31]
    };
    let mut mo = 1u64;
    for &d in &mt { if rem < d { break; } rem -= d; mo += 1; }
    let day = rem + 1;
    format!("{y:04}{mo:02}{day:02}-{h:02}{m:02}{s:02}")
}
