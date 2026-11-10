//! Zero-model recognition of the single time phrase in a lookup question.
//!
//! The legacy planner asked a model to classify every time expression. The
//! host cannot tell whether "去年" constrains the document date or names an
//! event inside the content, so what this module finds is only ever used to
//! *group* results (`time_group`), never to filter them. Feasibility spec
//! §5.2; plan Task 2.
//!
//! The calendar parsing is a self-contained port of the planner's, with the
//! same inclusive-window semantics, so this module does not depend on `plan`.

use chrono::{Datelike, Days, Duration, Months, NaiveDate};

/// One host-resolvable time phrase and the inclusive document-date window it
/// names. `source_text` is the exact substring of the question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DetectedTime {
    pub source_text: String,
    pub after: NaiveDate,
    pub before: NaiveDate,
}

/// Every literal `anchor_range` understands. The scanner searches the question
/// for these; a test pins that each one resolves.
pub(super) const ANCHOR_SOURCES: &[&str] = &[
    "今天",
    "today",
    "昨天",
    "yesterday",
    "明天",
    "tomorrow",
    "本周",
    "这周",
    "这一周",
    "this week",
    "current week",
    "上周",
    "上一周",
    "last week",
    "previous week",
    "下周",
    "下一周",
    "next week",
    "本月",
    "这个月",
    "this month",
    "current month",
    "上月",
    "上个月",
    "last month",
    "previous month",
    "下月",
    "下个月",
    "next month",
    "本季度",
    "这个季度",
    "this quarter",
    "current quarter",
    "上季度",
    "上一季度",
    "last quarter",
    "previous quarter",
    "下季度",
    "下一季度",
    "next quarter",
    "今年",
    "this year",
    "current year",
    "去年",
    "上一年",
    "last year",
    "previous year",
    "明年",
    "下一年",
    "next year",
];

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
    let query = searchidx::query::parse(question);
    if query.after.is_some() || query.before.is_some() {
        return Ok(None);
    }

    let mut spans: Vec<(usize, usize)> = Vec::new();
    scan_anchors(question, &mut spans);
    scan_rolling(question, &mut spans);
    scan_iso_dates(question, &mut spans);
    scan_years(question, &mut spans);
    scan_quarters(question, &mut spans);
    spans.sort_unstable();
    spans.dedup();

    let survivors: Vec<(usize, usize)> = spans
        .iter()
        .copied()
        .filter(|&(start, end)| {
            !spans
                .iter()
                .any(|&(s, e)| (s, e) != (start, end) && s <= start && end <= e)
        })
        .collect();

    let [(start, end)] = survivors.as_slice() else {
        return Ok(None);
    };
    let source = &question[*start..*end];
    let Some((after, before)) = resolve_source(source, reference)? else {
        return Ok(None);
    };
    Ok(Some(DetectedTime {
        source_text: source.to_string(),
        after,
        before,
    }))
}

fn resolve_source(
    source: &str,
    reference: NaiveDate,
) -> Result<Option<(NaiveDate, NaiveDate)>, String> {
    if let Some(range) = anchor_range(source, reference)? {
        return Ok(Some(range));
    }
    if let Some((value, unit)) = parse_rolling_source(source) {
        if value == 0 {
            return Ok(None);
        }
        return rolling_window(value, unit, reference).map(Some);
    }
    if let Some(range) = parse_iso_date_source(source) {
        return Ok(Some(range));
    }
    if let Some(range) = parse_explicit_year_source(source) {
        return Ok(Some(range));
    }
    parse_explicit_quarter_source(source)
}

fn is_ascii_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
}

fn scan_anchors(question: &str, spans: &mut Vec<(usize, usize)>) {
    let lower = question.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for source in ANCHOR_SOURCES {
        let english = source.is_ascii();
        let mut from = 0;
        while let Some(found) = lower[from..].find(source) {
            let start = from + found;
            let end = start + source.len();
            from = start + 1;
            while !lower.is_char_boundary(from) {
                from += 1;
            }
            if english
                && ((start > 0 && is_ascii_word(bytes[start - 1]))
                    || (end < bytes.len() && is_ascii_word(bytes[end])))
            {
                continue;
            }
            spans.push((start, end));
        }
    }
}

