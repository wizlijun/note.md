//! Pure functions: routing, candidate selection, token estimate, tiering and
//! in-position rerank.

use std::collections::HashMap;

use super::{SkipReason, Tier};
use crate::smart_lookup::{CanonicalHit, RouteFacts};

pub(crate) enum Route {
    Repair,
    Skip(SkipReason),
    Judge,
}

/// Spec §5.3. Zero hits is decided on the merged `hit_count`, never by summing
/// arm counts. "Few terms" means 1..=2 extracted terms (0 terms is not it) with
/// a strict arm that found something.
pub(crate) fn route(facts: &RouteFacts) -> Route {
    if facts.hit_count == 0 {
        return Route::Repair;
    }
    if facts.pinned {
        return Route::Skip(SkipReason::Pinned);
    }
    let few = (1..=2).contains(&facts.extracted_terms.len());
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
}

pub(crate) const DEFAULT_LIMITS: CandidateLimits = CandidateLimits {
    pool: 50,
    k: 10,
    per_file: 2,
    max_block_chars: 1_200,
    token_budget: 4_000,
};

pub(crate) struct Candidate {
    pub position: usize,
    pub result_id: String,
    pub path: String,
    pub line: u32,
    pub line_end: u32,
    pub title: String,
    pub breadcrumb: String,
    pub passage: String,
    #[expect(dead_code, reason = "no reader yet; Selection.estimated_tokens carries the sum")]
    pub tokens: u64,
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

pub(crate) fn estimate_tokens(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut other = 0u64;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other.div_ceil(4)
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
        let tokens = estimate_tokens(&format!("{}{}{}", title, hit.breadcrumb, passage));
        if sel.estimated_tokens + tokens > limits.token_budget {
            break;
        }
        sel.estimated_tokens += tokens;
        *per_file.entry(hit.path.as_str()).or_insert(0) += 1;
        sel.picked.push(Candidate {
            position,
            result_id: hit.result_id.clone(),
            path: hit.path.clone(),
            line: hit.line,
            line_end: hit.line_end,
            title,
            breadcrumb: hit.breadcrumb.clone(),
            passage,
            tokens,
        });
    }
    sel
}

pub(crate) fn tier(noul: f64) -> Tier {
    if noul >= 0.7 {
        Tier::Fit
    } else if noul <= 0.3 {
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
    use crate::smart_lookup::ArmFact;

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
        assert!(matches!(route(&facts(0, false, &["a", "b", "c"], 0)), Route::Repair));
        assert!(matches!(route(&facts(5, true, &["a", "b", "c"], 5)), Route::Skip(SkipReason::Pinned)));
        assert!(matches!(route(&facts(5, false, &["a", "b"], 3)), Route::Skip(SkipReason::FewTerms)));
        assert!(matches!(route(&facts(5, false, &["a", "b"], 0)), Route::Judge));
        assert!(matches!(route(&facts(5, false, &["a", "b", "c"], 3)), Route::Judge));
        // 0 terms is not the few-terms route; zero hits is read from hit_count, not arms.
        assert!(matches!(route(&facts(5, false, &[], 3)), Route::Judge));
        assert!(matches!(route(&facts(0, false, &["a"], 3)), Route::Repair));
        assert!(matches!(route(&facts(5, false, &["a"], 0)), Route::Judge));
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
        let s = select_candidates(&refs, &conf, read, &DEFAULT_LIMITS);
        assert_eq!(s.picked.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["a.md", "a.md", "h.md"]);
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
        let small = select_candidates(&refs, &conf, |_| Ok("字".repeat(100)), &DEFAULT_LIMITS);
        let large = select_candidates(&refs, &conf, |_| Ok("字".repeat(1_000)), &DEFAULT_LIMITS);
        assert_eq!((small.picked.len(), small.pool_size), (10, 50));
        assert_eq!(large.picked.len(), 3);
        assert!(large.estimated_tokens <= 4_000);
    }

    #[test]
    fn estimate_counts_cjk_per_char_and_other_text_per_four() {
        assert_eq!(estimate_tokens("发布风险"), 4);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("发布 risk"), 2 + 2);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn tiers_use_the_spec_thresholds() {
        assert_eq!([tier(0.7), tier(0.69), tier(0.31), tier(0.3)], [Tier::Fit, Tier::Unsure, Tier::Unsure, Tier::Unfit]);
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
