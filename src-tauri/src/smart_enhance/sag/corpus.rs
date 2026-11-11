// Ported from SAG-Wiki 61f63c6 `core/src/sag2_v10.rs` (folded, words, Corpus::from_vocabulary,
// Corpus::repair, Corpus::resolve_terms, Corpus::diversify) and `core/src/store.rs`
// (retrieval_statistics), MIT License,
// Copyright (c) 2026 sag contributors. Changes for note.md: see spec Appendix H.

//! SAG2 corpus steps: the alias table and lexical repair (spec H.3.1, H.3.2,
//! H.3.5) and the DPP diversification of the final ranking (spec H.3.9).

use std::collections::{BTreeSet, HashMap, HashSet};

use fancy_regex::Regex;
use indexmap::IndexMap;
use unicode_normalization::char::canonical_combining_class;
use unicode_normalization::UnicodeNormalization;

use super::text::{alias_pattern, fts_phrase, quote, sag_tokens};
use super::{SagCandidate, Term, TermKind};

/// `sag2_v10.rs:folded`, verbatim: NFKD, drop the combining marks that follow a
/// Latin letter, then NFKC. "René" becomes "Rene"; marks on non-Latin bases
/// (Hebrew points, the kana voicing mark) are kept and recompose.
pub(crate) fn folded(text: &str) -> String {
    let mut latin = false;
    let mut result = String::new();
    for c in text.nfkd() {
        if canonical_combining_class(c) != 0 {
            if !latin {
                result.push(c);
            }
        } else {
            result.push(c);
            // NFKD decomposes accented Latin letters to their Latin base.
            latin = c.is_ascii_alphabetic()
                || matches!(c as u32, 0x00c0..=0x024f | 0x1e00..=0x1eff | 0xab30..=0xab6f);
        }
    }
    result.nfkc().collect()
}

/// `sag2_v10.rs:words` with `str::to_lowercase` in place of Unicode casefold
/// (spec H.5 casefold row; the crate has no casefold dependency): the
/// `[\p{L}\p{N}]+` runs of the lowercased text, so combining marks split words.
/// The reference vectoriser of the DPP fixture; production vectorises with
/// `searchidx::tokenize::tokens` (spec H.3.9), so it is built for tests only.
#[cfg(test)]
pub(crate) fn words(text: &str) -> Vec<String> {
    static WORDS: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{L}\p{N}]+").unwrap());
    let lowered = text.to_lowercase();
    WORDS
        .find_iter(&lowered)
        .map(|matched| matched.as_str().to_owned())
        .collect()
}

/// The document-level idf of `sag2_v10.rs:Corpus::from_vocabulary`, verbatim:
/// `ln((1 + n) / (1 + df)) + 1`, `n` documents, `df` of them containing the
/// word. Only `diversify` uses it. Spec H.3.9: `n` is the file-level block
/// count and `df` the file-level blocks containing the token.
pub(crate) fn diversity_idf(documents: u64, df: u64) -> f64 {
    ((1. + documents as f64) / (1. + df as f64)).ln() + 1.
}

/// An alias source's name: NFKC, then lowercase (`sag2_v10.rs:Corpus::from_vocabulary`,
/// `title.nfkc().case_fold()`, with `to_lowercase` for the casefold, spec H.5).
fn source_name(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}

/// The alias table and title set of `sag2_v10.rs:Corpus` (the `aliases`,
/// `names` and `titles` fields), built from note.md's three alias sources
/// (spec H.3.1).
///
/// [`AliasMap::build`] compiles the alias pattern, which costs about 1.9 s for
/// 6,000 keys (release build). Build one map per index generation and cache it,
/// as `store.rs:retrieval_statistics` caches its `Corpus` per index version;
/// never build one per lookup.
#[derive(Clone, Debug)]
pub(crate) struct AliasMap {
    /// Folded key → the one value it names.
    aliases: HashMap<String, String>,
    /// [`alias_pattern`] over the keys of `aliases`; `None` when there are none.
    pattern: Option<Regex>,
    /// Lowercased file titles of at least two tokens: `sag_tokens` joined by
    /// spaces (SAG2's `titles`) → the [`fts_phrase`] of every title with those
    /// tokens. Several titles can share the tokens and differ in stop words.
    titles: HashMap<String, BTreeSet<String>>,
}

