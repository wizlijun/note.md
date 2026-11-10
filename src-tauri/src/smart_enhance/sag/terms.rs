// Ported from SAG-Wiki 61f63c6 `core/src/retrieval.rs` (expansion_terms, interleave, rank), MIT License,
// Copyright (c) 2026 sag contributors. Changes for note.md: see spec Appendix H.

//! SAG2 expansion terms, interleaving and ranking (spec H.3.4, H.3.5, H.3.8).

use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap, HashSet};

use icu_collator::{Collator, CollatorOptions};
use icu_locid::locale;
use indexmap::IndexMap;

use super::text::{name_spans, sag_tokens, sentences};
use super::{SagCandidate, Term, TermKind};

/// Corpus statistics for the IDF of `retrieval.rs:expansion_terms`
/// (`store.rs:chunk_count` and `store.rs:frequencies`; spec H.3.4: line-level
/// blocks only). `Sync` so the lookup future stays `Send` (pre-flight P8).
pub(crate) trait TermStats: Sync {
    /// N: the number of blocks (`store.rs:chunk_count`).
    fn total(&self) -> Result<f64, String>;
    /// The document frequency of every term in `terms` (`store.rs:frequencies`).
    fn df(&self, terms: &[String]) -> Result<HashMap<String, u64>, String>;
}

thread_local! {
    /// `retrieval.rs:expansion_terms`: the collator `Collator::try_new(&locale!("en").into(),
    /// CollatorOptions::new())`, built once per thread instead of per call.
    /// icu_collator 1.5's `Collator` holds an `Rc`-backed data payload and is
    /// neither `Send` nor `Sync`, so it cannot sit in a shared `OnceLock`.
    /// Kept as a `Result` so `expansion_terms` can report a failure as SAG2 does.
    static COLLATOR: Result<Collator, String> =
        Collator::try_new(&locale!("en").into(), CollatorOptions::new())
            .map_err(|e| format!("词项排序初始化失败：{e:?}"));
}

/// The term order of `retrieval.rs:expansion_terms`: ICU `en` collation at the
/// default strength, then bytes when the collator calls them equal (spec H.3.4
/// step 8: the byte tiebreak makes SAG2's `HashMap`-dependent order total).
/// Falls back to bytes alone if the collator could not be built, which
/// `expansion_terms` reports as an error before it ever sorts.
pub(crate) fn term_cmp(a: &str, b: &str) -> Ordering {
    COLLATOR.with(|c| match c {
        Ok(c) => c.compare(a, b).then_with(|| a.cmp(b)),
        Err(_) => a.cmp(b),
    })
}

