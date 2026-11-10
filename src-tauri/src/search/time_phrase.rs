//! Zero-model recognition of the single time phrase in a lookup question.
//!
//! The legacy planner asked a model to classify every time expression. The
//! host cannot tell whether "去年" constrains the document date or names an
//! event inside the content, so what this module finds is only ever used to
//! *group* results (`time_group`), never to filter them. Feasibility spec
//! §5.2; plan Task 2.
//!
//! SKELETON: the signature and the behaviour tests are final; the body is not
//! written yet. The tests below are expected to fail until it is.

use chrono::NaiveDate;

/// One host-resolvable time phrase and the inclusive document-date window it
/// names. `source_text` is the exact substring of the question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DetectedTime {
    pub source_text: String,
    pub after: NaiveDate,
    pub before: NaiveDate,
}

/// Find the one time phrase the host can resolve without a model.
///
/// Rules (plan Task 2):
///
/// 1. A question that already carries an explicit `after:` / `before:` filter
///    yields `None` — explicit filters stay the only hard time constraint.
/// 2. Candidates are collected by five scanners, each resolved by the parser
///    that already exists for planner validation:
///    - anchors (今天 / 上周 / last month / … — Chinese by substring; English
///      case-insensitive and not adjacent to an ASCII letter or digit),
///    - rolling windows (最近|过去|近 + N + 天|周|个月|月|年; last|past|recent N unit),
///    - ISO dates (`YYYY-MM-DD`),
///    - years (four digits immediately followed by `年`),
///    - quarters (four digits, optional `-` or space, `Q`/`q`, `1`–`4`).
/// 3. A candidate fully contained in a longer one is dropped.
/// 4. Exactly one survivor is returned; zero or several yield `None` — several
///    time expressions are never guessed between.
pub(super) fn detect_time_phrase(
    question: &str,
    reference: NaiveDate,
) -> Result<Option<DetectedTime>, String> {
    let _ = (question, reference);
    todo!("plan Task 2 Step 3: scan, resolve with the existing plan.rs parsers, keep exactly one")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    // The plan also pins `every_anchor_source_literal_resolves`. It belongs
    // with `ANCHOR_SOURCES`, which is introduced together with the body.

    #[test]
    fn detects_exactly_one_host_resolvable_time_phrase() {
        let today = d(2026, 11, 10); // a Tuesday
        let got = |question: &str| detect_time_phrase(question, today).unwrap();
        assert_eq!(
            got("上个月关于发布延期的讨论"),
            Some(DetectedTime {
                source_text: "上个月".into(),
                after: d(2026, 10, 1),
                before: d(2026, 10, 31),
            })
        );
        assert_eq!(
            got("最近7天的会议纪要"),
            Some(DetectedTime {
                source_text: "最近7天".into(),
                after: d(2026, 11, 4),
                before: d(2026, 11, 10),
            })
        );
        assert_eq!(
            got("2025年的年度总结"),
            Some(DetectedTime {
                source_text: "2025年".into(),
                after: d(2025, 1, 1),
                before: d(2025, 12, 31),
            })
        );
        assert_eq!(
            got("notes from Last Week about pricing").map(|time| (time.after, time.before)),
            Some((d(2026, 11, 2), d(2026, 11, 8)))
        );
        assert_eq!(
            got("2026-Q3 roadmap").map(|time| (time.after, time.before)),
            Some((d(2026, 7, 1), d(2026, 9, 30)))
        );
        // A longer phrase swallows the shorter one it contains; that is one
        // time expression, not two.
        assert_eq!(
            got("最近3年的体检报告").map(|time| time.source_text),
            Some("最近3年".to_string())
        );
    }

    #[test]
    fn declines_when_time_is_absent_ambiguous_or_already_explicit() {
        let today = d(2026, 11, 10);
        for question in [
            "发布延期的原因",
            "上周和本月的周报",
            "after:2026-01-01 上周的周报",
            "todays standup notes",
        ] {
            assert_eq!(
                detect_time_phrase(question, today).unwrap(),
                None,
                "{question}"
            );
        }
    }
}