fn scan_rolling(question: &str, spans: &mut Vec<(usize, usize)>) {
    let lower = question.to_ascii_lowercase();
    // Chinese: prefix, optional spaces, digits, optional spaces, unit.
    for prefix in ["最近", "过去", "近"] {
        for (start, _) in lower.match_indices(prefix) {
            let mut end = start + prefix.len();
            let rest = &lower[end..];
            let rest_trim = rest.trim_start();
            let after_space = end + (rest.len() - rest_trim.len());
            let digits = rest_trim.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                continue;
            }
            end = after_space + digits;
            let tail = &lower[end..];
            let tail_trim = tail.trim_start();
            let unit_start = end + (tail.len() - tail_trim.len());
            for unit in ["个月", "天", "周", "月", "年"] {
                if tail_trim.starts_with(unit) {
                    let unit_end = unit_start + unit.len();
                    if parse_rolling_source(&lower[start..unit_end]).is_some() {
                        spans.push((start, unit_end));
                    }
                    break;
                }
            }
        }
    }
    // English: last|past|recent N unit, as three whitespace-separated words.
    let bytes = lower.as_bytes();
    let mut words: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if is_ascii_word(bytes[i]) {
            let start = i;
            while i < bytes.len() && is_ascii_word(bytes[i]) {
                i += 1;
            }
            words.push((start, i));
        } else {
            i += 1;
        }
    }
    for window in words.windows(3) {
        let (start, end) = (window[0].0, window[2].1);
        let gaps_are_space = lower[window[0].1..window[1].0]
            .chars()
            .chain(lower[window[1].1..window[2].0].chars())
            .all(char::is_whitespace);
        if gaps_are_space && parse_rolling_source(&lower[start..end]).is_some() {
            spans.push((start, end));
        }
    }
}

fn scan_iso_dates(question: &str, spans: &mut Vec<(usize, usize)>) {
    let bytes = question.as_bytes();
    if bytes.len() < 10 {
        return;
    }
    for start in 0..=bytes.len() - 10 {
        let end = start + 10;
        if !question.is_char_boundary(start) || !question.is_char_boundary(end) {
            continue;
        }
        if (start > 0 && bytes[start - 1].is_ascii_digit())
            || (end < bytes.len() && bytes[end].is_ascii_digit())
        {
            continue;
        }
        if parse_iso_date_source(&question[start..end]).is_some() {
            spans.push((start, end));
        }
    }
}

fn scan_years(question: &str, spans: &mut Vec<(usize, usize)>) {
    let bytes = question.as_bytes();
    for (pos, _) in question.match_indices('年') {
        if pos < 4 || !bytes[pos - 4..pos].iter().all(u8::is_ascii_digit) {
            continue;
        }
        if pos >= 5 && bytes[pos - 5].is_ascii_digit() {
            continue;
        }
        let start = pos - 4;
        let end = pos + '年'.len_utf8();
        if parse_explicit_year_source(&question[start..end]).is_some() {
            spans.push((start, end));
        }
    }
}

fn scan_quarters(question: &str, spans: &mut Vec<(usize, usize)>) {
    let bytes = question.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start..].iter().take(4).all(u8::is_ascii_digit)
            || bytes.len() < start + 4
            || (start > 0 && bytes[start - 1].is_ascii_digit())
        {
            continue;
        }
        let mut pos = start + 4;
        if matches!(bytes.get(pos), Some(b'-') | Some(b' ')) {
            pos += 1;
        }
        if !matches!(bytes.get(pos), Some(b'q') | Some(b'Q')) {
            continue;
        }
        pos += 1;
        if !matches!(bytes.get(pos), Some(b'1'..=b'4')) {
            continue;
        }
        pos += 1;
        if bytes.get(pos).is_some_and(|byte| is_ascii_word(*byte)) {
            continue;
        }
        if matches!(parse_explicit_quarter_source(&question[start..pos]), Ok(Some(_))) {
            spans.push((start, pos));
        }
    }
}

// ---- calendar resolution, ported from plan.rs with identical semantics ----

#[derive(Debug, Clone, Copy)]
enum RollingUnit {
    Days,
    Weeks,
    Months,
    Years,
}

fn out_of_range(what: &str) -> String {
    format!("{what} is outside supported dates")
}