/// `retrieval.rs:expansion_terms`, line by line (spec H.3.4). `query` is the
/// unrepaired question and `seeds` the frontier. Tokens come from `sag_tokens`
/// (the index's `cut_for_search`, H.2#1) and names from `name_spans`, which
/// adds jieba POS names, wiki targets, tags and alias matches to SAG2's
/// `name_phrases` (H.3.4 table). `label` follows pre-flight P12.
pub(crate) fn expansion_terms(
    query: &str,
    seeds: &[SagCandidate],
    limit: usize,
    aliases: Option<&fancy_regex::Regex>,
    stats: &dyn TermStats,
) -> Result<Vec<Term>, String> {
    // SAG2 builds its collator here and fails the call when it cannot.
    COLLATOR.with(|c| c.as_ref().map(|_| ()).map_err(Clone::clone))?;
    let query_words = sag_tokens(query);
    let query_set: HashSet<String> = query_words.iter().cloned().collect();
    let max_score = seeds.iter().map(|s| s.score).fold(0., f64::max);
    // (sentence, words, names as (term, label)) per sentence, per seed.
    let mut passages: Vec<(&SagCandidate, Vec<(&str, Vec<String>, Vec<(String, String)>)>)> = vec![];
    // SAG2 uses a HashSet; sorted here only so the df request is reproducible
    // (the result does not depend on its order).
    let mut vocabulary: BTreeSet<String> = query_set.iter().cloned().collect();
    for seed in seeds {
        let mut parts = vec![];
        for sentence in sentences(&seed.content) {
            let names = name_spans(sentence, aliases);
            let mut ungrouped = String::new();
            let mut end = 0;
            for n in &names {
                ungrouped.push_str(&sentence[end..n.start]);
                ungrouped.push(' ');
                end = n.end;
            }
            ungrouped.push_str(&sentence[end..]);
            let mut words = sag_tokens(&ungrouped);
            words.extend(names.iter().map(|n| n.term.clone()));
            vocabulary.extend(words.iter().cloned());
            let names = names.into_iter().map(|n| (n.term, n.label)).collect();
            parts.push((sentence, words, names));
        }
        passages.push((seed, parts));
    }
    let total = stats.total()?;
    // An empty name term (a name of stop words only) is skipped below before
    // its df is read, so it is not requested (SAG asks for it and gets 0;
    // FTS5 accepts the empty phrase and matches no rows).
    let vocabulary: Vec<String> = vocabulary.into_iter().filter(|t| !t.is_empty()).collect();
    let frequencies: HashMap<String, f64> =
        stats.df(&vocabulary)?.into_iter().map(|(term, count)| (term, count as f64)).collect();
    // SAG2 indexes `frequencies[term]`, which panics on a missing term; this
    // reports it instead.
    let df = |term: &str| -> Result<f64, String> {
        frequencies.get(term).copied().ok_or_else(|| format!("缺少词项的文档频率：{term}"))
    };
    let idf = |term: &str| -> Result<f64, String> {
        let df = df(term)?;
        Ok((1. + (total - df + 0.5) / (df + 0.5)).ln())
    };
    let mut ranked: HashMap<String, Term> = HashMap::new();
    for (seed, parts) in passages {
        let weight = 0.5 + 0.5 * if max_score > 0. { seed.score / max_score } else { 0. };
        let mut counts: IndexMap<String, usize> = IndexMap::new();
        let mut contexts: HashMap<String, f64> = HashMap::new();
        // name term → label of its first span in this seed (P12).
        let mut name_terms: HashMap<String, String> = HashMap::new();
        for (sentence, words, names) in &parts {
            let mut unique = HashSet::new();
            let mut context = 0.;
            for word in sag_tokens(sentence) {
                if unique.insert(word.clone()) && query_set.contains(&word) {
                    context += idf(&word)?
                }
            }
            for word in words {
                *counts.entry(word.clone()).or_default() += 1;
                let old = contexts.entry(word.clone()).or_default();
                *old = old.max(context);
            }
            for (term, label) in names {
                name_terms.entry(term.clone()).or_insert_with(|| label.clone());
            }
        }
        for (term, tf) in counts {
            if sag_tokens(&term).iter().all(|w| query_set.contains(w)) || df(&term)? == 0. {
                continue;
            }
            let score = (1. + (tf as f64).ln()) * idf(&term)? * (1. + contexts[&term]) * weight;
            if !ranked.contains_key(&term) || score > ranked[&term].score {
                let (kind, label) = match name_terms.get(&term) {
                    Some(label) => (TermKind::NamePhrase, label.clone()),
                    None => (TermKind::Word, term.clone()),
                };
                ranked.insert(term.clone(), Term { term, kind, score, label });
            }
        }
    }
    let mut terms: Vec<Term> = ranked.into_values().collect();
    terms.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| term_cmp(&a.term, &b.term)));
    terms.truncate(limit);
    Ok(terms)
}

/// `retrieval.rs:interleave`, verbatim: rank r of every list in turn, deduplicated
/// by id, `order` set to the position appended, stopping at `limit` (spec H.3.5).
pub(crate) fn interleave(lists: Vec<Vec<SagCandidate>>, limit: usize) -> Vec<SagCandidate> {
    let mut seen = HashSet::new();
    let mut result = vec![];
    for rank in 0..limit {
        for list in &lists {
            if let Some(c) = list.get(rank) {
                if seen.insert(c.id) {
                    let mut c = c.clone();
                    c.order = result.len();
                    result.push(c);
                    if result.len() == limit {
                        return result;
                    }
                }
            }
        }
    }
    result
}