impl AliasMap {
    /// `sag2_v10.rs:Corpus::from_vocabulary`'s alias and title rules over the
    /// sources of spec H.3.1:
    ///
    /// - each file title `t`: `folded(source_name(t)) → source_name(t)`;
    /// - each frontmatter alias `a` of the file titled `t`: `folded(source_name(a)) → source_name(t)`;
    /// - each wiki-link target `w` (already without `#…`, from `SagReader`):
    ///   `folded(source_name(w)) → source_name(w)`.
    ///
    /// `source_name` is SAG2's `title.nfkc().case_fold()` (`from_vocabulary`) with
    /// `str::to_lowercase` for the casefold, as the index lowercases (spec
    /// H.3.1, H.5 casefold row). A key that names more than one distinct value
    /// is dropped, and a key equal to its only value is not an alias (SAG2's
    /// "only one value" rule). `titles` holds the file titles only.
    pub(crate) fn build(titles: &[String], aliases: &[(String, String)], wiki_targets: &[String]) -> Self {
        let mut names: HashMap<String, HashSet<String>> = HashMap::new();
        let mut title_terms: HashMap<String, BTreeSet<String>> = HashMap::new();
        for title in titles {
            let name = source_name(title);
            let terms = sag_tokens(&name);
            if terms.len() >= 2 {
                title_terms.entry(terms.join(" ")).or_default().insert(fts_phrase(&name));
            }
            names.entry(folded(&name)).or_default().insert(name);
        }
        for (alias, title) in aliases {
            names.entry(folded(&source_name(alias))).or_default().insert(source_name(title));
        }
        for target in wiki_targets {
            let name = source_name(target);
            names.entry(folded(&name)).or_default().insert(name);
        }
        let aliases: HashMap<String, String> = names
            .into_iter()
            .filter_map(|(alias, values)| {
                if values.len() == 1 && !values.contains(&alias) {
                    Some((alias, values.into_iter().next().unwrap()))
                } else {
                    None
                }
            })
            .collect();
        // `alias_pattern` sorts the keys (char count desc, then bytes), so the
        // map's iteration order does not reach the pattern.
        let keys: Vec<String> = aliases.keys().cloned().collect();
        let pattern = alias_pattern(&keys);
        Self { aliases, pattern, titles: title_terms }
    }

    /// The alias pattern, for `text::name_spans`.
    pub(crate) fn pattern(&self) -> Option<&Regex> {
        self.pattern.as_ref()
    }

    /// `sag2_v10.rs:Corpus::repair`: each alias match `source` is replaced by its
    /// value `target` when `source` has no hits and `target` has. `has_hits`
    /// gets the FTS expression `quote(fts_phrase(x))` (SAG2 quotes in the
    /// callback; ours takes the expression, P4): inner stop words kept, because
    /// our index keeps them (spec H.3.2, H.5 FTS 短语 row). Without a pattern the
    /// text comes back unchanged.
    ///
    /// SAG2 indexes `aliases[casefold(source)]`; this looks up
    /// `lower(source)` and keeps `source` when it is not a key, which can happen
    /// where the regex's case-insensitive match and `to_lowercase` disagree (P4).
    pub(crate) fn repair(
        &self,
        text: &str,
        has_hits: &mut dyn FnMut(&str) -> Result<bool, String>,
    ) -> Result<String, String> {
        let Some(pattern) = &self.pattern else {
            return Ok(text.to_owned());
        };
        let mut result = String::new();
        let mut end = 0;
        for matched in pattern.find_iter(text) {
            // Only runtime errors (the backtrack limit) occur here; their
            // messages are fixed strings and quote no text.
            let matched = matched.map_err(|e| format!("SAG2 alias repair failed: {e}"))?;
            result.push_str(&text[end..matched.start()]);
            let source = matched.as_str();
            match self.aliases.get(&source.to_lowercase()) {
                Some(target)
                    if !has_hits(&quote(&fts_phrase(source)))?
                        && has_hits(&quote(&fts_phrase(target)))? =>
                {
                    result.push_str(target)
                }
                _ => result.push_str(source),
            }
            end = matched.end();
        }
        result.push_str(&text[end..]);
        Ok(result)
    }

