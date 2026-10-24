//! Streaming intake of complete Apple Health exports. No ZIP entries are extracted.
use crate::model::{HealthRecord, XmlNode};
use chrono::NaiveDate;
use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

const MAX_XML_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DEPTH: usize = 128;

// Apple localizes the primary filename. Keep intake and attachment exclusion
// identical; export_cda.xml is a separate clinical attachment, never the primary.
pub(crate) fn is_primary_xml(name: &str) -> bool {
    matches!(
        name.strip_prefix("apple_health_export/").unwrap_or(name),
        "export.xml" | "导出.xml"
    )
}

pub(crate) const MISSING_PRIMARY_XML: &str =
    "ZIP must contain export.xml or 导出.xml at its root or under apple_health_export/";
pub(crate) const MULTIPLE_PRIMARY_XML: &str = "ZIP contains multiple primary Health XML candidates";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ParseStats {
    pub records: u64,
    pub export_date: Option<String>,
    pub ignored_attachments: u64,
    pub root_attributes: BTreeMap<String, String>,
}

pub fn parse_export(
    path: &Path,
    mut emit: impl FnMut(HealthRecord) -> Result<(), String>,
) -> Result<ParseStats, String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot open export: {e}"))?;
    let mut magic = [0; 4];
    let n = file
        .read(&mut magic)
        .map_err(|e| format!("Cannot read export: {e}"))?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    if n == 4 && matches!(&magic, b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08") {
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Invalid export ZIP: {e}"))?;
        let mut selected = None;
        let mut ignored = 0;
        for i in 0..archive.len() {
            let entry = archive
                .by_index(i)
                .map_err(|e| format!("Cannot inspect ZIP entry: {e}"))?;
            let name = entry.name();
            if name.starts_with('/')
                || name.contains('\\')
                || name.contains('\0')
                || name
                    .split('/')
                    .any(|part| part == ".." || part.contains(':'))
            {
                return Err("Unsafe path in export ZIP".into());
            }
            if entry.is_dir() {
                continue;
            }
            if is_primary_xml(name) {
                if selected.replace(i).is_some() {
                    return Err(MULTIPLE_PRIMARY_XML.into());
                }
                if entry.size() > MAX_XML_BYTES {
                    return Err("Export XML exceeds the 64 GiB limit".into());
                }
            } else {
                ignored += 1;
            }
        }
        let index = selected.ok_or(MISSING_PRIMARY_XML)?;
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("Cannot open primary Health XML: {e}"))?;
        let mut stats = parse_xml(entry, &mut emit, MAX_RECORD_BYTES)?;
        stats.ignored_attachments = ignored;
        Ok(stats)
    } else {
        if file.metadata().map_err(|e| e.to_string())?.len() > MAX_XML_BYTES {
            return Err("Export XML exceeds the 64 GiB limit".into());
        }
        parse_xml(file, &mut emit, MAX_RECORD_BYTES)
    }
}

// Bound each token as well as each complete record: a single huge attribute or text
// token must not make quick-xml allocate the entire export before our next check.
struct BoundedInput<R> {
    inner: BufReader<R>,
    total: u64,
    event: u64,
    event_limit: u64,
}
impl<R: Read> Read for BoundedInput<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let input = self.fill_buf()?;
        let n = input.len().min(out.len());
        out[..n].copy_from_slice(&input[..n]);
        self.consume(n);
        Ok(n)
    }
}
impl<R: Read> BufRead for BoundedInput<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        let input = self.inner.fill_buf()?;
        if input.is_empty() {
            return Ok(input);
        }
        let remaining = (MAX_XML_BYTES - self.total).min(self.event_limit - self.event);
        if remaining == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "XML size/token limit exceeded",
            ));
        }
        Ok(&input[..input.len().min(remaining as usize)])
    }
    fn consume(&mut self, amount: usize) {
        self.inner.consume(amount);
        self.total += amount as u64;
        self.event += amount as u64;
    }
}

fn node<R: BufRead>(element: &BytesStart<'_>, reader: &Reader<R>) -> Result<XmlNode, String> {
    let name = std::str::from_utf8(element.name().as_ref())
        .map_err(|_| "XML must be UTF-8")?
        .to_owned();
    let mut attributes = BTreeMap::new();
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|e| format!("Invalid XML attribute: {e}"))?;
        let key = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|_| "XML must be UTF-8")?
            .to_owned();
        let value = attribute
            .decode_and_unescape_value(reader.decoder())
            .map_err(|e| format!("Invalid XML attribute: {e}"))?
            .into_owned();
        validate_text(&value)?;
        attributes.insert(key, value);
    }
    Ok(XmlNode {
        name,
        attributes,
        children: vec![],
        text: String::new(),
        text_segments: None,
    })
}

