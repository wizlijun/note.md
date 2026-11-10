//! Pure functions: routing, candidate selection, token estimate, tiering and
//! in-position rerank.

use std::collections::HashMap;

use super::{SkipReason, Tier};
use crate::lookup_params::TierParams;
use crate::smart_lookup::{CanonicalHit, RouteFacts};

pub(crate) enum Route {
    Repair,
    Skip(SkipReason),
    Judge,
}

/// Spec §5.3. Zero hits is decided on the merged `hit_count`, never by summing
/// arm counts. "Few terms" means `1..=few_terms_max` extracted terms (0 terms
/// is not it; `few_terms_max` 0 turns the rule off) with a strict arm that
/// found something.
pub(crate) fn route(facts: &RouteFacts, few_terms_max: usize) -> Route {
    if facts.hit_count == 0 {
        return Route::Repair;
    }
    if facts.pinned {
        return Route::Skip(SkipReason::Pinned);
    }
    let few = (1..=few_terms_max).contains(&facts.extracted_terms.len());
    if few && facts.arms.iter().any(|a| a.kind == "strict" && a.hit_count > 0) {
        return Route::Skip(SkipReason::FewTerms);
    }
    Route::Judge
}

pub(crate) struct CandidateLimits {
    pub pool: usize,
    pub k: usize,
    pub per_file: usize,
    pub max_block_chars: usize,
    pub token_budget: u64,
    pub cjk_chars_per_token: u32,
    pub other_chars_per_token: u32,
}

pub(crate) struct Candidate {
    pub position: usize,
    pub result_id: String,
    pub title: String,
    pub breadcrumb: String,
    pub passage: String,
}

#[derive(Default)]
pub(crate) struct Selection {
    pub picked: Vec<Candidate>,
    /// How many hits were looked at: `min(pool, ordered.len())`.
    pub pool_size: usize,
    pub estimated_tokens: u64,
    pub skipped_pinned: usize,
    pub skipped_rollups: usize,
    pub skipped_confidential: usize,
    pub skipped_stale: usize,
    pub skipped_long: usize,
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F
        | 0x3040..=0x309F | 0x30A0..=0x30FF | 0x31F0..=0x31FF
        | 0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF)
}

/// CJK characters per `cjk_chars_per_token`, everything else per
/// `other_chars_per_token`, each rounded up. Rates below 1 count as 1.
pub(crate) fn estimate_tokens(text: &str, cjk_chars_per_token: u32, other_chars_per_token: u32) -> u64 {
    let mut cjk = 0u64;
    let mut other = 0u64;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk.div_ceil(u64::from(cjk_chars_per_token.max(1))) + other.div_ceil(u64::from(other_chars_per_token.max(1)))
}

