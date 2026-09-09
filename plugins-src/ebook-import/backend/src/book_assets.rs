//! Low-volume, exact-match book enrichment; never writes book files.
//! API contracts: https://openlibrary.org/dev/docs/api/{books,search,covers}
mod apple;
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::io::{Cursor, Read};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

const JSON_LIMIT: usize = 1024 * 1024;
const COVER_LIMIT: usize = 8 * 1024 * 1024;
const EVIDENCE_LIMIT: usize = 64 * 1024;
static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_APPLE_SEARCH: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Serialize, Deserialize)]
pub struct BookMetadata {
    pub provider: String,
    pub source_url: String,
    pub fetched_at: String,
    /// `isbn` identifies an edition; `title_author` identifies only a work.
    /// Work matches have an empty ISBN list and the provider's book/work URL.
    pub matched_by: String,
    pub isbn: Vec<String>,
    pub title: String,
    pub authors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_source_url: Option<String>,
}

#[derive(Debug)]
pub struct BookAssets {
    pub metadata: BookMetadata,
    /// Extension comes from decoded bytes, not an untrusted URL or MIME label.
    pub cover: Option<(String, Vec<u8>)>,
    /// Metadata remains usable when the optional cover could not be fetched.
    pub warnings: Vec<String>,
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("book enrichment cancelled".into())
    } else {
        Ok(())
    }
}

fn allowed_url(url: &Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return false;
    }
    match url.host_str() {
        Some("openlibrary.org" | "covers.openlibrary.org") => true,
        Some("itunes.apple.com") => url.path() == "/search",
        Some(host) if apple::artwork_host(host) => url.path().starts_with("/image/"),
        // Covers are served from Internet Archive's documented cover bundles.
        // Follow only those image paths, not arbitrary archive downloads.
        Some("archive.org") => regex::Regex::new(
            r"^/download/(?:[sml]_covers_[0-9]+/[sml]_covers_[0-9]+_[0-9]+|olcovers[0-9]+/olcovers[0-9]+-[SML])\.zip/[0-9]+-[SML]\.jpg$",
        )
        .expect("cover archive path")
        .is_match(url.path()),
        Some(host)
            if regex::Regex::new(r"^ia[0-9]+\.(?:us|eu)\.archive\.org$")
                .expect("archive host")
                .is_match(host) =>
        {
            let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
            url.path() == "/view_archive.php"
                && query.len() == 2
                && query.get("archive").is_some_and(|value| {
                    regex::Regex::new(
                        r"^/[0-9]+/items/(?:[sml]_covers_[0-9]+/[sml]_covers_[0-9]+_[0-9]+|olcovers[0-9]+/olcovers[0-9]+-[SML])\.zip$",
                    )
                    .expect("cover archive")
                    .is_match(value)
                })
                && query.get("file").is_some_and(|value| {
                    regex::Regex::new(r"^[0-9]+-[SML]\.jpg$")
                        .expect("cover entry")
                        .is_match(value)
                })
        }
        _ => false,
    }
}

