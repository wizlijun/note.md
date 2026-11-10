//! Soft time grouping for a lookup whose question names a time phrase.
//!
//! A detected phrase never removes a hit. The lookup runs twice — once with
//! the phrase stripped and the window appended as `after:` / `before:`, once
//! with the question untouched — and the two answers are concatenated: hits
//! inside the window first, every other hit after them. Feasibility spec
//! §5.2; plan Task 2. Only the evaluation calls this until the grouping
//! pre-gate (spec §9.3) passes.
//!
//! SKELETON: signatures and tests are final; the bodies are not written yet.

use super::smart::SmartHitDto;
use super::time_phrase::DetectedTime;

/// The question with the first occurrence of the phrase removed, whitespace
/// collapsed and trimmed, and ` after:YYYY-MM-DD before:YYYY-MM-DD` appended.
/// `smart::compile_query` already carries both filters into every arm.
pub(super) fn time_scoped_query(question: &str, time: &DetectedTime) -> String {
    let _ = (question, time);
    todo!("plan Task 2 Step 6")
}

/// The grouped answer and how many of its leading hits are inside the window.
pub(super) struct TimeGrouped {
    pub hits: Vec<SmartHitDto>,
    pub in_window: usize,
}

/// `in_window` first (cut to `limit`), then the `unfiltered` hits whose
/// `(path, line, line_end)` is not already listed, in their original order,
/// until `limit` hits are held. Nothing is dropped for being outside the
/// window and nothing appears twice.
pub(super) fn group_by_time(
    in_window: Vec<SmartHitDto>,
    unfiltered: Vec<SmartHitDto>,
    limit: usize,
) -> TimeGrouped {
    let _ = (in_window, unfiltered, limit);
    todo!("plan Task 2 Step 6")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use searchidx::Hit;
    use std::path::Path;

    fn dto(path: &str) -> SmartHitDto {
        let hit = Hit {
            path: path.to_string(),
            line: 1,
            line_end: 1,
            text: "Q3Budget launch budget release risk details".to_string(),
            breadcrumb: path.to_string(),
            level: "line".to_string(),
            score: 1.0,
            doc_date: None,
            agent_by: None,
            human_verified: false,
            origin: searchidx::Origin::Unlabeled,
            concept_type: None,
            pinned: false,
            attention_minutes: 0.0,
        };
        SmartHitDto {
            hit: super::super::hit_to_dto(hit, Path::new("/vault")),
            fused_score: 1.0,
            relevance_reasons: Vec::new(),
            matched_queries: Vec::new(),
            result_id: None,
        }
    }

    fn paths(grouped: &TimeGrouped) -> Vec<String> {
        grouped.hits.iter().map(|hit| hit.hit.path.clone()).collect()
    }

    #[test]
    fn scoped_query_strips_the_phrase_and_appends_the_inclusive_range() {
        let time = DetectedTime {
            source_text: "上个月".into(),
            after: NaiveDate::from_ymd_opt(2026, 10, 1).unwrap(),
            before: NaiveDate::from_ymd_opt(2026, 10, 31).unwrap(),
        };
        assert_eq!(
            time_scoped_query("上个月关于发布延期的讨论", &time),
            "关于发布延期的讨论 after:2026-10-01 before:2026-10-31"
        );
        assert_eq!(
            time_scoped_query("pricing  notes 上个月", &time),
            "pricing notes after:2026-10-01 before:2026-10-31"
        );
    }

    #[test]
    fn grouping_puts_in_window_hits_first_and_never_drops_or_duplicates() {
        let grouped = group_by_time(
            vec![dto("b.md"), dto("d.md")],
            vec![dto("a.md"), dto("b.md"), dto("c.md"), dto("d.md")],
            10,
        );
        assert_eq!(paths(&grouped), ["b.md", "d.md", "a.md", "c.md"]);
        assert_eq!(grouped.in_window, 2);

        let capped = group_by_time(
            vec![dto("b.md"), dto("d.md")],
            vec![dto("a.md"), dto("b.md"), dto("c.md")],
            3,
        );
        assert_eq!(paths(&capped), ["b.md", "d.md", "a.md"]);
        assert_eq!(capped.in_window, 2);
    }
}