fn anchor_range(source: &str, reference: NaiveDate) -> Result<Option<(NaiveDate, NaiveDate)>, String> {
    let lowered = source.to_lowercase();
    let range = match lowered.as_str() {
        "今天" | "today" => day(reference, 0)?,
        "昨天" | "yesterday" => day(reference, -1)?,
        "明天" | "tomorrow" => day(reference, 1)?,
        "本周" | "这周" | "这一周" | "this week" | "current week" => calendar_week(reference, 0)?,
        "上周" | "上一周" | "last week" | "previous week" => calendar_week(reference, -1)?,
        "下周" | "下一周" | "next week" => calendar_week(reference, 1)?,
        "本月" | "这个月" | "this month" | "current month" => calendar_month_range(reference, 0)?,
        "上月" | "上个月" | "last month" | "previous month" => calendar_month_range(reference, -1)?,
        "下月" | "下个月" | "next month" => calendar_month_range(reference, 1)?,
        "本季度" | "这个季度" | "this quarter" | "current quarter" => {
            calendar_quarter(reference, 0)?
        }
        "上季度" | "上一季度" | "last quarter" | "previous quarter" => {
            calendar_quarter(reference, -1)?
        }
        "下季度" | "下一季度" | "next quarter" => calendar_quarter(reference, 1)?,
        "今年" | "this year" | "current year" => calendar_year(reference, 0)?,
        "去年" | "上一年" | "last year" | "previous year" => calendar_year(reference, -1)?,
        "明年" | "下一年" | "next year" => calendar_year(reference, 1)?,
        _ => return Ok(None),
    };
    Ok(Some(range))
}

fn day(reference: NaiveDate, offset: i64) -> Result<(NaiveDate, NaiveDate), String> {
    reference
        .checked_add_signed(Duration::days(offset))
        .map(|date| (date, date))
        .ok_or_else(|| out_of_range("calendar day"))
}

fn calendar_week(reference: NaiveDate, offset: i32) -> Result<(NaiveDate, NaiveDate), String> {
    let err = || out_of_range("calendar week");
    let monday = reference
        .checked_sub_signed(Duration::days(
            reference.weekday().num_days_from_monday().into(),
        ))
        .ok_or_else(err)?;
    let start = monday
        .checked_add_signed(Duration::weeks(offset.into()))
        .ok_or_else(err)?;
    let end = start.checked_add_days(Days::new(6)).ok_or_else(err)?;
    Ok((start, end))
}

fn calendar_month_range(
    reference: NaiveDate,
    offset: i32,
) -> Result<(NaiveDate, NaiveDate), String> {
    let err = || out_of_range("calendar month");
    let month_index = reference
        .year()
        .checked_mul(12)
        .and_then(|value| value.checked_add(reference.month0() as i32))
        .and_then(|value| value.checked_add(offset))
        .ok_or_else(err)?;
    let year = month_index.div_euclid(12);
    let month = month_index.rem_euclid(12) as u32 + 1;
    let start = NaiveDate::from_ymd_opt(year, month, 1).ok_or_else(err)?;
    let end = start
        .checked_add_months(Months::new(1))
        .and_then(|date| date.checked_sub_days(Days::new(1)))
        .ok_or_else(err)?;
    Ok((start, end))
}

fn calendar_quarter(reference: NaiveDate, offset: i32) -> Result<(NaiveDate, NaiveDate), String> {
    let err = || out_of_range("calendar quarter");
    let quarter_index = reference
        .year()
        .checked_mul(4)
        .and_then(|value| value.checked_add((reference.month0() / 3) as i32))
        .and_then(|value| value.checked_add(offset))
        .ok_or_else(err)?;
    let year = quarter_index.div_euclid(4);
    let month = quarter_index.rem_euclid(4) as u32 * 3 + 1;
    let start = NaiveDate::from_ymd_opt(year, month, 1).ok_or_else(err)?;
    let end = start
        .checked_add_months(Months::new(3))
        .and_then(|date| date.checked_sub_days(Days::new(1)))
        .ok_or_else(err)?;
    Ok((start, end))
}

fn calendar_year(reference: NaiveDate, offset: i32) -> Result<(NaiveDate, NaiveDate), String> {
    let err = || out_of_range("year");
    let year = reference.year().checked_add(offset).ok_or_else(err)?;
    Ok((
        NaiveDate::from_ymd_opt(year, 1, 1).ok_or_else(err)?,
        NaiveDate::from_ymd_opt(year, 12, 31).ok_or_else(err)?,
    ))
}

fn rolling_window(
    value: u32,
    unit: RollingUnit,
    reference: NaiveDate,
) -> Result<(NaiveDate, NaiveDate), String> {
    let start = match unit {
        RollingUnit::Days => reference.checked_sub_days(Days::new(u64::from(value - 1))),
        RollingUnit::Weeks => reference.checked_sub_days(Days::new(
            u64::from(value)
                .checked_mul(7)
                .and_then(|days| days.checked_sub(1))
                .ok_or_else(|| "rolling week count overflowed".to_string())?,
        )),
        RollingUnit::Months => reference
            .checked_sub_months(Months::new(value))
            .and_then(|date| date.checked_add_days(Days::new(1))),
        RollingUnit::Years => reference
            .checked_sub_months(Months::new(
                value
                    .checked_mul(12)
                    .ok_or_else(|| "rolling year count overflowed".to_string())?,
            ))
            .and_then(|date| date.checked_add_days(Days::new(1))),
    }
    .ok_or_else(|| out_of_range("rolling window"))?;
    Ok((start, reference))
}