fn rate_limit(url: &Url, cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    let apple_search = url.host_str() == Some("itunes.apple.com");
    loop {
        check_cancelled(cancelled)?;
        if Instant::now() >= deadline {
            return Err("book enrichment timed out".into());
        }
        {
            let mut last = LAST_REQUEST
                .lock()
                .map_err(|_| "book request limiter unavailable")?;
            let mut last_apple = LAST_APPLE_SEARCH
                .lock()
                .map_err(|_| "book request limiter unavailable")?;
            if last.is_none_or(|time| time.elapsed() >= Duration::from_secs(1))
                && (!apple_search
                    || last_apple.is_none_or(|time| time.elapsed() >= Duration::from_millis(3200)))
            {
                *last = Some(Instant::now());
                if apple_search {
                    *last_apple = *last;
                }
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn download(
    client: &Client,
    url: &Url,
    limit: usize,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<Vec<u8>>, String> {
    let mut url = url.clone();
    for _ in 0..=3 {
        if !allowed_url(&url) {
            return Err(format!(
                "refusing non-HTTPS or untrusted book asset URL: {url}"
            ));
        }
        rate_limit(&url, cancelled, deadline)?;
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(15));
        if timeout.is_zero() {
            return Err("book enrichment timed out".into());
        }
        let mut response = client
            .get(url.clone())
            .timeout(timeout)
            .send()
            .map_err(|error| {
                let kind = if error.is_timeout() {
                    "timeout"
                } else if error.is_connect() {
                    "connection"
                } else {
                    "request"
                };
                format!(
                    "Book asset {kind} failed: {error}; {}",
                    error.source().map(ToString::to_string).unwrap_or_default()
                )
            })?;
        check_cancelled(cancelled)?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("book asset redirect has no location")?;
            url = url
                .join(location)
                .map_err(|_| "invalid book asset redirect")?;
            continue;
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("Book asset returned HTTP {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err("book asset exceeds download size limit".into());
        }
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            check_cancelled(cancelled)?;
            if Instant::now() >= deadline {
                return Err("book enrichment timed out".into());
            }
            let n = response
                .read(&mut chunk)
                .map_err(|error| format!("read book asset: {error}"))?;
            if n == 0 {
                break;
            }
            if bytes.len() + n > limit {
                return Err("book asset exceeds download size limit".into());
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        return Ok(Some(bytes));
    }
    Err("too many book asset redirects".into())
}

/// No ISBN and no author means no request: a title alone cannot identify a book.
/// Failures are optional enrichment failures; callers retain the imported book.
pub fn fetch_assets(
    title: &str,
    author: Option<&str>,
    evidence: &str,
    cancelled: &AtomicBool,
) -> Result<Option<BookAssets>, String> {
    check_cancelled(cancelled)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("note.md ebook-import/1.0")
        .build()
        .map_err(|error| format!("book metadata client: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    fetch_with(title, author, evidence, cancelled, |url, limit| {
        download(&client, url, limit, cancelled, deadline)
    })
}

fn isbn_valid(value: &str) -> bool {
    let digits: Vec<_> = value.bytes().collect();
    match digits.len() {
        13 if value.starts_with("978") || value.starts_with("979") => {
            digits.iter().all(u8::is_ascii_digit)
                && digits
                    .iter()
                    .enumerate()
                    .map(|(i, n)| (n - b'0') as u32 * if i % 2 == 0 { 1 } else { 3 })
                    .sum::<u32>()
                    % 10
                    == 0
        }
        10 => {
            digits[..9].iter().all(u8::is_ascii_digit)
                && (digits[9].is_ascii_digit() || digits[9] == b'X')
                && digits
                    .iter()
                    .enumerate()
                    .map(|(i, n)| if *n == b'X' { 10 } else { (n - b'0') as u32 } * (10 - i as u32))
                    .sum::<u32>()
                    % 11
                    == 0
        }
        _ => false,
    }
}

fn isbn_candidates(evidence: &str) -> Vec<String> {
    // Prefer labeled ISBNs, then bare 978/979 numbers. Only the beginning of
    // the supplied metadata/copyright evidence is inspected, never a full book.
    let evidence: String = evidence
        .chars()
        .take(EVIDENCE_LIMIT)
        .map(|character| match character {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}'
            | '\u{ff0d}' => '-',
            character => character,
        })
        .collect();
    let labeled = regex::Regex::new(
        r#"(?i)\bisbn(?:[ _-]?(?:10|13))?[\s"':：=]*([0-9][0-9Xx -]{8,24}[0-9Xx])"#,
    )
    .expect("ISBN pattern");
    let bare = regex::Regex::new(r"\b(?:978|979)[0-9-]{10,16}\b").expect("ISBN-13 pattern");
    let mut candidates = Vec::new();
    for raw in labeled
        .captures_iter(&evidence)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str()))
        .chain(bare.find_iter(&evidence).map(|value| value.as_str()))
    {
        let isbn: String = raw
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == 'x' || *c == 'X')
            .map(|c| c.to_ascii_uppercase())
            .collect();
        if isbn_valid(&isbn) && !candidates.contains(&isbn) {
            candidates.push(isbn);
        }
        if candidates.len() == 3 {
            break;
        }
    }
    candidates
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn main_title(value: &str) -> &str {
    value
        .split_once([':', '：'])
        .filter(|(title, subtitle)| !title.trim().is_empty() && !subtitle.trim().is_empty())
        .map(|(title, _)| title.trim())
        .unwrap_or(value)
}

fn author_words(value: &str) -> Vec<String> {
    let mut words: Vec<_> = value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect();
    words.sort();
    words
}

fn author_names(value: &str) -> Vec<&str> {
    value
        .split([';', '；'])
        .map(str::trim)
        .filter(|name| !author_words(name).is_empty())
        .take(30)
        .collect()
}

fn author_query(value: &str) -> String {
    match value.split_once(',') {
        Some((family, given)) if !family.trim().is_empty() && !given.trim().is_empty() => {
            format!("{} {}", given.trim(), family.trim())
        }
        _ => value.to_string(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.as_str()
                .or_else(|| item.get("name").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(30)
        .map(str::to_string)
        .collect()
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn cover_url(raw: Option<&str>) -> Option<Url> {
    let mut url = Url::parse(raw?).ok()?;
    if !allowed_url(&url)
        || url.host_str() != Some("covers.openlibrary.org")
        || !url.path().starts_with("/b/")
    {
        return None;
    }
    url.query_pairs_mut().append_pair("default", "false");
    Some(url)
}

fn metadata(item: &Value, isbn: Option<&str>) -> Option<BookMetadata> {
    let title = text(&item["title"])?;
    let (source_url, authors, publisher, published_date, cover) = if let Some(isbn) = isbn {
        (
            format!("https://openlibrary.org/isbn/{isbn}"),
            strings(&item["authors"]),
            strings(&item["publishers"]).first().cloned(),
            text(&item["publish_date"]),
            cover_url(
                item["cover"]["large"]
                    .as_str()
                    .or_else(|| item["cover"]["medium"].as_str()),
            )
            .or_else(|| {
                cover_url(Some(&format!(
                    "https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg"
                )))
            }),
        )
    } else {
        let key = item["key"].as_str()?;
        if !regex::Regex::new(r"^/works/OL[0-9]+W$")
            .expect("work key pattern")
            .is_match(key)
        {
            return None;
        }
        (
            format!("https://openlibrary.org{key}"),
            strings(&item["author_name"]),
            None,
            item["first_publish_year"]
                .as_u64()
                .map(|year| year.to_string()),
            item["cover_i"]
                .as_u64()
                .filter(|id| *id > 0)
                .and_then(|id| {
                    cover_url(Some(&format!(
                        "https://covers.openlibrary.org/b/id/{id}-L.jpg"
                    )))
                }),
        )
    };
    let mut identifiers: Vec<String> = ["isbn_13", "isbn_10"]
        .into_iter()
        .flat_map(|key| strings(&item["identifiers"][key]))
        .filter(|isbn| isbn_valid(isbn))
        .collect();
    if let Some(isbn) = isbn {
        if !identifiers.iter().any(|value| value == isbn) {
            identifiers.insert(0, isbn.into());
        }
    }
    Some(BookMetadata {
        provider: "openlibrary".into(),
        source_url,
        fetched_at: chrono::Utc::now().to_rfc3339(),
        matched_by: if isbn.is_some() {
            "isbn"
        } else {
            "title_author"
        }
        .into(),
        isbn: identifiers,
        title,
        authors,
        publisher,
        published_date,
        cover_source_url: cover.map(String::from),
    })
}

fn validate_cover(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > COVER_LIMIT {
        return Err("cover exceeds size limit".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "cover is not an image")?;
    let extension = match format {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        _ => return Err("cover must be JPEG or PNG".into()),
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|error| format!("invalid cover image: {error}"))?;
    if decoded.width() < 16 || decoded.height() < 16 {
        return Err("cover is an empty placeholder".into());
    }
    Ok(extension.into())
}

fn fetch_with<F>(
    title: &str,
    author: Option<&str>,
    evidence: &str,
    cancelled: &AtomicBool,
    mut get: F,
) -> Result<Option<BookAssets>, String>
where
    F: FnMut(&Url, usize) -> Result<Option<Vec<u8>>, String>,
{
    let (mut original, original_error) =
        match fetch_open_library(title, author, evidence, cancelled, &mut get) {
            Ok(assets) => (assets, None),
            Err(error) => {
                check_cancelled(cancelled)?;
                (None, Some(error))
            }
        };
    if original
        .as_ref()
        .is_some_and(|assets| assets.cover.is_some())
    {
        return Ok(original);
    }
    check_cancelled(cancelled)?;
    let catalog_authors = original
        .as_ref()
        .map(|assets| assets.metadata.authors.join(";"));
    let author = author
        .filter(|value| !author_names(value).is_empty())
        .or(catalog_authors.as_deref());
    let result = apple::fetch(title, author, cancelled, &mut get);
    check_cancelled(cancelled)?;
    match (original.as_mut(), result) {
        (Some(original), Ok(Some(apple))) if apple.cover.is_some() => {
            // An ebook storefront cover is supplementary artwork, never proof
            // that this ISBN is the store's edition. Retain the OL record.
            original.cover = apple.cover;
            original.metadata.cover_source_url = apple.metadata.cover_source_url;
            original.warnings = apple.warnings;
        }
        (Some(original), Err(error)) => original
            .warnings
            .push(format!("Apple Books fallback: {error}")),
        (Some(original), Ok(Some(apple))) => original.warnings.extend(
            apple
                .warnings
                .into_iter()
                .map(|warning| format!("Apple Books fallback: {warning}")),
        ),
        (None, Ok(Some(mut apple))) => {
            if let Some(error) = original_error.filter(|_| apple.cover.is_none()) {
                apple.warnings.push(format!(
                    "Open Library unavailable; Apple Books used instead: {error}"
                ));
            }
            return Ok(Some(apple));
        }
        (None, Ok(None)) => return original_error.map_or(Ok(None), Err),
        (None, Err(error)) => {
            return Err(match original_error {
                Some(original) => format!("{original}; Apple Books fallback failed: {error}"),
                None => error,
            })
        }
        _ => {}
    }
    Ok(original)
}

fn fetch_open_library<F>(
    title: &str,
    author: Option<&str>,
    evidence: &str,
    cancelled: &AtomicBool,
    mut get: F,
) -> Result<Option<BookAssets>, String>
where
    F: FnMut(&Url, usize) -> Result<Option<Vec<u8>>, String>,
{
    check_cancelled(cancelled)?;
    let candidates = isbn_candidates(evidence);
    let mut selected = None;
    if !candidates.is_empty() {
        let mut url = Url::parse("https://openlibrary.org/api/books").expect("constant URL");
        url.query_pairs_mut()
            .append_pair(
                "bibkeys",
                &candidates
                    .iter()
                    .map(|isbn| format!("ISBN:{isbn}"))
                    .collect::<Vec<_>>()
                    .join(","),
            )
            .append_pair("format", "json")
            .append_pair("jscmd", "data");
        if let Some(bytes) = get(&url, JSON_LIMIT)? {
            if bytes.len() > JSON_LIMIT {
                return Err("book metadata exceeds size limit".into());
            }
            let response: Value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid Open Library metadata: {error}"))?;
            for isbn in &candidates {
                if let Some(item) = response.get(format!("ISBN:{isbn}")) {
                    selected = metadata(item, Some(isbn));
                    if selected.is_some() {
                        break;
                    }
                }
            }
        }
    }
    check_cancelled(cancelled)?;
    // An unlisted ISBN can still identify a work by an exact title/author pair.
    // Once an edition matched, never replace it just to obtain another cover.
    let authors = author_names(author.unwrap_or_default());
    if selected.is_none() && !authors.is_empty() {
        if normalized(main_title(title)).is_empty() {
            return Ok(None);
        }
        let mut url = Url::parse("https://openlibrary.org/search.json").expect("constant URL");
        url.query_pairs_mut()
            .append_pair("title", main_title(title))
            .append_pair("author", &author_query(authors[0]))
            .append_pair("limit", "20")
            .append_pair("fields", "key,title,author_name,cover_i,first_publish_year");
        if let Some(bytes) = get(&url, JSON_LIMIT)? {
            if bytes.len() > JSON_LIMIT {
                return Err("book metadata exceeds size limit".into());
            }
            let response: Value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("invalid Open Library search: {error}"))?;
            if response["numFound"]
                .as_u64()
                .is_some_and(|count| count > 20)
            {
                return Ok(None); // Do not choose a supposedly unique result from a truncated set.
            }
            let matches: Vec<_> = response["docs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| {
                    item["title"].as_str().is_some_and(|value| {
                        normalized(main_title(value)) == normalized(main_title(title))
                    }) && strings(&item["author_name"]).iter().any(|value| {
                        authors
                            .iter()
                            .any(|author| author_words(value) == author_words(author))
                    })
                })
                .collect();
            if matches.len() == 1 {
                selected = metadata(matches[0], None);
            }
        }
    }
    check_cancelled(cancelled)?;
    let Some(mut metadata) = selected else {
        return Ok(None);
    };
    let mut cover = None;
    let mut warnings = Vec::new();
    if let Some(url) = metadata
        .cover_source_url
        .as_deref()
        .and_then(|url| Url::parse(url).ok())
    {
        match get(&url, COVER_LIMIT).and_then(|bytes| {
            bytes
                .map(|bytes| validate_cover(&bytes).map(|extension| (extension, bytes)))
                .transpose()
        }) {
            Ok(result) => cover = result,
            Err(error) => warnings.push(error),
        }
        if cover.is_none() {
            if warnings.is_empty() {
                warnings.push("Open Library has no cover for the matched book edition".into());
            }
            metadata.cover_source_url = None;
        }
    } else {
        warnings.push("Open Library has no cover for the matched book".into());
    }
    check_cancelled(cancelled)?;
    Ok(Some(BookAssets {
        metadata,
        cover,
        warnings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RANGE_ISBN: &str = "9780735214491";

    fn range_record() -> Value {
        json!({"ISBN:9780735214491": {
            "title": "Range", "authors": [{"name": "David Epstein"}],
            "publishers": [{"name": "Riverhead Books"}], "publish_date": "2019",
            "identifiers": {"isbn_13": [RANGE_ISBN]},
            "cover": {"large": "https://covers.openlibrary.org/b/id/123-L.jpg"}
        }})
    }

    fn apple_range_record() -> Value {
        json!({"resultCount":1,"results":[{"kind":"ebook","trackId":123,
            "trackName":"Range","artistName":"David Epstein","releaseDate":"2020-06-01T00:00:00Z",
            "trackViewUrl":"https://books.apple.com/us/book/range/id123?uo=4",
            "artworkUrl100":"https://is1-ssl.mzstatic.com/image/thumb/Publication/cover.jpg/100x100bb.jpg"}]})
    }

    #[test]
    fn apple_fills_unlisted_books_as_work_metadata_without_guessing_isbn_or_publication_date() {
        let mut calls = Vec::new();
        let result = fetch_with(
            "Range",
            Some("David Epstein"),
            "",
            &AtomicBool::new(false),
            |url, _| {
                calls.push(url.to_string());
                match url.host_str().unwrap() {
                    "openlibrary.org" => Ok(Some(b"{\"docs\":[]}".to_vec())),
                    "itunes.apple.com" => {
                        Ok(Some(serde_json::to_vec(&apple_range_record()).unwrap()))
                    }
                    "is1-ssl.mzstatic.com" => Ok(Some(png(24, 32))),
                    _ => panic!("unexpected request: {url}"),
                }
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(result.metadata.provider, "apple_books");
        assert_eq!(result.metadata.matched_by, "title_author");
        assert!(result.metadata.isbn.is_empty());
        assert!(result.metadata.published_date.is_none());
        assert!(result.metadata.publisher.is_none());
        assert_eq!(
            result.metadata.cover_source_url.as_deref(),
            Some(calls.last().unwrap().as_str())
        );
        assert_eq!(result.cover.unwrap().0, "png");
    }

    #[test]
    fn apple_supplements_missing_covers_without_replacing_matched_open_library_editions() {
        for (ol_has_cover, author) in [
            (false, Some("David Epstein")),
            (true, Some("David Epstein")),
            (false, None),
        ] {
            let mut apple_calls = 0;
            let result = fetch_with(
                "Range",
                author,
                RANGE_ISBN,
                &AtomicBool::new(false),
                |url, _| match url.host_str().unwrap() {
                    "openlibrary.org" => Ok(Some(serde_json::to_vec(&range_record()).unwrap())),
                    "covers.openlibrary.org" => Ok(ol_has_cover.then(|| png(24, 32))),
                    "itunes.apple.com" => {
                        apple_calls += 1;
                        Ok(Some(serde_json::to_vec(&apple_range_record()).unwrap()))
                    }
                    "is1-ssl.mzstatic.com" => {
                        apple_calls += 1;
                        Ok(Some(png(24, 32)))
                    }
                    _ => panic!("unexpected request: {url}"),
                },
            )
            .unwrap()
            .unwrap();
            assert_eq!(apple_calls, if ol_has_cover { 0 } else { 2 });
            assert_eq!(result.metadata.provider, "openlibrary");
            assert_eq!(result.metadata.matched_by, "isbn");
            assert_eq!(result.metadata.isbn, vec![RANGE_ISBN]);
            assert_eq!(
                result.metadata.source_url,
                format!("https://openlibrary.org/isbn/{RANGE_ISBN}")
            );
            assert_eq!(result.metadata.published_date.as_deref(), Some("2019"));
            assert_eq!(
                result.metadata.publisher.as_deref(),
                Some("Riverhead Books")
            );
            assert!(result.cover.is_some());
            if !ol_has_cover {
                assert!(result
                    .metadata
                    .cover_source_url
                    .unwrap()
                    .contains("mzstatic.com"));
            }
        }
    }

    #[test]
    fn failed_apple_artwork_keeps_open_library_metadata_and_the_retryable_error() {
        let result = fetch_with(
            "Range",
            Some("David Epstein"),
            RANGE_ISBN,
            &AtomicBool::new(false),
            |url, _| match url.host_str().unwrap() {
                "openlibrary.org" => Ok(Some(serde_json::to_vec(&range_record()).unwrap())),
                "covers.openlibrary.org" => Ok(None),
                "itunes.apple.com" => Ok(Some(serde_json::to_vec(&apple_range_record()).unwrap())),
                "is1-ssl.mzstatic.com" => Err("connection timeout".into()),
                _ => panic!("unexpected request: {url}"),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.metadata.provider, "openlibrary");
        assert!(result.cover.is_none());
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("Apple Books") && warning.contains("timeout")));
    }

    #[test]
    fn open_library_connection_failure_can_fall_back_to_apple_without_claiming_an_isbn_match() {
        let result = fetch_with(
            "Range",
            Some("David Epstein"),
            RANGE_ISBN,
            &AtomicBool::new(false),
            |url, _| match url.host_str().unwrap() {
                "openlibrary.org" => Err("Open Library connection failed".into()),
                "itunes.apple.com" => Ok(Some(serde_json::to_vec(&apple_range_record()).unwrap())),
                "is1-ssl.mzstatic.com" => Ok(Some(png(24, 32))),
                _ => panic!("unexpected request: {url}"),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.metadata.provider, "apple_books");
        assert_eq!(result.metadata.matched_by, "title_author");
        assert!(result.metadata.isbn.is_empty());
        assert!(result.cover.is_some());
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn unavailable_open_library_keeps_its_error_when_apple_does_not_match_or_also_fails() {
        for apple_fails in [false, true] {
            let error = fetch_with(
                "Range",
                Some("David Epstein"),
                RANGE_ISBN,
                &AtomicBool::new(false),
                |url, _| match url.host_str().unwrap() {
                    "openlibrary.org" => Err("Open Library connection failed".into()),
                    "itunes.apple.com" if apple_fails => Err("Apple timeout".into()),
                    "itunes.apple.com" => Ok(Some(b"{\"results\":[]}".to_vec())),
                    _ => panic!("unexpected request: {url}"),
                },
            )
            .unwrap_err();
            if apple_fails {
                assert!(
                    error.contains("Open Library connection failed")
                        && error.contains("Apple timeout")
                );
            } else {
                assert_eq!(error, "Open Library connection failed");
            }
        }
        let cancelled = AtomicBool::new(false);
        let mut calls = 0;
        let error = fetch_with(
            "Range",
            Some("David Epstein"),
            RANGE_ISBN,
            &cancelled,
            |_, _| {
                calls += 1;
                cancelled.store(true, Ordering::Relaxed);
                Err("Open Library connection failed".into())
            },
        )
        .unwrap_err();
        assert!(error.contains("cancelled"));
        assert_eq!(
            calls, 1,
            "cancellation must not trigger another provider request"
        );
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, height)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn extracts_only_checksum_valid_bounded_isbns() {
        assert_eq!(
            isbn_candidates(
                "isbn_13: '978-0-7352-1449-1'\nISBN-10: 0735214492\nISBN: 9780735214490"
            ),
            vec!["9780735214491", "0735214492"]
        );
        assert!(isbn_valid("080442957X"));
        assert!(!isbn_valid("0804429570"));
        assert!(!isbn_valid("1234567890128"));
        assert_eq!(isbn_candidates("urn:isbn:9780735214491"), vec![RANGE_ISBN]);
        assert!(
            isbn_candidates(&format!("{}ISBN: {RANGE_ISBN}", "a".repeat(EVIDENCE_LIMIT)))
                .is_empty()
        );
    }

    #[test]
    fn copyright_isbns_accept_unicode_hyphens_with_the_same_checksum_rules() {
        for hyphen in ['‐', '‑', '‒', '–', '—', '−', '－'] {
            let evidence = format!("ISBN: 978{hyphen}0{hyphen}19{hyphen}968273{hyphen}7\nISBN: 978{hyphen}0{hyphen}19{hyphen}968673{hyphen}5");
            assert_eq!(
                isbn_candidates(&evidence),
                vec!["9780199682737", "9780199686735"]
            );
            assert!(isbn_candidates(&format!(
                "ISBN: 978{hyphen}0{hyphen}19{hyphen}968273{hyphen}0"
            ))
            .is_empty());
        }
        assert_eq!(
            isbn_candidates("ISBN 978–0–19–881134–3\nISBN 978–0–19–253934–2"),
            vec!["9780198811343", "9780192539342"]
        );
    }

    #[test]
    fn title_alone_and_cancelled_requests_never_call_transport() {
        assert!(
            fetch_open_library("Range", None, "", &AtomicBool::new(false), |_, _| panic!(
                "title-only lookup"
            ))
            .unwrap()
            .is_none()
        );
        assert!(fetch_open_library(
            "Range",
            Some("David Epstein"),
            "",
            &AtomicBool::new(true),
            |_, _| panic!("cancelled lookup")
        )
        .is_err());
    }

    #[test]
    fn isbn_fetches_metadata_and_sniffs_actual_cover_bytes() {
        let mut calls = 0;
        let cover_bytes = png(24, 32);
        let assets = fetch_open_library(
            "Range",
            Some("David Epstein"),
            &format!("ISBN: {RANGE_ISBN}"),
            &AtomicBool::new(false),
            |url, limit| {
                calls += 1;
                match calls {
                    1 => {
                        assert!(url.query_pairs().any(|(key, value)| key == "bibkeys"
                            && value == format!("ISBN:{RANGE_ISBN}")));
                        assert_eq!(limit, JSON_LIMIT);
                        Ok(Some(serde_json::to_vec(&range_record()).unwrap()))
                    }
                    2 => {
                        assert_eq!(url.host_str(), Some("covers.openlibrary.org"));
                        assert!(url
                            .query_pairs()
                            .any(|(key, value)| key == "default" && value == "false"));
                        assert_eq!(limit, COVER_LIMIT);
                        Ok(Some(cover_bytes.clone()))
                    }
                    _ => panic!("unexpected request"),
                }
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(assets.metadata.title, "Range");
        assert_eq!(assets.metadata.authors, vec!["David Epstein"]);
        assert_eq!(
            assets.metadata.publisher.as_deref(),
            Some("Riverhead Books")
        );
        assert_eq!(assets.metadata.isbn, vec![RANGE_ISBN]);
        assert_eq!(assets.metadata.matched_by, "isbn");
        assert_eq!(assets.cover, Some(("png".into(), cover_bytes)));
    }

    #[test]
    fn absent_isbn_response_does_not_guess_by_title() {
        let mut count = 0;
        assert!(fetch_open_library(
            "Range",
            None,
            RANGE_ISBN,
            &AtomicBool::new(false),
            |_, _| {
                count += 1;
                Ok(Some(b"{}".to_vec()))
            }
        )
        .unwrap()
        .is_none());
        assert_eq!(count, 1);
    }

    #[test]
    fn unlisted_isbn_falls_back_to_exact_unique_title_and_author_without_inventing_edition() {
        let mut count = 0;
        let result = fetch_open_library("Range", Some("David Epstein"), RANGE_ISBN, &AtomicBool::new(false), |url, _| {
            count += 1;
            if count == 1 {
                assert_eq!(url.path(), "/api/books");
                Ok(Some(b"{}".to_vec()))
            } else {
                assert_eq!(url.path(), "/search.json");
                Ok(Some(serde_json::to_vec(&json!({"docs": [{"key": "/works/OL123W", "title": "Range", "author_name": ["David Epstein"]}]})).unwrap()))
            }
        }).unwrap().unwrap();
        assert_eq!(count, 2);
        assert_eq!(result.metadata.matched_by, "title_author");
        assert_eq!(
            result.metadata.source_url,
            "https://openlibrary.org/works/OL123W"
        );
        assert!(result.metadata.isbn.is_empty());
    }

    #[test]
    fn search_requires_one_exact_title_and_author_match() {
        let good = json!({"key":"/works/OL123W", "title":"The Range!", "author_name":["David Epstein"], "first_publish_year":2019});
        for (docs, expected) in [
            (vec![good.clone()], true),
            (vec![good.clone(), good.clone()], false),
            (
                vec![
                    json!({"key":"/works/OL123W", "title":"The Range", "author_name":["Someone Else"]}),
                ],
                false,
            ),
            (
                vec![
                    json!({"key":"/works/OL123W", "title":"Range", "author_name":["David Epstein"]}),
                ],
                false,
            ),
        ] {
            let result = fetch_open_library(
                "the range",
                Some("david epstein"),
                "",
                &AtomicBool::new(false),
                |url, _| {
                    assert_eq!(url.path(), "/search.json");
                    Ok(Some(serde_json::to_vec(&json!({"docs": docs})).unwrap()))
                },
            )
            .unwrap();
            assert_eq!(result.is_some(), expected);
            if let Some(result) = result {
                assert!(
                    result.metadata.isbn.is_empty(),
                    "work-level search must not invent an edition ISBN"
                );
                assert_eq!(
                    result.metadata.source_url,
                    "https://openlibrary.org/works/OL123W"
                );
                assert_eq!(result.metadata.published_date.as_deref(), Some("2019"));
            }
        }
    }

    #[test]
    fn search_accepts_explicit_subtitles_but_keeps_author_and_uniqueness_requirements() {
        for (input, titles, author, expected) in [
            (
                "Range: Why Generalists Triumph",
                vec!["Range"],
                "David Epstein",
                true,
            ),
            (
                "Range",
                vec!["Range：Why Generalists Triumph"],
                "David Epstein",
                true,
            ),
            (
                "Range：Why Generalists Triumph",
                vec!["Range: Why Generalists Triumph"],
                "David Epstein",
                true,
            ),
            (
                "Range: Why Generalists Triumph",
                vec!["Rangefinder"],
                "David Epstein",
                false,
            ),
            (
                "Range: Why Generalists Triumph",
                vec!["Range"],
                "Someone Else",
                false,
            ),
            (
                "Range: Why Generalists Triumph",
                vec!["Range: First", "Range: Second"],
                "David Epstein",
                false,
            ),
        ] {
            let docs: Vec<_> = titles.into_iter().enumerate().map(|(i,title)| json!({
                "key": format!("/works/OL{}W", 123 + i), "title": title, "author_name": [author]
            })).collect();
            let result = fetch_open_library(
                input,
                Some("David Epstein"),
                "",
                &AtomicBool::new(false),
                |url, _| {
                    assert!(url
                        .query_pairs()
                        .any(|(key, value)| key == "title" && value == "Range"));
                    Ok(Some(serde_json::to_vec(&json!({"docs": docs})).unwrap()))
                },
            )
            .unwrap();
            assert_eq!(result.is_some(), expected, "{input} / {author}");
            if let Some(result) = result {
                assert_eq!(result.metadata.matched_by, "title_author");
                assert!(result.metadata.isbn.is_empty());
            }
        }
    }

    #[test]
    fn author_matching_supports_catalog_name_order_and_semicolon_lists_without_dropping_words() {
        for (input, expected_query, service_authors, expected) in [
            (
                "Bound Alberti, Fay;",
                "Fay Bound Alberti",
                vec!["Fay Bound Alberti"],
                true,
            ),
            (
                "Peter H. Diamandis;Steven Kotler;",
                "Peter H. Diamandis",
                vec!["Peter H. Diamandis", "Steven Kotler"],
                true,
            ),
            (
                "Peter H. Diamandis;Steven Kotler;",
                "Peter H. Diamandis",
                vec!["Steven Kotler"],
                true,
            ),
            (
                "Bound Alberti, Fay;",
                "Fay Bound Alberti",
                vec!["Alberti"],
                false,
            ),
            (
                "Peter H. Diamandis;",
                "Peter H. Diamandis",
                vec!["Peter Diamandis"],
                false,
            ),
            (
                "Steven Kotler;",
                "Steven Kotler",
                vec!["Stephen Kotler"],
                false,
            ),
        ] {
            let result = fetch_open_library("Example", Some(input), "", &AtomicBool::new(false), |url, _| {
                assert!(url.query_pairs().any(|(key, value)| key == "author" && value == expected_query));
                Ok(Some(serde_json::to_vec(&json!({"docs": [{"key": "/works/OL123W", "title": "Example", "author_name": service_authors}]})).unwrap()))
            }).unwrap();
            assert_eq!(result.is_some(), expected, "{input}");
        }
        assert!(fetch_open_library(
            "Example",
            Some(" ;； ; "),
            "",
            &AtomicBool::new(false),
            |_, _| panic!("empty author lookup")
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn cover_failure_preserves_metadata_and_reports_warning() {
        let mut count = 0;
        let result = fetch_open_library(
            "Range",
            Some("David Epstein"),
            RANGE_ISBN,
            &AtomicBool::new(false),
            |_, _| {
                count += 1;
                if count == 1 {
                    Ok(Some(serde_json::to_vec(&range_record()).unwrap()))
                } else {
                    Ok(Some(png(1, 1)))
                }
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            count, 2,
            "a known edition must not fall back to a different work for its cover"
        );
        assert!(result.cover.is_none());
        assert!(result.metadata.cover_source_url.is_none());
        assert_eq!(result.metadata.title, "Range");
        assert!(result.warnings[0].contains("placeholder"));
        assert!(validate_cover(b"<html>HTTP error</html>").is_err());
        assert!(validate_cover(&vec![0; COVER_LIMIT + 1]).is_err());
    }

    #[test]
    fn sparse_isbn_record_uses_the_same_isbn_cover_endpoint() {
        let mut record = range_record();
        record[format!("ISBN:{RANGE_ISBN}")]
            .as_object_mut()
            .unwrap()
            .remove("cover");
        let mut jpeg = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(24, 32)
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .unwrap();
        let mut count = 0;
        let result = fetch_open_library(
            "Range",
            None,
            RANGE_ISBN,
            &AtomicBool::new(false),
            |url, _| {
                count += 1;
                if count == 1 {
                    Ok(Some(serde_json::to_vec(&record).unwrap()))
                } else {
                    assert_eq!(
                        url.as_str(),
                        "https://covers.openlibrary.org/b/isbn/9780735214491-L.jpg?default=false"
                    );
                    Ok(Some(jpeg.get_ref().clone()))
                }
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.cover.unwrap().0, "jpg");
    }

    #[test]
    fn only_https_allowlisted_hosts_are_used_for_requests_and_redirects() {
        for raw in [
            "http://openlibrary.org/api/books",
            "https://openlibrary.org.evil.test/x",
            "https://localhost/x",
            "https://127.0.0.1/x",
            "https://openlibrary.org:444/x",
            "https://x:password@openlibrary.org/x",
        ] {
            assert!(!allowed_url(&Url::parse(raw).unwrap()), "{raw}");
        }
        assert!(allowed_url(
            &Url::parse("https://covers.openlibrary.org/b/id/1-L.jpg").unwrap()
        ));
        for raw in [
            "https://archive.org/download/l_covers_0008/l_covers_0008_78.zip/0008782615-L.jpg",
            "https://ia902809.us.archive.org/view_archive.php?archive=/18/items/l_covers_0008/l_covers_0008_78.zip&file=0008782615-L.jpg",
        ] { assert!(allowed_url(&Url::parse(raw).unwrap()), "{raw}"); }
        for raw in [
            "https://archive.org/download/unrelated/file.zip",
            "https://ia902809.us.archive.org.evil.test/view_archive.php",
            "https://ia902809.us.archive.org/view_archive.php?archive=/18/items/unrelated/data.zip&file=secret.txt",
        ] { assert!(!allowed_url(&Url::parse(raw).unwrap()), "{raw}"); }
        let mut record = range_record();
        record[format!("ISBN:{RANGE_ISBN}")]["cover"]["large"] =
            json!("https://evil.test/cover.jpg");
        let mut count = 0;
        let result = fetch_open_library(
            "Range",
            None,
            RANGE_ISBN,
            &AtomicBool::new(false),
            |url, _| {
                count += 1;
                if count == 1 {
                    Ok(Some(serde_json::to_vec(&record).unwrap()))
                } else {
                    assert_eq!(
                        url.as_str(),
                        "https://covers.openlibrary.org/b/isbn/9780735214491-L.jpg?default=false"
                    );
                    Ok(None)
                }
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(count, 2);
        assert!(result.cover.is_none());
        assert!(result.warnings[0].contains("no cover"));
    }

    #[test]
    fn invalid_or_oversized_metadata_fails_without_cover_request() {
        for body in [b"not json".to_vec(), vec![b' '; JSON_LIMIT + 1]] {
            let mut count = 0;
            assert!(fetch_open_library(
                "Range",
                None,
                RANGE_ISBN,
                &AtomicBool::new(false),
                |_, _| {
                    count += 1;
                    Ok(Some(body.clone()))
                }
            )
            .is_err());
            assert_eq!(count, 1);
        }
    }

    #[test]
    fn legacy_open_library_cover_archives_are_allowed_without_allowing_other_downloads() {
        // Actual Invisible on Everest (ISBN 0970414358) redirect chain.
        for raw in [
            "https://covers.openlibrary.org/b/id/1706237-L.jpg?default=false",
            "https://archive.org/download/olcovers170/olcovers170-L.zip/1706237-L.jpg",
            "https://ia801504.us.archive.org/view_archive.php?archive=/8/items/olcovers170/olcovers170-L.zip&file=1706237-L.jpg",
        ] { assert!(allowed_url(&Url::parse(raw).unwrap()), "{raw}"); }
        for raw in [
            "https://archive.org/download/olcovers170/unrelated.zip/1706237-L.jpg",
            "https://archive.org/download/unrelated/olcovers170-L.zip/1706237-L.jpg",
            "https://ia801504.us.archive.org/view_archive.php?archive=/8/items/olcovers170/private.zip&file=1706237-L.jpg",
            "https://ia801504.us.archive.org/view_archive.php?archive=/8/items/olcovers170/olcovers170-L.zip&file=secret.txt",
        ] { assert!(!allowed_url(&Url::parse(raw).unwrap()), "{raw}"); }
    }

    /// Explicit smoke test only. Run with an empty temporary output directory:
    /// NOTEMD_BOOK_ASSETS_LIVE_OUTPUT=/tmp/book-assets-... cargo test live_range -- --ignored --nocapture
    #[test]
    #[ignore = "requires explicit live output directory and Open Library network access"]
    fn live_range() {
        let output = std::env::var_os("NOTEMD_BOOK_ASSETS_LIVE_OUTPUT")
            .expect("set NOTEMD_BOOK_ASSETS_LIVE_OUTPUT to a temporary directory");
        let output = std::path::PathBuf::from(output);
        std::fs::create_dir_all(&output).unwrap();
        // The hardcover edition has a catalogued cover; the ebook ISBN
        // 9780735214491 currently has only a sparse metadata record.
        let result = fetch_assets(
            "Range",
            Some("David Epstein"),
            "9780735214484",
            &AtomicBool::new(false),
        )
        .unwrap()
        .expect("Range edition should exist");
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output.join("metadata.json"))
            .unwrap();
        file.write_all(&serde_json::to_vec_pretty(&result.metadata).unwrap())
            .unwrap();
        let (extension, bytes) = result
            .cover
            .unwrap_or_else(|| panic!("Range should have a real cover: {:?}", result.warnings));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output.join(format!("cover.{extension}")))
            .unwrap();
        file.write_all(&bytes).unwrap();
        println!(
            "Open Library live lookup: {} ; {} cover bytes ; output {}",
            result.metadata.source_url,
            bytes.len(),
            output.display()
        );
    }
}
