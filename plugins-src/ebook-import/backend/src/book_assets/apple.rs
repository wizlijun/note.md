//! Apple Books fallback through the public iTunes Search API.
//! https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html
use super::{
    allowed_url, author_names, author_query, author_words, check_cancelled, main_title, normalized,
    text, validate_cover, BookAssets, BookMetadata, COVER_LIMIT, JSON_LIMIT,
};
use reqwest::Url;
use serde_json::Value;
use std::sync::atomic::AtomicBool;

pub(super) fn artwork_host(host: &str) -> bool {
    regex::Regex::new(r"^is[0-9]+-ssl\.mzstatic\.com$")
        .expect("Apple artwork host")
        .is_match(host)
}

fn artwork_url(item: &Value) -> Option<Url> {
    let url = Url::parse(item["artworkUrl100"].as_str()?).ok()?;
    (allowed_url(&url) && url.host_str().is_some_and(artwork_host)).then_some(url)
}

fn artist_names(value: &str) -> Vec<&str> {
    value.split('&').flat_map(author_names).collect()
}

fn book_url(item: &Value) -> Option<Url> {
    let id = item["trackId"].as_u64()?;
    let url = Url::parse(item["trackViewUrl"].as_str()?).ok()?;
    let valid_path =
        regex::Regex::new(r"^/[a-z]{2}/book/(?:[^/]+/)?id[0-9]+$").expect("Apple book URL");
    (url.scheme() == "https"
        && url.host_str() == Some("books.apple.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && valid_path.is_match(url.path())
        && url.path().ends_with(&format!("/id{id}")))
    .then_some(url)
}

fn is_summary(title: &str) -> bool {
    let words = author_words(title);
    words.iter().any(|word| {
        matches!(
            word.as_str(),
            "summary" | "summaries" | "summarized" | "workbook"
        )
    }) || title.to_lowercase().contains("study guide")
        || title.contains("摘要")
        || title.contains("解读")
}

fn matched_metadata(response: &Value, title: &str, authors: &[&str]) -> Option<BookMetadata> {
    let results = response["results"].as_array()?;
    // At the requested limit we cannot know whether another exact match lies
    // beyond the returned page. A unique-looking truncated set is insufficient.
    if results.len() >= 20 || response["resultCount"].as_u64().is_some_and(|n| n >= 20) {
        return None;
    }
    let mut matches = results.iter().filter(|item| {
        item["kind"].as_str() == Some("ebook")
            && item["trackName"].as_str().is_some_and(|name| {
                !is_summary(name) && normalized(main_title(name)) == normalized(main_title(title))
                    // Keep explicit subtitle evidence when both records have it.
                    && (main_title(name) == name || main_title(title) == title || normalized(name) == normalized(title))
            })
            && item["artistName"].as_str().is_some_and(|names| {
                artist_names(names).iter().any(|name| {
                    authors
                        .iter()
                        .any(|author| author_words(name) == author_words(author))
                })
            })
            && book_url(item).is_some()
    });
    let item = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(BookMetadata {
        provider: "apple_books".into(),
        source_url: book_url(item)?.into(),
        fetched_at: chrono::Utc::now().to_rfc3339(),
        matched_by: "title_author".into(),
        isbn: Vec::new(),
        title: text(&item["trackName"])?,
        authors: artist_names(item["artistName"].as_str()?)
            .into_iter()
            .map(str::to_string)
            .collect(),
        publisher: None,
        // Store releaseDate belongs to its edition, not the locally matched work.
        published_date: None,
        cover_source_url: artwork_url(item).map(String::from),
    })
}

pub(super) fn fetch<F>(
    title: &str,
    author: Option<&str>,
    cancelled: &AtomicBool,
    get: &mut F,
) -> Result<Option<BookAssets>, String>
where
    F: FnMut(&Url, usize) -> Result<Option<Vec<u8>>, String>,
{
    check_cancelled(cancelled)?;
    let authors = author_names(author.unwrap_or_default());
    if normalized(main_title(title)).is_empty() || authors.is_empty() {
        return Ok(None);
    }
    let mut url = Url::parse("https://itunes.apple.com/search").expect("constant Apple URL");
    url.query_pairs_mut()
        .append_pair(
            "term",
            &format!("{} {}", main_title(title), author_query(authors[0])),
        )
        .append_pair("country", "US")
        .append_pair("media", "ebook")
        .append_pair("entity", "ebook")
        .append_pair("limit", "20");
    let Some(bytes) = get(&url, JSON_LIMIT)? else {
        return Ok(None);
    };
    check_cancelled(cancelled)?;
    if bytes.len() > JSON_LIMIT {
        return Err("Apple Books metadata exceeds size limit".into());
    }
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid Apple Books metadata: {error}"))?;
    let Some(mut metadata) = matched_metadata(&response, title, &authors) else {
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
                .map(|bytes| validate_cover(&bytes).map(|format| (format, bytes)))
                .transpose()
        }) {
            Ok(value) => cover = value,
            Err(error) => warnings.push(error),
        }
    }
    check_cancelled(cancelled)?;
    if cover.is_none() {
        metadata.cover_source_url = None;
        if warnings.is_empty() {
            warnings.push("Apple Books has no supported artwork for this match".into());
        }
    }
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

    fn record(title: &str, artist: &str, id: u64) -> Value {
        json!({"kind":"ebook", "trackId":id,"trackName":title,"artistName":artist,
            "trackViewUrl":format!("https://books.apple.com/us/book/example/id{id}?uo=4"),
            "artworkUrl100":"https://is1-ssl.mzstatic.com/image/thumb/Publication3/v4/a/b/cover.jpg/100x100bb.jpg", "releaseDate":"2013-03-05T08:00:00Z"})
    }

    #[test]
    fn unique_exact_title_and_full_author_matches_but_summaries_and_other_authors_do_not() {
        let exact = record("Making Hope Happen", "Shane J. Lopez", 543376890);
        for (records, expected) in [
            (vec![exact.clone()], true),
            (
                vec![
                    exact.clone(),
                    record("Making Hope Happen: Summary", "Shane J. Lopez", 2),
                ],
                true,
            ),
            (
                vec![
                    exact.clone(),
                    record("Making Hope Happen", "Shane J. Lopez", 3),
                ],
                false,
            ),
            (vec![record("Making Hope Happen", "Shane Lopez", 4)], false),
            (
                vec![record("Making Hope Happen: Summary", "Shane J. Lopez", 5)],
                false,
            ),
            (vec![record("让希望发生", "Shane J. Lopez", 6)], false),
        ] {
            let metadata = matched_metadata(
                &json!({"results":records}),
                "Making Hope Happen",
                &["Shane J. Lopez"],
            );
            assert_eq!(metadata.is_some(), expected);
            if let Some(metadata) = metadata {
                assert_eq!(metadata.provider, "apple_books");
                assert_eq!(metadata.matched_by, "title_author");
                assert!(metadata.isbn.is_empty());
            }
        }
    }

    #[test]
    fn coauthors_and_catalog_name_order_use_complete_name_words() {
        let item = record("The Earned Life", "Marshall Goldsmith & Mark Reiter", 1);
        let result = matched_metadata(
            &json!({"results":[item]}),
            "The Earned Life: Lose Regret",
            &["Goldsmith, Marshall"],
        )
        .unwrap();
        assert_eq!(result.authors, vec!["Marshall Goldsmith", "Mark Reiter"]);
        let different_subtitle = record("Focus: El poder de la atención", "Daniel Goleman", 2);
        assert!(matched_metadata(
            &json!({"results":[different_subtitle]}),
            "Focus: The Hidden Driver of Excellence",
            &["Daniel Goleman"]
        )
        .is_none());
    }

    #[test]
    fn artwork_is_used_verbatim_and_only_from_trusted_https_hosts() {
        let item = record("Book", "Author", 1);
        assert_eq!(
            artwork_url(&item).unwrap().as_str(),
            item["artworkUrl100"].as_str().unwrap()
        );
        for bad in [
            "http://is1-ssl.mzstatic.com/image/cover.jpg",
            "https://is1-ssl.mzstatic.com.evil.test/image/cover.jpg",
            "https://evil.test/cover.jpg",
        ] {
            let mut item = item.clone();
            item["artworkUrl100"] = json!(bad);
            assert!(artwork_url(&item).is_none());
        }
        let mut item = item;
        item["trackViewUrl"] = json!("https://evil.test/us/book/name/id1");
        assert!(book_url(&item).is_none());
    }

    #[test]
    fn missing_author_cancelled_or_ambiguous_books_do_not_fetch_images() {
        assert!(
            fetch("Book", None, &AtomicBool::new(false), &mut |_, _| panic!(
                "no author"
            ))
            .unwrap()
            .is_none()
        );
        assert!(fetch(
            "Book",
            Some("Author"),
            &AtomicBool::new(true),
            &mut |_, _| panic!("cancelled")
        )
        .is_err());
        let mut calls = 0;
        let result = fetch(
            "Book",
            Some("Author"),
            &AtomicBool::new(false),
            &mut |_, _| {
                calls += 1;
                Ok(Some(
                    serde_json::to_vec(
                        &json!({"results":[record("Book","Author",1),record("Book","Author",2)]}),
                    )
                    .unwrap(),
                ))
            },
        )
        .unwrap();
        assert!(result.is_none());
        assert_eq!(calls, 1);
    }
}
