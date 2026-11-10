// Ported from SAG-Wiki 61f63c6 `core/src/sag2_v10.rs` (folded, words, Corpus::from_vocabulary,
// Corpus::repair, Corpus::resolve_terms, Corpus::diversify) and `core/src/store.rs`
// (retrieval_statistics), MIT License,
// Copyright (c) 2026 sag contributors. Changes for note.md: see spec Appendix H.

//! SAG2 corpus steps: the alias table and lexical repair (spec H.3.1, H.3.2,
//! H.3.5) and the DPP diversification of the final ranking (spec H.3.9).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use fancy_regex::Regex;
use indexmap::IndexMap;
use unicode_normalization::char::canonical_combining_class;
use unicode_normalization::UnicodeNormalization;

use super::text::{alias_pattern, quote, sag_tokens};
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
/// `searchidx::tokenize::tokens` (spec H.3.9).
pub(crate) fn words(text: &str) -> Vec<String> {
    static WORDS: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[\p{L}\p{N}]+").unwrap());
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
    /// Lowercased file titles of at least two tokens, tokens joined by spaces.
    titles: HashSet<String>,
}

impl AliasMap {
    /// `sag2_v10.rs:Corpus::from_vocabulary`'s alias and title rules over the
    /// sources of spec H.3.1:
    ///
    /// - each file title `t` (lowercased): `folded(t) → t`;
    /// - each frontmatter alias `a` of the file titled `t`: `folded(lower(a)) → t`;
    /// - each wiki-link target `w` (already without `#…`, from `SagReader`):
    ///   `folded(lower(w)) → lower(w)`.
    ///
    /// A key that names more than one distinct value is dropped, and a key equal
    /// to its only value is not an alias (SAG2's "only one value" rule). `lower`
    /// is `str::to_lowercase`, as the index lowercases (spec H.3.1). `titles`
    /// holds the file titles only.
    pub(crate) fn build(titles: &[String], aliases: &[(String, String)], wiki_targets: &[String]) -> Self {
        let mut names: HashMap<String, HashSet<String>> = HashMap::new();
        let mut title_terms = HashSet::new();
        for title in titles {
            let name = title.to_lowercase();
            let terms = sag_tokens(&name);
            if terms.len() >= 2 {
                title_terms.insert(terms.join(" "));
            }
            names.entry(folded(&name)).or_default().insert(name);
        }
        for (alias, title) in aliases {
            names.entry(folded(&alias.to_lowercase())).or_default().insert(title.to_lowercase());
        }
        for target in wiki_targets {
            let name = target.to_lowercase();
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
    /// gets the FTS expression `quote(sag_tokens(x).join(" "))` (SAG2 quotes in
    /// the callback; ours takes the expression, P4). Without a pattern the text
    /// comes back unchanged.
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
                    if !has_hits(&quote(&sag_tokens(source).join(" ")))?
                        && has_hits(&quote(&sag_tokens(target).join(" ")))? =>
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
    /// `quote(term)`. `label` is left as it was: it is the spelling the user saw.
    pub(crate) fn resolve_terms(
        &self,
        terms: &mut [Term],
        has_hits: &mut dyn FnMut(&str) -> Result<bool, String>,
    ) -> Result<(), String> {
        for term in terms {
            if has_hits(&quote(&term.term))? {
                continue;
            }
            let repaired = self.repair(&term.term, &mut *has_hits)?;
            if repaired != term.term {
                term.term = sag_tokens(&repaired).join(" ");
            }
            if term.kind == TermKind::NamePhrase && !has_hits(&quote(&term.term))? {
                let parts: Vec<_> = term.term.split_whitespace().collect();
                let mut matches = vec![];
                for start in 0..parts.len() {
                    for end in start + 2..=parts.len() {
                        let name = parts[start..end].join(" ");
                        if self.titles.contains(&name) {
                            matches.push((end - start, name));
                        }
                    }
                }
                matches.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
                if let Some((_, name)) = matches.first() {
                    if has_hits(&quote(name))? {
                        term.term = name.clone();
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
                    let weight = (1. + (count as f64).ln()) * idf(&term);
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
        Term { term: text.into(), kind, score: 1.0, label: text.into() }
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
        let qinghua = quote(&sag_tokens("清华大学").join(" "));
        let mut target_only = |t: &str| Ok(t == "\"café society\"" || t == "\"zoë\"" || t == qinghua);
        assert_eq!(
            m.repair("Cafe Society, ZOE, 我在清华读书", &mut target_only).unwrap(),
            "café society, zoë, 我在清华大学读书"
        );
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