/// `retrieval.rs:rank`, verbatim: score descending, then order, then id (spec H.3.8).
pub(crate) fn rank(mut candidates: Vec<SagCandidate>) -> Vec<SagCandidate> {
    candidates.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then(a.order.cmp(&b.order)).then(a.id.cmp(&b.id))
    });
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::{Equal, Greater, Less};
    use TermKind::*;

    struct Fixed(f64, HashMap<String, u64>);

    impl TermStats for Fixed {
        fn total(&self) -> Result<f64, String> {
            Ok(self.0)
        }
        fn df(&self, terms: &[String]) -> Result<HashMap<String, u64>, String> {
            Ok(terms.iter().map(|t| (t.clone(), self.1.get(t).copied().unwrap_or(0))).collect())
        }
    }

    fn fixed() -> Fixed {
        let df = [
            ("alice", 5),
            ("born", 10),
            ("moved", 20),
            ("paris", 4),
            ("hosts", 30),
            ("louvre", 2),
            ("eiffel", 2),
            ("lyon", 0),
            ("has", 50),
            ("bob smith", 3),
        ];
        Fixed(100., df.into_iter().map(|(t, n)| (t.to_owned(), n)).collect())
    }

    fn candidate(id: i64, score: f64, order: usize, content: &str) -> SagCandidate {
        SagCandidate {
            id,
            path: String::new(),
            line: 1,
            line_end: 1,
            title: String::new(),
            heading: String::new(),
            content: content.to_owned(),
            bm25: 0.,
            score,
            previous_score: None,
            order,
        }
    }

    fn seed(score: f64, content: &str) -> SagCandidate {
        candidate(0, score, 0, content)
    }

    // Ported from retrieval.rs:tests::c.
    fn c(id: i64) -> SagCandidate {
        candidate(id, 0., 0, "")
    }

    fn ids(cs: &[SagCandidate]) -> Vec<i64> {
        cs.iter().map(|c| c.id).collect()
    }

    #[test]
    fn expansion_terms_match_hand_computed_scores() {
        // idf(t) = ln(1 + (100 − df + 0.5)/(df + 0.5)); s1 weighs 1.0, s2 0.75;
        // alice and born are query words, lyon has df 0; eiffel and louvre tie
        // and go in ICU order.
        let s1 = seed(0.8, "Alice moved to Paris. Paris hosts the Louvre and Eiffel.");
        let s2 = seed(0.4, "Bob Smith was born in Lyon.\nLyon has Bob Smith.");
        // Pre-flight P18: clone for the first call, the second reuses s1 and s2.
        let t = expansion_terms("Where was Alice born", &[s1.clone(), s2.clone()], 20, None, &fixed()).unwrap();
        let got: Vec<(&str, TermKind)> = t.iter().map(|t| (t.term.as_str(), t.kind)).collect();
        assert_eq!(
            got,
            vec![
                ("paris", Word),
                ("bob smith", NamePhrase),
                ("moved", Word),
                ("eiffel", Word),
                ("louvre", Word),
                ("hosts", Word),
                ("has", Word)
            ]
        );
        for (t, want) in t.iter().zip([
            20.597706428915263,
            13.935293593950192,
            6.235853819911771,
            3.6988297849671046,
            3.6988297849671046,
            1.1973938332278935,
            0.5198603854199589,
        ]) {
            assert!((t.score - want).abs() < 1e-12, "{} {}", t.term, t.score);
        }
        assert_eq!(expansion_terms("Where was Alice born", &[s1.clone(), s2.clone()], 5, None, &fixed()).unwrap().len(), 5);
        assert_eq!(t[1].label, "Bob Smith");
    }

    #[test]
    fn word_labels_are_the_term() {
        let t = expansion_terms("Where was Alice born", &[seed(1., "Alice moved to Paris.")], 20, None, &fixed())
            .unwrap();
        assert_eq!(t.iter().map(|t| (t.term.as_str(), t.label.as_str())).collect::<Vec<_>>(), vec![("paris", "paris"), ("moved", "moved")]);
    }

    /// A `TermStats` with N = 100 and the given df table (unlisted terms: 0).
    fn table(df: &[(&str, u64)]) -> Fixed {
        Fixed(100., df.iter().map(|(t, n)| (t.to_string(), *n)).collect())
    }

    /// `Fixed` that leaves one term out of every `df` answer.
    struct Without(Fixed, &'static str);

    impl TermStats for Without {
        fn total(&self) -> Result<f64, String> {
            self.0.total()
        }
        fn df(&self, terms: &[String]) -> Result<HashMap<String, u64>, String> {
            let mut out = self.0.df(terms)?;
            out.remove(self.1);
            Ok(out)
        }
    }

    fn idf(df: f64) -> f64 {
        (1. + (100. - df + 0.5) / (df + 0.5)).ln()
    }

    #[test]
    fn missing_frequency_is_an_error_not_a_panic() {
        // A missing query word fails in the context sum (`idf(&word)?`).
        let err = expansion_terms("alice", &[seed(1., "Alice moved")], 20, None, &Without(fixed(), "alice"))
            .unwrap_err();
        assert_eq!(err, "缺少词项的文档频率：alice");
        // A missing non-query word fails at the term-loop skip check (`df(&term)?`).
        let err = expansion_terms("alice", &[seed(1., "Alice moved")], 20, None, &Without(fixed(), "moved"))
            .unwrap_err();
        assert_eq!(err, "缺少词项的文档频率：moved");
    }

    #[test]
    fn tied_terms_sort_by_icu_not_bytes() {
        // Same tf, context and df, so the scores tie. Bytes put "cafez" first
        // ('z' < 0xC3); ICU en puts "café" first.
        let stats = table(&[("café", 3), ("cafez", 3)]);
        let t = expansion_terms("x", &[seed(1., "cafez café")], 20, None, &stats).unwrap();
        assert_eq!(t[0].score, t[1].score);
        assert_eq!(t.iter().map(|t| t.term.as_str()).collect::<Vec<_>>(), vec!["café", "cafez"]);
    }

    #[test]
    fn a_tie_between_seeds_keeps_the_first_seed() {
        // "paris" is a name (wiki target) in `named` and a word in `plain`; equal
        // seed scores, tf 1, no query words: the scores tie, and only a
        // strictly greater score replaces, so the first seed's kind and label stay.
        let stats = table(&[("paris", 4), ("see", 10)]);
        let named = seed(1., "see [[Paris]]");
        let plain = seed(1., "see paris");
        let paris = |seeds: &[SagCandidate]| {
            let t = expansion_terms("x", seeds, 20, None, &stats).unwrap();
            let p = t.into_iter().find(|t| t.term == "paris").unwrap();
            (p.kind, p.label)
        };
        assert_eq!(paris(&[named.clone(), plain.clone()]), (NamePhrase, "Paris".to_owned()));
        assert_eq!(paris(&[plain.clone(), named.clone()]), (Word, "paris".to_owned()));
        // A later seed with a strictly greater score does replace.
        assert_eq!(paris(&[seed(0.5, "see paris"), named]), (NamePhrase, "Paris".to_owned()));
    }

    #[test]
    fn a_repeated_query_word_counts_once_and_zero_scores_weigh_half() {
        // Context = idf(alice) once although "alice" occurs twice; every seed
        // scores 0, so max_score is 0 and the weight is 0.5.
        let stats = table(&[("alice", 5), ("paris", 4)]);
        let t = expansion_terms("alice", &[seed(0., "alice alice paris"), seed(0., "")], 20, None, &stats).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].term, "paris");
        let want = idf(4.) * (1. + idf(5.)) * 0.5;
        assert!((t[0].score - want).abs() < 1e-12, "{} {}", t[0].score, want);
    }

    // Ported from retrieval.rs:tests::interleaves_rank_then_term_and_deduplicates.
    #[test]
    fn interleaves_rank_then_term_and_deduplicates() {
        assert_eq!(ids(&interleave(vec![vec![c(1), c(3), c(4)], vec![c(2), c(3), c(5)]], 5)), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn interleave_sets_order_and_stops_at_limit() {
        let out = interleave(vec![vec![c(1), c(3), c(4)], vec![c(2), c(3), c(5)]], 3);
        assert_eq!(out.iter().map(|c| (c.id, c.order)).collect::<Vec<_>>(), vec![(1, 0), (2, 1), (3, 2)]);
    }

    #[test]
    fn rank_orders_score_then_order_then_id() {
        let cs = vec![candidate(9, 0.5, 2, ""), candidate(7, 0.5, 1, ""), candidate(1, 0.9, 3, ""), candidate(3, 0.5, 1, "")];
        assert_eq!(ids(&rank(cs)), vec![1, 3, 7, 9]);
    }

    #[test]
    fn term_cmp_uses_icu_not_bytes() {
        assert_eq!(term_cmp("café", "cafez"), Less); // bytes say the opposite
        assert_eq!(term_cmp("a1", "ab"), Less);
        assert_eq!(term_cmp("zeta", "北京"), Less);
        // Pairs where ICU en and byte order disagree.
        for (a, b) in [("café", "cafez"), ("éclair", "zeta"), ("apple", "Zeta"), ("a_", "a1")] {
            assert_eq!(term_cmp(a, b), Less, "{a} {b}");
            assert_eq!(a.cmp(b), Greater, "bytes {a} {b}");
        }
    }

    #[test]
    fn term_cmp_breaks_icu_ties_by_bytes() {
        // Canonically equivalent spellings: ICU calls them equal, bytes do not.
        let (decomposed, composed) = ("e\u{301}", "\u{e9}");
        COLLATOR.with(|c| assert_eq!(c.as_ref().unwrap().compare(decomposed, composed), Equal));
        assert_eq!(term_cmp(decomposed, composed), Less);
        assert_eq!(term_cmp(composed, decomposed), Greater);
        assert_eq!(term_cmp(composed, composed), Equal);
    }
}