fn parse_rolling_source(source: &str) -> Option<(u32, RollingUnit)> {
    let source = source.trim().to_lowercase();
    for prefix in ["最近", "过去", "近"] {
        if let Some(tail) = source.strip_prefix(prefix) {
            let tail = tail.trim_start();
            let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                continue;
            }
            let value = tail[..digits].parse().ok()?;
            let unit = match tail[digits..].trim_start() {
                "天" => RollingUnit::Days,
                "周" => RollingUnit::Weeks,
                "个月" | "月" => RollingUnit::Months,
                "年" => RollingUnit::Years,
                _ => continue,
            };
            return Some((value, unit));
        }
    }
    let words = source.split_whitespace().collect::<Vec<_>>();
    if words.len() != 3 || !matches!(words[0], "last" | "past" | "recent") {
        return None;
    }
    let value = words[1].parse().ok()?;
    let unit = match words[2] {
        "day" | "days" => RollingUnit::Days,
        "week" | "weeks" => RollingUnit::Weeks,
        "month" | "months" => RollingUnit::Months,
        "year" | "years" => RollingUnit::Years,
        _ => return None,
    };
    Some((value, unit))
}

/// A single `YYYY-MM-DD` date and nothing else.
fn parse_iso_date_source(source: &str) -> Option<(NaiveDate, NaiveDate)> {
    let text = source.trim();
    let bytes = text.as_bytes();
    let well_formed = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if !well_formed {
        return None;
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .map(|date| (date, date))
}

fn parse_explicit_year_source(source: &str) -> Option<(NaiveDate, NaiveDate)> {
    let value = source.trim().strip_suffix('年').unwrap_or(source.trim());
    if value.len() != 4 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year = value.parse().ok()?;
    Some((
        NaiveDate::from_ymd_opt(year, 1, 1)?,
        NaiveDate::from_ymd_opt(year, 12, 31)?,
    ))
}

fn parse_explicit_quarter_source(
    source: &str,
) -> Result<Option<(NaiveDate, NaiveDate)>, String> {
    let source = source.trim().to_lowercase();
    let bytes = source.as_bytes();
    if bytes.len() < 6 || !bytes[..4].iter().all(u8::is_ascii_digit) {
        return Ok(None);
    }
    let year = &source[..4];
    let mut suffix = source[4..].trim_start();
    if let Some(value) = suffix.strip_prefix('-') {
        suffix = value.trim_start();
    }
    let Some(quarter) = suffix.strip_prefix('q') else {
        return Ok(None);
    };
    if quarter.len() != 1 || !quarter.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    let (Ok(year), Ok(quarter)) = (year.parse::<i32>(), quarter.parse::<u32>()) else {
        return Ok(None);
    };
    if !(1..=4).contains(&quarter) {
        return Ok(None);
    }
    let err = || out_of_range("quarter date");
    let start = NaiveDate::from_ymd_opt(year, (quarter - 1) * 3 + 1, 1).ok_or_else(err)?;
    let end = start
        .checked_add_months(Months::new(3))
        .and_then(|next| next.checked_sub_days(Days::new(1)))
        .ok_or_else(err)?;
    Ok(Some((start, end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).unwrap()
    }

    #[test]
    fn every_anchor_source_literal_resolves() {
        let reference = d(2026, 11, 10);
        for source in ANCHOR_SOURCES {
            assert!(
                detect_time_phrase(&format!("关于 {source} 的记录"), reference)
                    .unwrap()
                    .is_some(),
                "{source}"
            );
        }
    }

    #[test]
    fn rolling_windows_include_today_and_count_whole_days() {
        let today = d(2026, 11, 10);
        let got = |q: &str| detect_time_phrase(q, today).unwrap().map(|t| (t.after, t.before));
        assert_eq!(got("最近1天的日志"), Some((d(2026, 11, 10), d(2026, 11, 10))));
        assert_eq!(got("过去2周的周报"), Some((d(2026, 10, 28), d(2026, 11, 10))));
        assert_eq!(got("last 3 months of notes"), Some((d(2026, 8, 11), d(2026, 11, 10))));
    }

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