    /// `sag2_v10.rs:Corpus::resolve_terms`: a term without hits is repaired
    /// (and re-tokenised when the repair changed it); a name phrase still
    /// without hits falls back to its longest title sub-phrase of at least two
    /// tokens (ties: bytewise smallest) when that one has hits. `has_hits` gets
    /// `quote(term.phrase)`; a rewrite sets `term` to the `sag_tokens` of the new
    /// text and `phrase` to its [`fts_phrase`]. Repair runs on `term`, which has
    /// no stop words (as in SAG2), so the rebuilt phrase keeps only the target's
    /// inner stop words, not those once between the term's other tokens. The title fallback probes the
    /// phrases of the titles with that sub-phrase's tokens in byte order and
    /// takes the first with hits (SAG2 probes one string; ours can differ in
    /// stop words, spec H.3.5). `label` is left as it was: it is the spelling
    /// the user saw.
    pub(crate) fn resolve_terms(
        &self,
        terms: &mut [Term],
        has_hits: &mut dyn FnMut(&str) -> Result<bool, String>,
    ) -> Result<(), String> {
        for term in terms {
            if has_hits(&quote(&term.phrase))? {
                continue;
            }
            let repaired = self.repair(&term.term, &mut *has_hits)?;
            if repaired != term.term {
                term.term = sag_tokens(&repaired).join(" ");
                term.phrase = fts_phrase(&repaired);
            }
            if term.kind == TermKind::NamePhrase && !has_hits(&quote(&term.phrase))? {
                let parts: Vec<_> = term.term.split_whitespace().collect();
                let mut matches = vec![];
                for start in 0..parts.len() {
                    for end in start + 2..=parts.len() {
                        let name = parts[start..end].join(" ");
                        if self.titles.contains_key(&name) {
                            matches.push((end - start, name));
                        }
                    }
                }
                matches.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
                if let Some((_, name)) = matches.first() {
                    for phrase in &self.titles[name] {
                        if has_hits(&quote(phrase))? {
                            term.term = name.clone();
                            term.phrase = phrase.clone();
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// `sag2_v10.rs:Corpus::diversify`, line for line: greedy DPP over the first
/// `n = min(len, 10)` candidates (kernel `score_i · score_j · cos(i, j)`,
/// residual `score²`), picking the largest residual (ties: the lower index)
/// until the residual is within `n` ulps of the largest initial residual; the
/// rest keep their order, and candidates after the first `n` are not moved.
///
/// The term vectors are `IndexMap`s in token order, as in SAG2, so the float
/// sums run in a fixed order (D2). `vectorize` and `idf` replace SAG2's `words`
/// and `Corpus.idf` (spec H.3.9).
///
/// `idf` must return a positive number for every token (SAG2's is always ≥ 1;
/// [`diversity_idf`] is ≥ 1 whenever `df ≤ n`). A token missing from the counts
/// should get `diversity_idf(n, 0)`, never 0: a passage whose tokens all weigh
/// 0 has norm 0, its vector turns NaN, and diversification is silently lost
/// for the rest of the list. A passage with no tokens at all is harmless (an
/// empty vector, orthogonal to every other).
#[allow(clippy::ptr_arg, clippy::needless_range_loop)] // the signature and loops of the source
pub(crate) fn diversify(
    candidates: &mut Vec<SagCandidate>,
    vectorize: &dyn Fn(&str) -> Vec<String>,
    idf: &dyn Fn(&str) -> f64,
) {
    let n = candidates.len().min(10);
    if n == 0 {
        return;
    }
    let vectors: Vec<IndexMap<String, f64>> = candidates[..n]
        .iter()
        .map(|c| {
            let mut counts = IndexMap::<String, usize>::new();
            for term in vectorize(&c.content) {
                *counts.entry(term).or_default() += 1;
            }
            let mut vector: IndexMap<_, _> = counts
                .into_iter()
                .map(|(term, count)| {
                    let term_idf = idf(&term);
                    debug_assert!(term_idf > 0., "diversify: idf must be > 0, got {term_idf}");
                    let weight = (1. + (count as f64).ln()) * term_idf;
                    (term, weight)
                })
                .collect();
            let norm = vector.values().map(|v| v * v).sum::<f64>().sqrt();
            for value in vector.values_mut() {
                *value /= norm;
            }
            vector
        })
        .collect();
    let mut kernel = vec![vec![0.; n]; n];
    let mut residual: Vec<_> = candidates[..n].iter().map(|c| c.score * c.score).collect();
    for i in 0..n {
        for j in 0..n {
            kernel[i][j] = if i == j {
                residual[i]
            } else {
                candidates[i].score
                    * candidates[j].score
                    * vectors[i]
                        .iter()
                        .map(|(term, value)| value * vectors[j].get(term).unwrap_or(&0.))
                        .sum::<f64>()
            };
        }
    }
    let maximum = residual.iter().copied().fold(0., f64::max);
    let tolerance = n as f64 * (f64::from_bits(maximum.to_bits() + 1) - maximum);
    let mut coefficients = vec![Vec::<f64>::new(); n];
    let mut remaining: Vec<usize> = (0..n).collect();
    let mut order = vec![];
    while !remaining.is_empty() {
        let winner = *remaining
            .iter()
            .max_by(|&&a, &&b| residual[a].total_cmp(&residual[b]).then(b.cmp(&a)))
            .unwrap();
        if residual[winner] <= tolerance {
            order.extend(remaining);
            break;
        }
        order.push(winner);
        remaining.retain(|&i| i != winner);
        let denominator = residual[winner].sqrt();
        for &i in &remaining {
            let projection = (kernel[winner][i]
                - coefficients[winner]
                    .iter()
                    .zip(&coefficients[i])
                    .map(|(a, b)| a * b)
                    .sum::<f64>())
                / denominator;
            coefficients[i].push(projection);
            residual[i] = (residual[i] - projection * projection).max(0.);
        }
    }
    let first = candidates[..n].to_vec();
    for (position, index) in order.into_iter().enumerate() {
        candidates[position] = first[index].clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use TermKind::*;

    fn term(text: &str, kind: TermKind) -> Term {
        Term { term: text.into(), kind, score: 1.0, label: text.into(), phrase: text.into() }
    }

    fn candidate(id: i64, content: &str, score: f64) -> SagCandidate {
        SagCandidate {
            id,
            path: String::new(),
            line: 1,
            line_end: 1,
            title: String::new(),
            heading: String::new(),
            content: content.into(),
            bm25: 0.,
            score,
            previous_score: None,
            order: 0,
        }
    }

    fn ids(c: &[SagCandidate]) -> Vec<i64> {
        c.iter().map(|c| c.id).collect()
    }

    #[derive(Deserialize)]
    struct RawCandidate {
        id: i64,
        content: String,
        score: f64,
    }

    #[derive(Deserialize)]
    struct RawCase {
        question_index: i64,
        candidates: Vec<RawCandidate>,
        idf: HashMap<String, f64>,
        expected_ids: Vec<i64>,
    }

    struct DppCase {
        question_index: i64,
        candidates: Vec<SagCandidate>,
        idf: HashMap<String, f64>,
        expected_ids: Vec<i64>,
    }

    /// `tests/sag2_v10_dpp.json` of SAG-Wiki 61f63c6, copied unmodified.
    fn dpp_cases() -> Vec<DppCase> {
        let raw: Vec<RawCase> = serde_json::from_str(include_str!("fixtures/sag2_v10_dpp.json")).unwrap();
        raw.into_iter()
            .map(|case| DppCase {
                question_index: case.question_index,
                candidates: case.candidates.iter().map(|c| candidate(c.id, &c.content, c.score)).collect(),
                idf: case.idf,
                expected_ids: case.expected_ids,
            })
            .collect()
    }

    // Ported from sag2_v10.rs:tests::recorded_final_rankings_match_python_v10; fixture unmodified.
    #[test]
    fn recorded_final_rankings_match_python_v10() {
        let cases = dpp_cases();
        assert_eq!(cases.len(), 4);
        for case in cases {
            let idf: HashMap<String, f64> = case.idf;
            let mut c = case.candidates;
            diversify(&mut c, &words, &|w| idf[w]);
            assert_eq!(ids(&c), case.expected_ids, "question {}", case.question_index);
        }
    }

    // Ported from sag2_v10.rs:tests::diversity_words_match_python_for_combining_marks
    // (casefold replaced by to_lowercase, spec H.5; the same output on these strings).
    #[test]
    fn diversity_words_match_python_for_combining_marks() {
        assert_eq!(words("שָׁלוֹם"), vec!["ש", "לו", "ם"]);
        assert_eq!(words("العَرَبِيَّة"), vec!["الع", "ر", "ب", "ي", "ة"]);
        assert_eq!(words("café e\u{0301} ① Ⅻ hello_world"), vec!["café", "e", "①", "ⅻ", "hello", "world"]);
    }

    #[test]
    fn folded_drops_marks_on_latin_letters_only() {
        assert_eq!(folded("René Descartes"), "Rene Descartes");
        assert_eq!(folded("Ångström ǅ ﬁ"), "Angstrom Dz fi");
        assert_eq!(folded("שָׁלוֹם"), "שָׁלוֹם".nfkc().collect::<String>());
        assert_eq!(folded("が"), "が");
        assert_eq!(folded("清华"), "清华");
    }

    #[test]
    fn diversity_idf_is_the_document_formula() {
        assert_eq!(diversity_idf(9, 4), (10f64 / 5.).ln() + 1.);
        assert_eq!(diversity_idf(0, 0), 1.);
    }

    #[test]
    fn diversify_leaves_candidates_after_the_first_ten_and_handles_empty() {
        let mut empty: Vec<SagCandidate> = vec![];
        diversify(&mut empty, &words, &|_| 1.);
        assert!(empty.is_empty());
        // Twelve identical passages with descending scores: after the first
        // pick every residual is 0, so the first ten keep their order, and the
        // last two are never looked at.
        let mut c: Vec<_> = (0..12).map(|i| candidate(i, "same words here", 1. - i as f64 / 100.)).collect();
        c.swap(10, 11);
        diversify(&mut c, &words, &|_| 1.);
        assert_eq!(ids(&c), vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 10]);
        // Distinct passages are picked by score; a duplicate of the top one
        // sinks below an unrelated lower-scored one.
        let mut c = vec![candidate(1, "alpha beta", 0.9), candidate(2, "alpha beta", 0.8), candidate(3, "gamma delta", 0.5)];
        diversify(&mut c, &words, &|_| 1.);
        assert_eq!(ids(&c), vec![1, 3, 2]);
    }

    #[test]
    fn diversify_breaks_equal_residuals_by_the_lower_index() {
        // Orthogonal passages with equal scores: every residual stays equal,
        // and `max_by` alone would return the last one.
        let mut c = vec![candidate(7, "beta", 0.5), candidate(3, "alpha", 0.5), candidate(5, "gamma", 0.5)];
        diversify(&mut c, &words, &|_| 1.);
        assert_eq!(ids(&c), vec![7, 3, 5]);
    }

    #[test]
    #[should_panic(expected = "idf must be > 0")]
    fn diversify_rejects_a_zero_idf_in_debug_builds() {
        let mut c = vec![candidate(1, "alpha", 0.9), candidate(2, "beta", 0.8)];
        diversify(&mut c, &words, &|_| 0.);
    }

    #[test]
    fn alias_names_are_nfkc_normalised_before_lowercasing() {
        // NFD and NFC spellings of one title name one value (SAG2 nfkc()).
        let m = AliasMap::build(&["Rene\u{301} Descartes".into(), "René Descartes".into()], &[], &[]);
        let mut target = |t: &str| Ok(t == "\"rené descartes\"");
        assert_eq!(m.repair("rene descartes", &mut target).unwrap(), "rené descartes");
        assert!(m.titles.contains_key("rené descartes"));
        // A full-width title, alias and wiki target fold to an identity: no alias.
        let m = AliasMap::build(&["ＡＢＣ".into()], &[("Ｘ".into(), "x".into())], &["ＤＥＦ".into()]);
        assert!(m.pattern().is_none());
        // An NFD frontmatter alias names the NFC title.
        let m = AliasMap::build(&[], &[("SAG".into(), "Cafe\u{301} Society".into())], &[]);
        assert_eq!(m.aliases.get("sag").map(String::as_str), Some("café society"));
    }

    #[test]
    fn repair_rewrites_folded_title_and_frontmatter_alias_only_when_it_has_hits() {
        let m = AliasMap::build(&["rené descartes".into()], &[("SAG".into(), "search augmented generation".into())], &[]);
        // P4: the callback gets the quoted FTS expression.
        let mut hits = |t: &str| Ok(t == "\"rené descartes\"" || t == "\"search augmented generation\"");
        assert_eq!(m.repair("Where was Rene Descartes born?", &mut hits).unwrap(), "Where was rené descartes born?");
        assert_eq!(m.repair("what is SAG", &mut hits).unwrap(), "what is search augmented generation");
        let mut none = |_: &str| Ok(false);
        assert_eq!(m.repair("what is SAG", &mut none).unwrap(), "what is SAG");
    }

    #[test]
    fn repair_keeps_a_source_that_has_hits_itself() {
        let m = AliasMap::build(&["rené descartes".into()], &[], &[]);
        let mut asked = vec![];
        let mut all = |t: &str| {
            asked.push(t.to_owned());
            Ok(true)
        };
        assert_eq!(m.repair("rene DESCARTES", &mut all).unwrap(), "rene DESCARTES");
        assert_eq!(asked, vec!["\"rene descartes\""]);
        let mut fail = |_: &str| Err("index busy".to_owned());
        assert_eq!(m.repair("rene descartes", &mut fail), Err("index busy".to_owned()));
        assert_eq!(m.repair("no alias here", &mut fail).unwrap(), "no alias here");
    }

    #[test]
    fn ambiguous_aliases_are_dropped() {
        // Two files both declare the alias "x".
        let m = AliasMap::build(&["alpha".into(), "beta".into()], &[("x".into(), "Alpha".into()), ("X".into(), "beta".into())], &[]);
        assert!(m.pattern().is_none());
        let mut all = |_: &str| Ok(true);
        let mut only_titles = |t: &str| Ok(t != "\"x\"");
        assert_eq!(m.repair("what is x", &mut only_titles).unwrap(), "what is x");
        assert_eq!(m.repair("what is x", &mut all).unwrap(), "what is x");
        // Two titles that fold to the same key are ambiguous too (SAG2's rule).
        let m = AliasMap::build(&["rené".into(), "rène".into()], &[], &[]);
        assert!(m.pattern().is_none());
    }

    #[test]
    fn wiki_targets_and_aliases_build_the_pattern() {
        let m = AliasMap::build(
            &["Café Society".into(), "plain".into()],
            &[("清华".into(), "清华大学".into()), ("Plain".into(), "plain".into())],
            &["Zoë".into(), "nothing to fold".into()],
        );
        // Keys: "cafe society" (title), "清华" (alias), "zoe" (wiki target);
        // "plain" and "nothing to fold" equal their only value.
        let re = m.pattern().unwrap();
        let found = |t: &str| re.find_iter(t).map(|m| m.unwrap().as_str().to_owned()).collect::<Vec<_>>();
        assert_eq!(found("cafe society meets zoe in 清华 plain"), vec!["cafe society", "zoe", "清华"]);
        // jieba cuts 清华大学 for search into more than one token.
        let qinghua = quote(&fts_phrase("清华大学"));
        let mut target_only = |t: &str| Ok(t == "\"café society\"" || t == "\"zoë\"" || t == qinghua);
        assert_eq!(
            m.repair("Cafe Society, ZOE, 我在清华读书", &mut target_only).unwrap(),
            "café society, zoë, 我在清华大学读书"
        );
    }

    /// A stub of our index, which keeps stop words: the inner-stop phrases of
    /// "Lord of the Rings" and 傲慢与偏见 have hits, and so does "世界" (the
    /// phrase of 我的世界, whose stops are at the edge). The `sag_tokens`
    /// strings "lord rings" and "傲慢 偏见" are not adjacent in such an index,
    /// so they have none.
    fn stop_word_index(asked: &mut Vec<String>) -> impl FnMut(&str) -> Result<bool, String> + '_ {
        |q: &str| {
            asked.push(q.to_owned());
            Ok(matches!(q, "\"lord of the rings\"" | "\"世界\"" | "\"傲慢 与 偏见\""))
        }
    }

    fn stop_word_aliases() -> AliasMap {
        AliasMap::build(
            &["Lord of the Rings".into(), "我的世界".into(), "傲慢与偏见".into()],
            &[
                ("LOTR".into(), "Lord of the Rings".into()),
                ("MC".into(), "我的世界".into()),
                ("PnP".into(), "傲慢与偏见".into()),
            ],
            &[],
        )
    }

    #[test]
    fn repair_finds_stop_word_alias_targets_by_their_phrase() {
        let m = stop_word_aliases();
        let mut asked = vec![];
        {
            let mut index = stop_word_index(&mut asked);
            assert_eq!(m.repair("who wrote LOTR", &mut index).unwrap(), "who wrote lord of the rings");
            assert_eq!(m.repair("MC 好玩吗", &mut index).unwrap(), "我的世界 好玩吗");
            assert_eq!(m.repair("谁写了 PnP", &mut index).unwrap(), "谁写了 傲慢与偏见");
        }
        assert_eq!(
            asked,
            vec!["\"lotr\"", "\"lord of the rings\"", "\"mc\"", "\"世界\"", "\"pnp\"", "\"傲慢 与 偏见\""]
        );
    }

    #[test]
    fn a_source_with_stop_words_that_has_hits_is_kept() {
        // The index has "bank of america" and "bofa"; "bank america" is not
        // adjacent anywhere, so probing it would wrongly report no hits.
        let m = AliasMap::build(&["BofA".into()], &[("Bank of America".into(), "BofA".into())], &[]);
        let mut asked = vec![];
        let mut index = |q: &str| {
            asked.push(q.to_owned());
            Ok(matches!(q, "\"bank of america\"" | "\"bofa\""))
        };
        assert_eq!(m.repair("work at Bank of America", &mut index).unwrap(), "work at Bank of America");
        assert_eq!(asked, vec!["\"bank of america\""]);
    }

    #[test]
    fn resolve_terms_probe_and_rewrite_by_phrase() {
        let m = stop_word_aliases();
        let mut pride = term("傲慢 偏见", NamePhrase);
        pride.phrase = "傲慢 与 偏见".into();
        let mut frodo = term("frodo lord rings", NamePhrase);
        frodo.phrase = "frodo lord of the rings".into();
        let mut austen = term("奥斯汀 傲慢 偏见", NamePhrase);
        austen.phrase = "奥斯汀 的 傲慢 与 偏见".into();
        let mut t = vec![term("lotr", Word), pride, frodo, austen];
        let mut asked = vec![];
        m.resolve_terms(&mut t, &mut stop_word_index(&mut asked)).unwrap();
        assert_eq!(
            t.iter().map(|t| (t.term.as_str(), t.phrase.as_str())).collect::<Vec<_>>(),
            vec![
                // Repaired: the term is re-tokenised, the phrase is the target's.
                ("lord rings", "lord of the rings"),
                // Probed by its phrase, which has hits: unchanged.
                ("傲慢 偏见", "傲慢 与 偏见"),
                // Title fallback: the title's phrase is probed and taken.
                ("lord rings", "lord of the rings"),
                ("傲慢 偏见", "傲慢 与 偏见"),
            ]
        );
        assert_eq!(t[0].label, "lotr");
        assert_eq!(
            asked,
            vec![
                "\"lotr\"", "\"lotr\"", "\"lord of the rings\"",
                "\"傲慢 与 偏见\"",
                "\"frodo lord of the rings\"", "\"frodo lord of the rings\"", "\"lord of the rings\"",
                "\"奥斯汀 的 傲慢 与 偏见\"", "\"奥斯汀 的 傲慢 与 偏见\"", "\"傲慢 与 偏见\"",
            ]
        );
    }

    #[test]
    fn title_fallback_tries_every_title_of_the_sub_phrase_in_byte_order() {
        // Both titles tokenise to "lord rings"; their phrases differ.
        let m = AliasMap::build(&["Lord Rings".into(), "Lord of the Rings".into()], &[], &[]);
        let mut asked = vec![];
        let mut hits = |q: &str| {
            asked.push(q.to_owned());
            Ok(q == "\"lord rings\"")
        };
        let mut t = vec![term("bob lord rings", NamePhrase)];
        m.resolve_terms(&mut t, &mut hits).unwrap();
        assert_eq!((t[0].term.as_str(), t[0].phrase.as_str()), ("lord rings", "lord rings"));
        assert_eq!(asked, vec!["\"bob lord rings\"", "\"bob lord rings\"", "\"lord of the rings\"", "\"lord rings\""]);
    }

    // Ported from sag2_v10.rs:tests::unresolved_expansion_terms_preserve_connected_tokens.
    #[test]
    fn unresolved_expansion_terms_preserve_connected_tokens() {
        let m = AliasMap::build(&[], &[], &[]);
        let mut t = vec![term("half-ounce", Word), term("a.h", Word)];
        m.resolve_terms(&mut t, &mut |_| Ok(false)).unwrap();
        assert_eq!(t.iter().map(|t| t.term.as_str()).collect::<Vec<_>>(), vec!["half-ounce", "a.h"]);
    }

    #[test]
    fn name_phrase_falls_back_to_longest_title_subphrase() {
        let m = AliasMap::build(&["new jersey".into()], &[], &[]);
        let mut t = vec![term("bob new jersey", NamePhrase)];
        m.resolve_terms(&mut t, &mut |q: &str| Ok(q == "\"new jersey\"")).unwrap();
        assert_eq!(t[0].term, "new jersey");
    }

    #[test]
    fn resolve_terms_repairs_then_retokenises_and_keeps_words_and_labels() {
        let m = AliasMap::build(&["rené descartes".into(), "new jersey".into(), "jersey city".into()], &[], &[]);
        let mut t = vec![
            term("rene descartes", Word),
            term("has hits", Word),
            term("bob new jersey", Word),
            term("new jersey city", NamePhrase),
        ];
        let mut asked = vec![];
        let mut hits = |q: &str| {
            asked.push(q.to_owned());
            Ok(matches!(q, "\"rené descartes\"" | "\"has hits\"" | "\"new jersey\"" | "\"jersey city\""))
        };
        m.resolve_terms(&mut t, &mut hits).unwrap();
        assert_eq!(
            t.iter().map(|t| t.term.as_str()).collect::<Vec<_>>(),
            // A word gets no title fallback; of two equally long title
            // sub-phrases the bytewise smaller one wins.
            vec!["rené descartes", "has hits", "bob new jersey", "jersey city"]
        );
        assert_eq!(t[0].label, "rene descartes");
        assert_eq!(
            asked,
            vec![
                "\"rene descartes\"", "\"rene descartes\"", "\"rené descartes\"",
                "\"has hits\"",
                "\"bob new jersey\"",
                "\"new jersey city\"", "\"new jersey city\"", "\"jersey city\"",
            ]
        );
    }
}