fn finish(
    element: XmlNode,
    stats: &mut ParseStats,
    emit: &mut impl FnMut(HealthRecord) -> Result<(), String>,
) -> Result<(), String> {
    if element.name == "ExportDate" {
        if stats.export_date.is_some() {
            return Err("Duplicate ExportDate".into());
        }
        let value = element
            .attributes
            .get("value")
            .ok_or("ExportDate has no value")?;
        if chrono::DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S %z").is_err()
            && chrono::DateTime::parse_from_rfc3339(value).is_err()
        {
            return Err("ExportDate must contain a valid timestamp and timezone".into());
        }
        stats.export_date = Some(value.clone());
        return Ok(());
    }
    let mut day = "_undated".to_owned();
    for key in ["startDate", "dateComponents", "creationDate"] {
        if let Some(value) = element.attributes.get(key) {
            let date = value
                .get(..10)
                .ok_or_else(|| format!("Invalid {key} on {}", element.name))?;
            if date.as_bytes().get(4) != Some(&b'-')
                || date.as_bytes().get(7) != Some(&b'-')
                || !date
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit())
                || NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err()
                || (value.len() > 10 && !matches!(value.as_bytes()[10], b' ' | b'T'))
            {
                return Err(format!("Invalid {key} on {}", element.name));
            }
            day = date.to_owned();
            break;
        }
    }
    let metric = match element.name.as_str() {
        "Record" => element.attributes.get("type"),
        "Workout" => element.attributes.get("workoutActivityType"),
        _ => None,
    }
    .cloned()
    .unwrap_or_else(|| element.name.clone());
    emit(HealthRecord {
        schema_version: 1,
        ingest_source: "apple-health".into(),
        kind: element.name,
        day,
        metric,
        attributes: element.attributes,
        children: element.children,
        text: element.text,
        text_segments: element.text_segments,
        payload: None,
    })?;
    stats.records += 1;
    Ok(())
}

