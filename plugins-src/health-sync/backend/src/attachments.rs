//! Preserve every regular ZIP attachment as bytes without extracting source paths.
//! Standalone XML imports never scan neighboring files. Waveforms, routes, and
//! clinical documents remain original source evidence rather than inferred facts.
use crate::{catalog::metric_slug, model::HealthRecord};
use chrono::NaiveDate;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

const MAX_ATTACHMENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;

pub struct Attachment {
    pub record: HealthRecord,
    /// Absolute path inside the caller's staging directory.
    pub file: PathBuf,
    /// Vault-relative destination, including the health/ prefix.
    pub relative_path: PathBuf,
    pub sha256: String,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn safe_name(name: &str, directory: bool) -> Result<(), String> {
    let trimmed = if directory {
        name.trim_end_matches('/')
    } else {
        name
    };
    if trimmed.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(char::is_control)
        || trimmed
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err("Unsafe attachment path in Apple Health ZIP".into());
    }
    Ok(())
}

fn attachment_day(basename: &str) -> String {
    let lower = basename.to_ascii_lowercase();
    let suffix = lower
        .strip_prefix("ecg_")
        .or_else(|| lower.strip_prefix("route_"));
    if let Some(suffix) = suffix {
        if let Some(date) = suffix.get(..10) {
            let valid_suffix = suffix.len() == 10
                || matches!(suffix.as_bytes()[10], b'_' | b'-' | b' ' | b't' | b'.');
            if valid_suffix
                && date.bytes().enumerate().all(|(i, b)| {
                    if matches!(i, 4 | 7) {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
                && NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
            {
                return date.into();
            }
        }
    }
    "_undated".into()
}

fn classify(name: &str) -> (&'static str, &'static str, &'static str) {
    let lower = name.to_ascii_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);
    let extension = basename.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    let (metric, category) = if extension == "gpx" {
        ("attachment.workout-route", "activity")
    } else if basename == "export_cda.xml" {
        ("attachment.clinical", "clinical")
    } else if basename.starts_with("ecg_") || lower.split('/').any(|p| p == "electrocardiograms") {
        ("attachment.electrocardiogram", "heart")
    } else {
        ("attachment.other", "other")
    };
    let mime = match extension {
        "gpx" => "application/gpx+xml",
        "xml" => "application/xml",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    (metric, category, mime)
}

fn destination(name: &str, day: &str, sha256: &str) -> PathBuf {
    let basename = name.rsplit('/').next().unwrap_or(name);
    let (stem, extension) = basename.rsplit_once('.').unwrap_or((basename, "bin"));
    let extension = if !extension.is_empty()
        && extension.len() <= 12
        && extension.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        extension.to_ascii_lowercase()
    } else {
        "bin".into()
    };
    PathBuf::from("health")
        .join("attachments")
        .join(day)
        .join(format!("{}-{sha256}.{extension}", metric_slug(stem)))
}

pub fn extract_attachments(input: &Path, staging: &Path) -> Result<Vec<Attachment>, String> {
    extract_with_limits(input, staging, MAX_ATTACHMENT_BYTES, MAX_TOTAL_BYTES)
}

fn extract_with_limits(
    input: &Path,
    staging: &Path,
    per_file_limit: u64,
    total_limit: u64,
) -> Result<Vec<Attachment>, String> {
    let mut input = File::open(input).map_err(error)?;
    let mut magic = [0u8; 4];
    let size = input.read(&mut magic).map_err(error)?;
    if size != 4 || !matches!(&magic, b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08") {
        return Ok(vec![]);
    }
    input.seek(SeekFrom::Start(0)).map_err(error)?;
    let mut archive =
        zip::ZipArchive::new(input).map_err(|e| format!("Invalid Apple Health ZIP: {e}"))?;
    let mut names = HashSet::new();
    let mut selected = None;
    let mut indices = vec![];
    let mut declared_total = 0u64;
    // Check the whole directory before copying any file. ZIP directory traversal
    // and special filesystem entries are errors even though we never use names
    // as extraction destinations.
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Invalid Apple Health ZIP entry: {e}"))?;
        let directory = entry.is_dir();
        safe_name(entry.name(), directory)?;
        if !names.insert(entry.name().to_string()) {
            return Err("Duplicate ZIP entry name in Apple Health export".into());
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if (directory && !matches!(kind, 0 | 0o040000))
                || (!directory && !matches!(kind, 0 | 0o100000))
            {
                return Err("Apple Health ZIP contains a symlink or non-regular entry".into());
            }
        }
        if directory {
            continue;
        }
        if matches!(
            entry.name(),
            "export.xml" | "apple_health_export/export.xml"
        ) {
            if selected.replace(i).is_some() {
                return Err("ZIP contains multiple export.xml candidates".into());
            }
            continue;
        }
        if entry.size() > per_file_limit {
            return Err(format!(
                "Apple Health attachment exceeds the {per_file_limit}-byte per-file limit"
            ));
        }
        declared_total = declared_total
            .checked_add(entry.size())
            .ok_or("Attachment sizes overflow")?;
        if declared_total > total_limit {
            return Err(format!(
                "Apple Health attachments exceed the {total_limit}-byte total limit"
            ));
        }
        indices.push(i);
    }
    if selected.is_none() {
        return Err("ZIP must contain export.xml or apple_health_export/export.xml".into());
    }
    if indices.is_empty() {
        return Ok(vec![]);
    }
    let staging = staging
        .canonicalize()
        .map_err(|e| format!("Attachment staging: {e}"))?;
    if !staging.is_dir() {
        return Err("Attachment staging must be an existing directory".into());
    }
    let directory = tempfile::Builder::new()
        .prefix("apple-attachments-")
        .tempdir_in(staging)
        .map_err(error)?;
    let mut result = vec![];
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    for index in indices {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Cannot read ZIP attachment: {e}"))?;
        let name = entry.name().to_string();
        let declared_size = entry.size();
        let mut file = NamedTempFile::new_in(directory.path()).map_err(error)?;
        let mut hasher = Sha256::new();
        let mut count = 0u64;
        loop {
            // Reading until EOF also makes zip verify the entry's CRC. A bad
            // final block aborts before any file is returned to the caller.
            let amount = entry
                .read(&mut buffer)
                .map_err(|e| format!("Invalid attachment data or CRC for {name}: {e}"))?;
            if amount == 0 {
                break;
            }
            count = count
                .checked_add(amount as u64)
                .ok_or("Attachment size overflow")?;
            total = total
                .checked_add(amount as u64)
                .ok_or("Attachment total overflow")?;
            if count > per_file_limit || total > total_limit {
                return Err("Apple Health attachment uncompressed size limit exceeded".into());
            }
            hasher.update(&buffer[..amount]);
            file.write_all(&buffer[..amount]).map_err(error)?;
        }
        if count != declared_size {
            return Err(format!("Inconsistent attachment size: {name}"));
        }
        let sha256 = format!("{:x}", hasher.finalize());
        let stored = if let Some(existing) = files.get(&sha256) {
            existing.clone()
        } else {
            file.as_file().sync_all().map_err(error)?;
            let path = directory.path().join(&sha256);
            file.persist_noclobber(&path).map_err(error)?;
            files.insert(sha256.clone(), path.clone());
            path
        };
        let basename = name.rsplit('/').next().unwrap_or(&name);
        let day = attachment_day(basename);
        let relative_path = destination(&name, &day, &sha256);
        let (metric, category, mime) = classify(&name);
        let filename = relative_path
            .iter()
            .map(|p| p.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        let record = HealthRecord {
            schema_version: 1,
            ingest_source: "apple-health".into(),
            kind: "Attachment".into(),
            day,
            metric: metric.into(),
            attributes: BTreeMap::from([
                ("original_name".into(), name),
                ("filename".into(), filename),
                ("sha256".into(), sha256.clone()),
                ("size".into(), count.to_string()),
                ("mime".into(), mime.into()),
                ("category".into(), category.into()),
            ]),
            children: vec![],
            text: String::new(),
            text_segments: None,
            payload: None,
        };
        result.push(Attachment {
            record,
            file: stored,
            relative_path,
            sha256,
        });
    }
    // The caller owns staging and its cleanup. Until success the TempDir guard
    // removes every partial or corrupt copy automatically.
    let _ = directory.keep();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    fn make_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in files {
            zip.start_file(
                *name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn retains_every_attachment_with_safe_day_category_and_exact_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("export.zip");
        make_zip(
            &input,
            &[
                ("apple_health_export/export.xml", b"<HealthData/>"),
                (
                    "apple_health_export/electrocardiograms/ecg_2026-10-24_12.00.csv",
                    b"Lead,Voltage\n1,0.42\n",
                ),
                (
                    "apple_health_export/workout-routes/route_2026-10-23_08.00.gpx",
                    b"<gpx>route</gpx>",
                ),
                ("apple_health_export/export_cda.xml", b"<ClinicalDocument/>"),
                (
                    "apple_health_export/unknown/2026-10-22 future data.blob",
                    b"\x00\xffraw",
                ),
            ],
        );
        let files = extract_attachments(&input, temp.path()).unwrap();
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].record.day, "2026-10-24");
        assert_eq!(files[0].record.metric, "attachment.electrocardiogram");
        assert_eq!(files[1].record.day, "2026-10-23");
        assert_eq!(files[1].record.attributes["category"], "activity");
        assert_eq!(files[2].record.day, "_undated");
        assert_eq!(files[2].record.metric, "attachment.clinical");
        assert_eq!(files[3].record.day, "_undated");
        assert_eq!(fs::read(&files[3].file).unwrap(), b"\x00\xffraw");
        for file in files {
            assert!(file.file.is_absolute());
            assert!(file.file.starts_with(temp.path().canonicalize().unwrap()));
            assert_eq!(
                file.file.file_name().unwrap().to_str().unwrap(),
                file.sha256
            );
            assert!(file.relative_path.to_str().unwrap().is_ascii());
            assert!(file.record.payload.is_none());
            assert_eq!(
                file.record.attributes["sha256"],
                format!("{:x}", Sha256::digest(fs::read(file.file).unwrap()))
            );
        }
    }

    #[test]
    fn xml_never_scans_neighbors_and_equal_bytes_share_staging_file() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("export.xml");
        fs::write(&input, b"<HealthData/>").unwrap();
        fs::write(temp.path().join("ecg_2026-10-24.csv"), b"private sibling").unwrap();
        assert!(extract_attachments(&input, temp.path()).unwrap().is_empty());
        let zip = temp.path().join("export.zip");
        make_zip(
            &zip,
            &[
                ("export.xml", b"x"),
                ("one.txt", b"same"),
                ("two.txt", b"same"),
            ],
        );
        let files = extract_attachments(&zip, temp.path()).unwrap();
        assert_eq!(files[0].file, files[1].file);
        assert_ne!(files[0].relative_path, files[1].relative_path);
    }

    #[test]
    fn rejects_unsafe_names_ambiguous_main_xml_and_oversized_files() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("export.zip");
        for name in [
            "../a", "/a", "C:/a", "a\\b", "a/./b", "a//b", "a\0b", "a\nb",
        ] {
            make_zip(&input, &[("export.xml", b"x"), (name, b"payload")]);
            assert!(
                extract_attachments(&input, temp.path()).is_err(),
                "accepted {name:?}"
            );
        }
        make_zip(
            &input,
            &[
                ("export.xml", b"x"),
                ("apple_health_export/export.xml", b"x"),
            ],
        );
        assert!(extract_attachments(&input, temp.path()).is_err());
        make_zip(&input, &[("export.xml", b"x"), ("a", b"12345")]);
        assert!(extract_with_limits(&input, temp.path(), 4, 100).is_err());
        make_zip(
            &input,
            &[("export.xml", b"x"), ("a", b"1234"), ("b", b"5678")],
        );
        assert!(extract_with_limits(&input, temp.path(), 4, 7).is_err());
    }

    #[test]
    fn retains_zero_length_placeholders_as_original_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("export.zip");
        make_zip(&input, &[("export.xml", b"x"), ("empty.csv", b"")]);
        let files = extract_attachments(&input, temp.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].record.attributes["size"], "0");
        assert_eq!(files[0].sha256, format!("{:x}", Sha256::digest(b"")));
        assert!(fs::read(&files[0].file).unwrap().is_empty());
    }

    #[test]
    fn rejects_crc_corruption_and_symlink_without_leaving_partial_copies() {
        let temp = tempfile::tempdir().unwrap();
        let input = temp.path().join("export.zip");
        make_zip(&input, &[("export.xml", b"x"), ("a.txt", b"abcdef")]);
        let offset = {
            let mut zip = zip::ZipArchive::new(File::open(&input).unwrap()).unwrap();
            let offset = zip.by_index(1).unwrap().data_start();
            offset
        };
        let mut corrupt = fs::OpenOptions::new().write(true).open(&input).unwrap();
        corrupt.seek(SeekFrom::Start(offset)).unwrap();
        corrupt.write_all(b"Z").unwrap();
        drop(corrupt);
        let staging = temp.path().join("staging");
        fs::create_dir(&staging).unwrap();
        assert!(extract_attachments(&input, &staging).is_err());
        assert!(fs::read_dir(&staging).unwrap().next().is_none());
        let mut zip = ZipWriter::new(File::create(&input).unwrap());
        zip.start_file("export.xml", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"x").unwrap();
        zip.add_symlink("link", "/outside", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        assert!(extract_attachments(&input, &staging).is_err());
    }

    #[test]
    fn filenames_are_bounded_and_invalid_or_incidental_dates_stay_undated() {
        for name in [
            "ecg_2026-02-30.csv",
            "route_2026-10-2412.gpx",
            "unknown_2026-10-24.csv",
            "2026-10-24.csv",
        ] {
            assert_eq!(attachment_day(name), "_undated");
        }
        let path = destination(
            &format!("{}..奇怪/{}.🚀", "x".repeat(1000), "z".repeat(1000)),
            "_undated",
            &"f".repeat(64),
        );
        let filename = path.file_name().unwrap().to_str().unwrap();
        assert!(filename.is_ascii());
        assert!(filename.len() < 255);
        assert!(filename.ends_with(".bin"));
    }
}
