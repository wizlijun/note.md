use super::{
    reader::{self, Snapshot},
    Result, MAX_SOURCE, MAX_ZIP,
};
use crate::sotvault::logic::sha256_hex;
use std::{
    collections::HashSet,
    io::{Cursor, Read},
};
fn u16_at(b: &[u8], p: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        b.get(p..p + 2).ok_or("truncated ZIP")?.try_into().unwrap(),
    ))
}
fn u32_at(b: &[u8], p: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        b.get(p..p + 4).ok_or("truncated ZIP")?.try_into().unwrap(),
    ))
}
fn extras(b: &[u8]) -> Result<()> {
    let mut i = 0;
    while i < b.len() {
        let id = u16_at(b, i)?;
        let n = u16_at(b, i + 2)? as usize;
        i += 4;
        if !matches!(id, 0x5455 | 0x000a) || i + n > b.len() {
            return Err("unsupported ZIP extra metadata".into());
        }
        i += n;
    }
    Ok(())
}
/// Check the physical archive as well as ZipArchive's logical directory. No prepended,
/// trailing, overlapping or unlisted local records can be hidden by the central directory.
fn structure(b: &[u8]) -> Result<()> {
    if b.len() > MAX_ZIP || b.len() < 22 {
        return Err("ZIP size invalid".into());
    }
    let end = (b.len().saturating_sub(65557)..=b.len() - 22)
        .rev()
        .find(|&i| {
            b[i..].starts_with(b"PK\x05\x06")
                && u16_at(b, i + 20).is_ok_and(|n| i + 22 + n as usize == b.len())
        })
        .ok_or("missing ZIP directory")?;
    if u16_at(b, end + 4)? != 0
        || u16_at(b, end + 6)? != 0
        || u16_at(b, end + 8)? != u16_at(b, end + 10)?
    {
        return Err("multidisk ZIP".into());
    }
    let count = u16_at(b, end + 10)? as usize;
    if count == 0 || count > 514 {
        return Err("ZIP entry count invalid".into());
    }
    let size = u32_at(b, end + 12)? as usize;
    let start = u32_at(b, end + 16)? as usize;
    if start.checked_add(size) != Some(end) {
        return Err("invalid ZIP directory range".into());
    }
    let mut p = start;
    let mut spans = vec![];
    let mut names = HashSet::new();
    for _ in 0..count {
        if u32_at(b, p)? != 0x02014b50 {
            return Err("invalid central header".into());
        }
        let flags = u16_at(b, p + 8)?;
        let method = u16_at(b, p + 10)?;
        if flags & !0x080e != 0 || !matches!(method, 0 | 8) || u16_at(b, p + 34)? != 0 {
            return Err("unsupported ZIP flags or method".into());
        }
        let crc = u32_at(b, p + 16)?;
        let compressed = u32_at(b, p + 20)? as usize;
        let size = u32_at(b, p + 24)?;
        let nl = u16_at(b, p + 28)? as usize;
        let xl = u16_at(b, p + 30)? as usize;
        let cl = u16_at(b, p + 32)? as usize;
        let name = b.get(p + 46..p + 46 + nl).ok_or("truncated ZIP name")?;
        let name_text = std::str::from_utf8(name).map_err(|_| "invalid ZIP name UTF-8")?;
        if !names.insert(name_text.to_lowercase()) {
            return Err("duplicate ZIP name".into());
        }
        let attrs = u32_at(b, p + 38)?;
        let mode = (attrs >> 16) & 0xf000;
        if (mode != 0 && mode != 0x8000) || attrs & 0x18 != 0 || name_text.ends_with('/') {
            return Err("non-regular ZIP file".into());
        }
        extras(
            b.get(p + 46 + nl..p + 46 + nl + xl)
                .ok_or("truncated ZIP extras")?,
        )?;
        let local = u32_at(b, p + 42)? as usize;
        if local >= start
            || u32_at(b, local)? != 0x04034b50
            || u16_at(b, local + 6)? != flags
            || u16_at(b, local + 8)? != method
        {
            return Err("central/local conflict".into());
        }
        for (central_offset, local_offset) in [(6, 4), (12, 10), (14, 12)] {
            if u16_at(b, p + central_offset)? != u16_at(b, local + local_offset)? {
                return Err("central/local metadata conflict".into());
            }
        }
        let ln = u16_at(b, local + 26)? as usize;
        let lx = u16_at(b, local + 28)? as usize;
        if b.get(local + 30..local + 30 + ln) != Some(name) {
            return Err("central/local name conflict".into());
        }
        extras(
            b.get(local + 30 + ln..local + 30 + ln + lx)
                .ok_or("truncated local extras")?,
        )?;
        let mut finish = local
            .checked_add(30 + ln + lx)
            .and_then(|n| n.checked_add(compressed))
            .ok_or("invalid ZIP range")?;
        if flags & 8 == 0 {
            if u32_at(b, local + 14)? != crc
                || u32_at(b, local + 18)? as usize != compressed
                || u32_at(b, local + 22)? != size
            {
                return Err("central/local sizes or CRC conflict".into());
            }
        } else {
            for (offset, expected) in [(14, crc), (18, compressed as u32), (22, size)] {
                let v = u32_at(b, local + offset)?;
                if v != 0 && v != expected {
                    return Err("local descriptor conflict".into());
                }
            }
            if u32_at(b, finish)? == 0x08074b50 {
                finish += 4
            }
            if u32_at(b, finish)? != crc
                || u32_at(b, finish + 4)? as usize != compressed
                || u32_at(b, finish + 8)? != size
            {
                return Err("invalid ZIP descriptor".into());
            }
            finish += 12;
        }
        if finish > start {
            return Err("overlapping ZIP data".into());
        }
        spans.push((local, finish));
        p = p
            .checked_add(46 + nl + xl + cl)
            .ok_or("invalid directory size")?;
        if p > end {
            return Err("directory overflow".into());
        }
    }
    if p != end {
        return Err("unlisted central record".into());
    }
    spans.sort_unstable();
    let mut at = 0;
    for (a, z) in spans {
        if a != at {
            return Err("overlap or unlisted local record".into());
        }
        at = z;
    }
    if at != start {
        return Err("unlisted local bytes".into());
    }
    Ok(())
}
pub fn validate(bytes: &[u8], snapshot: &Snapshot) -> Result<()> {
    structure(bytes)?;
    let manifest = &snapshot.manifest;
    let prefix = format!(".__notemd-{}/", manifest.snapshot_id);
    let manifest_path = format!("{prefix}manifest.json");
    let reader_path = format!("{prefix}reader.html");
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "invalid ZIP")?;
    let mut seen = HashSet::new();
    let mut internal = std::collections::BTreeMap::new();
    let mut total = 0usize;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|_| "invalid ZIP entry")?;
        let path = file.name().to_string();
        let source = manifest.files.iter().find(|f| f.path == path);
        let limit = if let Some(f) = source {
            reader::valid_path(&path)?;
            f.bytes
        } else if path == manifest_path {
            256 * 1024
        } else if path == reader_path {
            MAX_SOURCE
        } else {
            return Err("unlisted ZIP entry".into());
        };
        if file.size() > limit as u64 {
            return Err("ZIP expanded size exceeds limit".into());
        }
        let mut data = vec![];
        file.by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "ZIP decompression or CRC failure")?;
        if data.len() > limit {
            return Err("ZIP actual expanded size exceeds limit".into());
        }
        if let Some(f) = source {
            total += data.len();
            if total > MAX_SOURCE || data.len() != f.bytes || sha256_hex(&data) != f.hash {
                return Err("ZIP source hash or size mismatch".into());
            }
            seen.insert(path);
        } else {
            internal.insert(path, data);
        }
    }
    if seen.len() != manifest.files.len() {
        return Err("ZIP missing source files".into());
    }
    if !internal.is_empty() {
        if internal.len() != 2 {
            return Err("incomplete legacy metadata".into());
        }
        let mut expected = serde_json::to_value(manifest).map_err(|_| "invalid manifest")?;
        expected["htmlPath"] = reader_path.clone().into();
        if reader::unique_json(
            internal
                .get(&manifest_path)
                .ok_or("missing legacy manifest")?,
        )? != expected
        {
            return Err("legacy manifest mismatch".into());
        }
        let inside = reader::extract_public_snapshot(
            internal.get(&reader_path).ok_or("missing legacy reader")?,
        )?;
        if inside.manifest != *manifest || inside.source != snapshot.source {
            return Err("legacy reader mismatch".into());
        }
    }
    Ok(())
}
#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;
    pub fn fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        for (name, data) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    pub fn pair() -> (Snapshot, Vec<u8>) {
        let s = reader::extract_public_snapshot(&reader::tests::html(1)).unwrap();
        let z = fixture(&[("0.md", &s.source[0])]);
        (s, z)
    }
    fn central(b: &[u8]) -> usize {
        b.windows(4).position(|w| w == b"PK\x01\x02").unwrap()
    }
    #[test]
    fn archive_accepts_actual_source_and_legacy_production_packages() {
        let snapshot =
            reader::extract_public_snapshot(include_bytes!("fixtures/reader.html")).unwrap();
        validate(include_bytes!("fixtures/source.zip"), &snapshot).unwrap();
        validate(include_bytes!("fixtures/legacy.zip"), &snapshot).unwrap();
        assert_eq!(snapshot.source[1], [0, 1, 2, 3]);
    }
    #[test]
    fn archive_rejects_traversal() {
        let (s, _) = pair();
        for path in [
            "../escape.md",
            "/a.md",
            "a\\b.md",
            "a:b.md",
            ".notemd/a",
            "a.note.md",
            "node_modules/x",
            "id_rsa",
            "a//b",
        ] {
            assert!(validate(&fixture(&[(path, b"x")]), &s).is_err())
        }
    }
    #[test]
    fn archive_source_legacy_and_completeness() {
        let (s, z) = pair();
        validate(&z, &s).unwrap();
        assert!(validate(&fixture(&[("other.md", &s.source[0])]), &s).is_err());
        assert!(validate(&fixture(&[("0.md", b"wrong")]), &s).is_err());
        let mut m = serde_json::to_value(&s.manifest).unwrap();
        m["htmlPath"] = ".__notemd-sid/reader.html".into();
        let m = serde_json::to_vec(&m).unwrap();
        let h = reader::tests::html(1);
        validate(
            &fixture(&[
                ("0.md", &s.source[0]),
                (".__notemd-sid/manifest.json", &m),
                (".__notemd-sid/reader.html", &h),
            ]),
            &s,
        )
        .unwrap();
        assert!(validate(
            &fixture(&[("0.md", &s.source[0]), (".__notemd-sid/manifest.json", &m)]),
            &s
        )
        .is_err());
    }
    #[test]
    fn archive_metadata_crc_symlink_overlap_multidisk_encryption() {
        let (s, z) = pair();
        let c = central(&z);
        for offset in [
            c + 8,
            c + 10,
            c + 16,
            c + 20,
            c + 24,
            c + 34,
            c + 42,
            6,
            8,
            14,
            18,
            22,
            30,
        ] {
            let mut bad = z.clone();
            bad[offset] ^= 1;
            assert!(validate(&bad, &s).is_err(), "offset {offset}")
        }
        for mode in [0xa000u32, 0x6000, 0x4000] {
            let mut bad = z.clone();
            bad[c + 38..c + 42].copy_from_slice(&(mode << 16).to_le_bytes());
            assert!(validate(&bad, &s).is_err());
        }
        let mut bad = z.clone();
        bad[14] ^= 1;
        bad[c + 16] ^= 1;
        assert!(validate(&bad, &s).is_err());
        let mut bad = z.clone();
        bad.insert(c, 0);
        let e = bad.len() - 22;
        bad[e + 16..e + 20].copy_from_slice(&((c + 1) as u32).to_le_bytes());
        assert!(validate(&bad, &s).is_err());
        assert!(validate(&z[..z.len() - 1], &s).is_err());
    }
    #[test]
    fn archive_counts_actual_inflate_even_when_metadata_lies() {
        let (s, _) = pair();
        let mut bomb = fixture(&[("0.md", &vec![b'x'; 1024 * 1024])]);
        let c = central(&bomb);
        let n = s.manifest.files[0].bytes as u32;
        bomb[22..26].copy_from_slice(&n.to_le_bytes());
        bomb[c + 24..c + 28].copy_from_slice(&n.to_le_bytes());
        let error = validate(&bomb, &s).unwrap_err();
        assert!(
            error.contains("actual expanded") || error.contains("CRC"),
            "{error}"
        );
    }
    #[test]
    fn archive_duplicate_name_extra_local_and_bomb() {
        let (s, _) = pair();
        let z = fixture(&[("0.md", &s.source[0]), ("1.md", &s.source[0])]);
        let mut bad = z.clone();
        for window in 0..bad.len() - 4 {
            if &bad[window..window + 4] == b"1.md" {
                bad[window] = b'0'
            }
        }
        assert!(validate(&bad, &s).is_err());
        // Remove a central record while preserving its local entry.
        let first = central(&z);
        let second = first + 50;
        let mut bad = z.clone();
        bad.drain(second..second + 50);
        let e = bad.len() - 22;
        bad[e + 8..e + 12].copy_from_slice(&[1, 0, 1, 0]);
        bad[e + 12..e + 16].copy_from_slice(&50u32.to_le_bytes());
        assert!(validate(&bad, &s).is_err());
        let bomb = fixture(&[("0.md", &vec![b'x'; MAX_SOURCE + 1])]);
        assert!(validate(&bomb, &s).is_err());
        let mut overlap = z.clone();
        overlap[second + 42..second + 46].copy_from_slice(&0u32.to_le_bytes());
        assert!(validate(&overlap, &s).is_err());
    }
}