fn parse_xml<R: Read>(
    input: R,
    emit: &mut impl FnMut(HealthRecord) -> Result<(), String>,
    record_limit: u64,
) -> Result<ParseStats, String> {
    let mut reader = Reader::from_reader(BoundedInput {
        inner: BufReader::new(input),
        total: 0,
        event: 0,
        event_limit: record_limit,
    });
    reader.config_mut().check_end_names = true;
    reader.config_mut().check_comments = true;
    let mut buffer = Vec::new();
    let mut stack: Vec<XmlNode> = vec![];
    let mut preserve_spaces = vec![];
    let mut root_preserves_space = false;
    let mut root_seen = false;
    let mut root_closed = false;
    let mut declaration_seen = false;
    let mut doctype_seen = false;
    let mut record_start = 0;
    let mut stats = ParseStats::default();
    loop {
        reader.get_mut().event = 0;
        let before = reader.buffer_position();
        let event = reader.read_event_into(&mut buffer).map_err(|e| {
            format!(
                "Invalid export XML at byte {}: {e}",
                reader.buffer_position()
            )
        })?;
        if !stack.is_empty() && reader.buffer_position() - record_start > record_limit {
            return Err("XML record exceeds the 16 MiB limit".into());
        }
        match event {
            Event::Start(ref start) | Event::Empty(ref start) => {
                let empty = matches!(event, Event::Empty(_));
                let element = node(start, &reader)?;
                if !root_seen {
                    if element.name != "HealthData" {
                        return Err("Expected HealthData XML root".into());
                    }
                    stats.root_attributes = element.attributes;
                    root_preserves_space = stats
                        .root_attributes
                        .get("xml:space")
                        .is_some_and(|v| v == "preserve");
                    root_seen = true;
                    root_closed = empty;
                } else {
                    if root_closed {
                        return Err("Multiple XML root elements".into());
                    }
                    if stack.is_empty() {
                        record_start = before;
                    }
                    if stack.len() >= MAX_DEPTH {
                        return Err("XML nesting exceeds 128 levels".into());
                    }
                    if empty {
                        if let Some(parent) = stack.last_mut() {
                            append_child(parent, element);
                        } else {
                            finish(element, &mut stats, emit)?;
                        }
                    } else {
                        let inherited = preserve_spaces
                            .last()
                            .copied()
                            .unwrap_or(root_preserves_space);
                        preserve_spaces.push(
                            match element.attributes.get("xml:space").map(String::as_str) {
                                Some("preserve") => true,
                                Some("default") => false,
                                _ => inherited,
                            },
                        );
                        stack.push(element);
                    }
                }
            }
            Event::End(end) => {
                if let Some(mut element) = stack.pop() {
                    let preserve = preserve_spaces.pop().unwrap_or(false);
                    if element.text.trim().is_empty() && !preserve {
                        element.text.clear();
                    }
                    if element.text.is_empty() {
                        element.text_segments = None;
                    }
                    if let Some(parent) = stack.last_mut() {
                        append_child(parent, element);
                    } else {
                        finish(element, &mut stats, emit)?;
                    }
                } else if root_seen && !root_closed && end.name().as_ref() == b"HealthData" {
                    root_closed = true;
                } else {
                    return Err("Unexpected closing XML element".into());
                }
            }
            Event::Text(text) => {
                let text = std::str::from_utf8(text.as_ref()).map_err(|_| "XML must be UTF-8")?;
                append_text(&mut stack, text)?;
            }
            Event::CData(text) => {
                let text = std::str::from_utf8(text.as_ref()).map_err(|_| "XML must be UTF-8")?;
                if stack.is_empty() {
                    return Err("CDATA outside a HealthData record".into());
                }
                append_text(&mut stack, text)?;
            }
            Event::GeneralRef(reference) => {
                let reference =
                    std::str::from_utf8(reference.as_ref()).map_err(|_| "XML must be UTF-8")?;
                let escaped = format!("&{reference};");
                let text = quick_xml::escape::unescape(&escaped)
                    .map_err(|e| format!("Unsupported XML entity: {e}"))?;
                if stack.is_empty() {
                    return Err("Entity outside a HealthData record".into());
                }
                append_text(&mut stack, &text)?;
            }
            Event::DocType(doctype) => {
                if root_seen || doctype_seen {
                    return Err("Unexpected XML DOCTYPE".into());
                }
                doctype_seen = true;
                let text =
                    std::str::from_utf8(doctype.as_ref()).map_err(|_| "XML must be UTF-8")?;
                let upper = text.to_ascii_uppercase();
                if text
                    .trim_start()
                    .split(|c: char| c.is_whitespace() || c == '[')
                    .next()
                    != Some("HealthData")
                    || upper
                        .split('[')
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .any(|word| matches!(word, "SYSTEM" | "PUBLIC"))
                    || upper.contains("<!ENTITY")
                {
                    return Err(
                        "External resources and entity declarations are not allowed in XML".into(),
                    );
                }
            }
            Event::Decl(declaration) => {
                if root_seen || declaration_seen || doctype_seen {
                    return Err("Unexpected XML declaration".into());
                }
                declaration_seen = true;
                if declaration
                    .version()
                    .map_err(|e| format!("Invalid XML declaration: {e}"))?
                    .as_ref()
                    != b"1.0"
                {
                    return Err("Only XML 1.0 Apple exports are supported".into());
                }
                if let Some(encoding) = declaration.encoding() {
                    let encoding = encoding.map_err(|e| e.to_string())?;
                    if !encoding.eq_ignore_ascii_case(b"UTF-8") {
                        return Err("Only UTF-8 Apple exports are supported".into());
                    }
                }
            }
            Event::Eof => {
                if !root_seen || !root_closed || !stack.is_empty() {
                    return Err("Incomplete HealthData export".into());
                }
                return Ok(stats);
            }
            Event::Comment(_) | Event::PI(_) => {}
        }
        buffer.clear();
    }
}

fn append_text(stack: &mut [XmlNode], text: &str) -> Result<(), String> {
    validate_text(text)?;
    if let Some(element) = stack.last_mut() {
        element.text.push_str(text);
        if let Some(segments) = &mut element.text_segments {
            segments.last_mut().unwrap().push_str(text);
        }
        Ok(())
    } else if text.trim().is_empty() {
        Ok(())
    } else {
        Err("Unexpected text outside a HealthData record".into())
    }
}

fn append_child(parent: &mut XmlNode, child: XmlNode) {
    let segments = parent
        .text_segments
        .get_or_insert_with(|| vec![parent.text.clone()]);
    segments.push(String::new());
    parent.children.push(child);
}