fn title_of(path: &str) -> String {
    let last = path.rsplit('/').next().unwrap_or(path);
    for ext in [".markdown", ".mdx", ".md"] {
        if let Some(stem) = last.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    last.to_string()
}

pub(crate) fn select_candidates(
    ordered: &[&CanonicalHit],
    confidentiality: &HashMap<String, String>,
    mut read_block: impl FnMut(&CanonicalHit) -> Result<String, String>,
    limits: &CandidateLimits,
) -> Selection {
    let mut sel = Selection {
        pool_size: ordered.len().min(limits.pool),
        ..Selection::default()
    };
    let mut per_file: HashMap<&str, usize> = HashMap::new();
    for (position, hit) in ordered.iter().take(sel.pool_size).enumerate() {
        if sel.picked.len() >= limits.k {
            break;
        }
        if hit.pinned {
            sel.skipped_pinned += 1;
            continue;
        }
        if hit.level != "line" {
            sel.skipped_rollups += 1;
            continue;
        }
        if hit.indexed_text.is_empty() {
            sel.skipped_long += 1;
            continue;
        }
        if per_file.get(hit.path.as_str()).copied().unwrap_or(0) >= limits.per_file {
            continue;
        }
        match confidentiality.get(&hit.path).map(String::as_str) {
            Some("unknown") | Some("explicitly_public") => {}
            _ => {
                sel.skipped_confidential += 1;
                continue;
            }
        }
        let passage = match read_block(hit) {
            Ok(p) => p,
            Err(_) => {
                sel.skipped_stale += 1;
                continue;
            }
        };
        if passage.chars().count() > limits.max_block_chars {
            sel.skipped_long += 1;
            continue;
        }
        let title = title_of(&hit.path);
        let tokens = estimate_tokens(
            &format!("{}{}{}", title, hit.breadcrumb, passage),
            limits.cjk_chars_per_token,
            limits.other_chars_per_token,
        );
        if sel.estimated_tokens + tokens > limits.token_budget {
            break;
        }
        sel.estimated_tokens += tokens;
        *per_file.entry(hit.path.as_str()).or_insert(0) += 1;
        sel.picked.push(Candidate {
            position,
            result_id: hit.result_id.clone(),
            title,
            breadcrumb: hit.breadcrumb.clone(),
            passage,
        });
    }
    sel
}

/// `noul >= fit` is Fit, `noul <= unfit` is Unfit, between is Unsure.
pub(crate) fn tier(noul: f64, tiers: &TierParams) -> Tier {
    if noul >= tiers.fit {
        Tier::Fit
    } else if noul <= tiers.unfit {
        Tier::Unfit
    } else {
        Tier::Unsure
    }
}

/// New display order as a permutation of `0..len`. Inside each section (split at
/// `section_breaks`) the judged positions are stably sorted Fit, Unsure, Unfit
/// and written back into the slots the judged hits occupied; others stay put.
pub(crate) fn rerank(len: usize, judged: &[(usize, Tier)], section_breaks: &[usize]) -> Vec<usize> {
    let mut tiers: HashMap<usize, Tier> = HashMap::new();
    for &(i, t) in judged {
        if i < len {
            tiers.insert(i, t);
        }
    }
    let mut bounds: Vec<usize> = section_breaks.iter().copied().filter(|&b| b > 0 && b < len).collect();
    bounds.sort_unstable();
    bounds.dedup();
    let mut starts = vec![0];
    starts.extend(bounds);
    starts.push(len);
    let rank = |t: Tier| match t {
        Tier::Fit => 0,
        Tier::Unsure => 1,
        Tier::Unfit => 2,
    };
    let mut out: Vec<usize> = (0..len).collect();
    for w in starts.windows(2) {
        let slots: Vec<usize> = (w[0]..w[1]).filter(|i| tiers.contains_key(i)).collect();
        let mut items = slots.clone();
        items.sort_by_key(|i| rank(tiers[i]));
        for (slot, item) in slots.into_iter().zip(items) {
            out[slot] = item;
        }
    }
    out
}

pub(crate) fn top_ten_unfit(len: usize, judged: &[(usize, Tier)]) -> bool {
    let n = len.min(10);
    n > 0
        && (0..n).all(|i| judged.iter().any(|&(j, t)| j == i && t == Tier::Unfit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lookup_params::CandidateParams;
    use crate::smart_lookup::ArmFact;

    fn limits() -> CandidateLimits {
        CandidateParams::default().limits()
    }

    fn facts(hit_count: usize, pinned: bool, terms: &[&str], strict_hits: usize) -> RouteFacts {
        RouteFacts {
            hit_count,
            pinned,
            extracted_terms: terms.iter().map(|t| t.to_string()).collect(),
            arms: vec![ArmFact { kind: "strict".into(), terms: vec![], hit_count: strict_hits }],
        }
    }

    fn hit(id: &str, path: &str, level: &str, text: &str, pinned: bool) -> CanonicalHit {
        CanonicalHit {
            result_id: id.into(),
            path: path.into(),
            line: 1,
            line_end: 2,
            level: level.into(),
            indexed_text: text.into(),
            breadcrumb: "F".into(),
            pinned,
        }
    }

    #[test]
    fn route_follows_spec_5_3() {
        assert!(matches!(route(&facts(0, false, &["a", "b", "c"], 0), 2), Route::Repair));
        assert!(matches!(route(&facts(5, true, &["a", "b", "c"], 5), 2), Route::Skip(SkipReason::Pinned)));
        assert!(matches!(route(&facts(5, false, &["a", "b"], 3), 2), Route::Skip(SkipReason::FewTerms)));
        assert!(matches!(route(&facts(5, false, &["a", "b"], 0), 2), Route::Judge));
        assert!(matches!(route(&facts(5, false, &["a", "b", "c"], 3), 2), Route::Judge));
        // 0 terms is not the few-terms route; zero hits is read from hit_count, not arms.
        assert!(matches!(route(&facts(5, false, &[], 3), 2), Route::Judge));
        assert!(matches!(route(&facts(0, false, &["a"], 3), 2), Route::Repair));
        assert!(matches!(route(&facts(5, false, &["a"], 0), 2), Route::Judge));
    }

    #[test]
    fn selection_takes_only_current_public_line_blocks_two_per_file() {
        let hits = vec![
            hit("1", "a.md", "line", "x", false),
            hit("2", "a.md", "line", "x", false),
            hit("3", "a.md", "line", "x", false),
            hit("4", "b.md", "section", "x", false),
            hit("5", "c.md", "line", "x", false),
            hit("6", "d.md", "line", "x", false),
            hit("7", "e.md", "line", "x", false),
            hit("8", "f.md", "line", "x", false),
            hit("9", "g.md", "line", "x", true),
            hit("10", "h.md", "line", "x", false),
        ];
        let refs: Vec<&CanonicalHit> = hits.iter().collect();
        let mut conf = HashMap::new();
        for p in ["a.md", "b.md", "e.md", "f.md", "g.md", "h.md"] {
            conf.insert(p.to_string(), "unknown".to_string());
        }
        conf.insert("c.md".into(), "confidential".into());
        // d.md is absent from the index.
        let read = |h: &CanonicalHit| match h.path.as_str() {
            "e.md" => Err("stale".to_string()),
            "f.md" => Ok("字".repeat(1_201)),
            _ => Ok("passage".to_string()),
        };
        let s = select_candidates(&refs, &conf, read, &limits());
        // a.md, a.md, h.md
        assert_eq!(s.picked.iter().map(|c| c.result_id.as_str()).collect::<Vec<_>>(), ["1", "2", "10"]);
        assert_eq!(
            (s.skipped_rollups, s.skipped_confidential, s.skipped_stale, s.skipped_long, s.skipped_pinned),
            (1, 2, 1, 1, 1)
        );
        assert_eq!(s.picked[0].title, "a");
        assert_eq!(s.pool_size, 10);
    }

    #[test]
    fn selection_stops_at_k_and_at_the_token_budget() {
        let hits: Vec<CanonicalHit> = (0..60)
            .map(|i| hit(&format!("r{i}"), &format!("f{i}.md"), "line", "x", false))
            .collect();
        let refs: Vec<&CanonicalHit> = hits.iter().collect();
        let conf: HashMap<String, String> =
            hits.iter().map(|h| (h.path.clone(), "unknown".to_string())).collect();
        let small = select_candidates(&refs, &conf, |_| Ok("字".repeat(100)), &limits());
        let large = select_candidates(&refs, &conf, |_| Ok("字".repeat(1_000)), &limits());
        assert_eq!((small.picked.len(), small.pool_size), (10, 50));
        assert_eq!(large.picked.len(), 3);
        assert!(large.estimated_tokens <= 4_000);
    }

    #[test]
    fn estimate_counts_cjk_per_char_and_other_text_per_four() {
        assert_eq!(estimate_tokens("发布风险", 1, 4), 4);
        assert_eq!(estimate_tokens("abcdefgh", 1, 4), 2);
        assert_eq!(estimate_tokens("发布 risk", 1, 4), 2 + 2);
        assert_eq!(estimate_tokens("", 1, 4), 0);
    }

    #[test]
    fn tiers_use_the_spec_thresholds() {
        let t = TierParams::default();
        assert_eq!(
            [tier(0.7, &t), tier(0.69, &t), tier(0.31, &t), tier(0.3, &t)],
            [Tier::Fit, Tier::Unsure, Tier::Unsure, Tier::Unfit]
        );
    }

    #[test]
    fn routing_tokens_and_tiers_follow_the_params() {
        assert!(matches!(route(&facts(5, false, &["a", "b"], 3), 0), Route::Judge));
        assert!(matches!(route(&facts(5, false, &["a", "b", "c"], 3), 3), Route::Skip(SkipReason::FewTerms)));
        assert!(matches!(route(&facts(5, false, &["a", "b", "c", "d"], 3), 3), Route::Judge));
        assert_eq!(estimate_tokens("发布风险", 2, 4), 2);
        assert_eq!(estimate_tokens("abcdefgh", 1, 8), 1);
        assert_eq!(tier(0.65, &TierParams { fit: 0.6, unfit: 0.2 }), Tier::Fit);
        assert_eq!(tier(0.25, &TierParams { fit: 0.6, unfit: 0.2 }), Tier::Unsure);
        assert_eq!(tier(0.2, &TierParams { fit: 0.6, unfit: 0.2 }), Tier::Unfit);
    }

    #[test]
    fn selection_follows_the_candidate_params() {
        let hits: Vec<CanonicalHit> = (0..20)
            .map(|i| hit(&format!("r{i}"), &format!("f{}.md", i / 4), "line", "x", false))
            .collect();
        let refs: Vec<&CanonicalHit> = hits.iter().collect();
        let conf: HashMap<String, String> =
            hits.iter().map(|h| (h.path.clone(), "unknown".to_string())).collect();
        let narrow = CandidateParams { pool: 8, k: 3, per_file: 1, ..CandidateParams::default() }.limits();
        let s = select_candidates(&refs, &conf, |_| Ok("p".to_string()), &narrow);
        assert_eq!(s.pool_size, 8);
        assert_eq!(s.picked.iter().map(|c| c.result_id.as_str()).collect::<Vec<_>>(), ["r0", "r4"]);
        let wide = CandidateParams { k: 3, per_file: 4, ..CandidateParams::default() }.limits();
        assert_eq!(select_candidates(&refs, &conf, |_| Ok("p".to_string()), &wide).picked.len(), 3);
        // Two CJK characters per token halve the estimate; a tighter block limit refuses the block.
        let half = CandidateParams { cjk_chars_per_token: 2, ..CandidateParams::default() }.limits();
        let s = select_candidates(&refs[..1], &conf, |_| Ok("字".repeat(100)), &half);
        assert_eq!(s.estimated_tokens, estimate_tokens("f0F", 1, 4) + 50);
        let short = CandidateParams { max_block_chars: 100, ..CandidateParams::default() }.limits();
        assert_eq!(select_candidates(&refs[..1], &conf, |_| Ok("字".repeat(101)), &short).skipped_long, 1);
    }

    #[test]
    fn rerank_moves_only_judged_hits_inside_their_section() {
        assert_eq!(rerank(6, &[(1, Tier::Unfit), (3, Tier::Fit), (4, Tier::Unsure)], &[]), [0, 3, 2, 4, 1, 5]);
        assert_eq!(rerank(6, &[(1, Tier::Unfit), (2, Tier::Fit), (4, Tier::Unfit), (5, Tier::Fit)], &[4]), [0, 2, 1, 3, 5, 4]);
        assert_eq!(rerank(3, &[(0, Tier::Unfit), (2, Tier::Fit)], &[1]), [0, 1, 2]);
        assert_eq!(rerank(4, &[(0, Tier::Fit), (1, Tier::Fit)], &[]), [0, 1, 2, 3]);
    }

    #[test]
    fn top_ten_unfit_requires_every_leading_hit_judged_unfit() {
        let all: Vec<_> = (0..10).map(|i| (i, Tier::Unfit)).collect();
        assert!(top_ten_unfit(12, &all));
        assert!(!top_ten_unfit(12, &all[1..]));
        assert!(top_ten_unfit(4, &all[..4]));
        assert!(!top_ten_unfit(4, &[(0, Tier::Unfit), (1, Tier::Unsure), (2, Tier::Unfit), (3, Tier::Unfit)]));
        assert!(!top_ten_unfit(0, &[]));
    }
}