fn validate_text(text: &str) -> Result<(), String> {
    if text
        .chars()
        .any(|c| matches!(c as u32, 0..=8 | 11..=12 | 14..=31 | 0xfffe | 0xffff))
    {
        Err("Invalid XML character".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn parse(xml: &str) -> Result<(Vec<HealthRecord>, ParseStats), String> {
        let mut rows = vec![];
        let stats = parse_xml(
            xml.as_bytes(),
            &mut |row| {
                rows.push(row);
                Ok(())
            },
            MAX_RECORD_BYTES,
        )?;
        Ok((rows, stats))
    }

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (ExportDate,Me,Record*)><!ATTLIST Record value CDATA #IMPLIED>]>
<HealthData locale="en_US"><ExportDate value="2026-10-24 09:00:00 +0900"/>
<Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01"/>
<Record value="72" type="HeartRate" startDate="2026-10-23 23:30:00 -0800" sourceName="Watch &amp; Me"><MetadataEntry key="k" value="v"/></Record>
<Future:Metric xmlns:Future="future" dateComponents="2026-10-24"><Detail>Hello &amp; world<![CDATA[!]]></Detail></Future:Metric>
</HealthData>"#;

    #[test]
    fn retains_unknown_nested_fields_and_local_dates() {
        let (rows, stats) = parse(SAMPLE).unwrap();
        assert_eq!(stats.records, 3);
        assert_eq!(stats.root_attributes["locale"], "en_US");
        assert_eq!(rows[0].day, "_undated");
        assert_eq!(rows[1].day, "2026-10-23");
        assert_eq!(rows[1].attributes["sourceName"], "Watch & Me");
        assert_eq!(rows[1].children[0].attributes["key"], "k");
        assert_eq!(rows[2].attributes["xmlns:Future"], "future");
        assert_eq!(rows[2].children[0].text, "Hello & world!");
    }

    #[test]
    fn zip_xml_and_bom_have_same_records() {
        let temp = tempfile::tempdir().unwrap();
        let xml = temp.path().join("export.dat");
        std::fs::write(&xml, format!("\u{feff}{SAMPLE}")).unwrap();
        let zip_path = temp.path().join("export.zip");
        let mut zip = zip::ZipWriter::new(File::create(&zip_path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("apple_health_export/export.xml", options)
            .unwrap();
        zip.write_all(SAMPLE.as_bytes()).unwrap();
        zip.start_file("apple_health_export/workout-routes/route.gpx", options)
            .unwrap();
        zip.write_all(b"route").unwrap();
        zip.finish().unwrap();
        let mut a = vec![];
        let mut b = vec![];
        parse_export(&xml, |r| {
            a.push(r);
            Ok(())
        })
        .unwrap();
        let stats = parse_export(&zip_path, |r| {
            b.push(r);
            Ok(())
        })
        .unwrap();
        assert_eq!(a, b);
        assert_eq!(stats.ignored_attachments, 1);
    }

    #[test]
    fn preserves_multiplicity_and_canonical_attributes() {
        let (rows, _) = parse(
            r#"<HealthData><Record type="X" value="1"/><Record value="1" type="X"/></HealthData>"#,
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], rows[1]);
    }

    #[test]
    fn mixed_content_keeps_text_positions_and_pure_records_stay_compact() {
        let (rows, _) = parse("<HealthData><Future>a<Child/>b</Future><Future>ab<Child/></Future><Future><Detail>before&amp;<X/>after<![CDATA[!]]></Detail></Future><Record type='X'><MetadataEntry key='k' value='v'/></Record></HealthData>").unwrap();
        assert_eq!(rows[0].text, "ab");
        assert_eq!(rows[0].text_segments, Some(vec!["a".into(), "b".into()]));
        assert_eq!(rows[1].text_segments, Some(vec!["ab".into(), "".into()]));
        assert_ne!(rows[0], rows[1]);
        assert_eq!(
            rows[2].children[0].text_segments,
            Some(vec!["before&".into(), "after!".into()])
        );
        let encoded = serde_json::to_string(&rows[3]).unwrap();
        assert!(!encoded.contains("text_segments"));
    }

    #[test]
    fn honors_inherited_xml_space_without_preserving_default_layout_whitespace() {
        let (rows, _) = parse("<HealthData><Future xml:space='preserve'> <Child> </Child> <Default xml:space='default'> </Default> </Future><Future> <Child/> </Future></HealthData>").unwrap();
        assert_eq!(
            rows[0].text_segments,
            Some(vec![" ".into(), " ".into(), " ".into()])
        );
        assert_eq!(rows[0].children[0].text, " ");
        assert_eq!(rows[0].children[1].text, "");
        assert_eq!(rows[1].text, "");
        assert_eq!(rows[1].text_segments, None);
        let (root, _) =
            parse("<HealthData xml:space='preserve'><Future> </Future></HealthData>").unwrap();
        assert_eq!(root[0].text, " ");
    }

    #[test]
    fn validates_export_timestamp_without_misreading_benign_internal_dtd_names() {
        for value in [
            "",
            "garbage",
            "2026-02-30 12:00:00 +0900",
            "2026-10-24 25:00:00 +0900",
            "2026-10-24",
        ] {
            assert!(parse(&format!(
                "<HealthData><ExportDate value='{value}'/></HealthData>"
            ))
            .is_err());
        }
        for value in ["2026-10-24 12:00:00 +0900", "2026-10-24T12:00:00+09:00"] {
            assert!(parse(&format!(
                "<HealthData><ExportDate value='{value}'/></HealthData>"
            ))
            .is_ok());
        }
        let (rows, _) = parse("<!DOCTYPE HealthData [<!ELEMENT HealthData (SystemStatus*)><!ELEMENT SystemStatus EMPTY><!ATTLIST SystemStatus visibility CDATA 'PUBLIC'>]><HealthData><SystemStatus visibility='PUBLIC'/></HealthData>").unwrap();
        assert_eq!(rows[0].kind, "SystemStatus");
        assert!(parse(
            "<!DOCTYPE HealthData PUBLIC 'x' 'https://example.invalid/schema'><HealthData/>"
        )
        .is_err());
    }

    #[test]
    fn rejects_partial_foreign_and_unsafe_xml() {
        for xml in [
            "",
            "<HealthData>",
            "<Other/>",
            "<HealthData><Record></HealthData>",
            "<HealthData/>garbage",
            "<HealthData/><HealthData/>",
            "<HealthData>&amp;</HealthData>",
            "<HealthData><Record>&evil;</Record></HealthData>",
            "<HealthData><Record>&#0;</Record></HealthData>",
            "<HealthData><Record>\u{0}</Record></HealthData>",
            r#"<!DOCTYPE HealthData SYSTEM "file:///secret"><HealthData/>"#,
            r#"<!DOCTYPE HealthData [<!ENTITY x "boom">]><HealthData/>"#,
            r#"<HealthData><Record startDate="2026-02-30"/></HealthData>"#,
            r#"<HealthData><Record startDate="2026-10-24bad"/></HealthData>"#,
            r#"<HealthData><Record a="1" a="2"/></HealthData>"#,
        ] {
            assert!(parse(xml).is_err(), "accepted {xml}");
        }
    }

    #[test]
    fn enforces_record_token_and_depth_limits() {
        for xml in [
            format!(
                "<HealthData><Record>{}</Record></HealthData>",
                "x".repeat(150)
            ),
            format!(
                "<HealthData><Record>{}</Record></HealthData>",
                "<X/>".repeat(40)
            ),
        ] {
            assert!(parse_xml(xml.as_bytes(), &mut |_| Ok(()), 100).is_err());
        }
        let deep = format!(
            "<HealthData>{}{}</HealthData>",
            "<X>".repeat(MAX_DEPTH + 1),
            "</X>".repeat(MAX_DEPTH + 1)
        );
        assert!(parse(&deep).is_err());
    }

    #[test]
    fn primary_xml_names_are_explicit_and_exclude_clinical_documents() {
        for name in [
            "export.xml",
            "导出.xml",
            "apple_health_export/export.xml",
            "apple_health_export/导出.xml",
        ] {
            assert!(is_primary_xml(name), "rejected {name}");
        }
        for name in [
            "export_cda.xml",
            "apple_health_export/export_cda.xml",
            "other/导出.xml",
            "apple_health_export/nested/export.xml",
        ] {
            assert!(!is_primary_xml(name), "accepted {name}");
        }
    }

    #[test]
    fn rejects_ambiguous_and_unsafe_archives() {
        for names in [
            ["export.xml", "apple_health_export/export.xml"],
            [
                "apple_health_export/export.xml",
                "apple_health_export/导出.xml",
            ],
            ["导出.xml", "apple_health_export/导出.xml"],
            ["export.xml", "../outside"],
        ] {
            let file = tempfile::NamedTempFile::new().unwrap();
            let mut zip = zip::ZipWriter::new(file.reopen().unwrap());
            for name in names {
                zip.start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(b"<HealthData/>").unwrap();
            }
            zip.finish().unwrap();
            assert!(parse_export(file.path(), |_| Ok(())).is_err());
        }
    }

    #[test]
    fn propagates_sink_failure() {
        let error = parse_xml(
            SAMPLE.as_bytes(),
            &mut |_| Err("disk full".into()),
            MAX_RECORD_BYTES,
        )
        .unwrap_err();
        assert_eq!(error, "disk full");
    }
}
