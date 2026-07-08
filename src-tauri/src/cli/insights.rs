//! `mdedit reading-insights report` — generate the owner reading digest from the
//! Vault's analytics files, entirely in Rust (no webview, no Node). Mirrors
//! `scripts/insights-report-core.mjs`.

use chrono::{Datelike, Duration, Local, NaiveDate};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::ExitCode;

#[derive(Debug, Clone)]
pub enum InsightsCmd {
    Report {
        vault: Option<String>,
        date: Option<String>,
        from: Option<String>,
        to: Option<String>,
        stdout: bool,
    },
}

#[derive(Default, Clone)]
struct Counters {
    read_ms: i64,
    edit_ms: i64,
    edit_sessions: i64,
    mark_ops: i64,
}

const USAGE: &str = "usage: mdedit reading-insights report --vault <path> \
[--date yesterday|today|7d|30d|month] [--from YYYY-MM-DD --to YYYY-MM-DD] [--stdout]";

pub fn run(cmd: InsightsCmd) -> ExitCode {
    match cmd {
        InsightsCmd::Report { vault, date, from, to, stdout } => report(vault, date, from, to, stdout),
    }
}

fn report(
    vault_opt: Option<String>,
    date: Option<String>,
    from: Option<String>,
    to: Option<String>,
    stdout: bool,
) -> ExitCode {
    let vault = match vault_opt.or_else(|| std::env::var("MDEDITOR_VAULT").ok()) {
        Some(v) => v,
        None => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };

    let (from_day, to_day) = match (from, to) {
        (Some(f), Some(t)) => (f, t),
        _ => resolve_preset(date.as_deref().unwrap_or("yesterday")),
    };

    // docKey -> day -> summed counters (across every device file).
    let mut merged: BTreeMap<String, BTreeMap<String, Counters>> = BTreeMap::new();
    let dir = Path::new(&vault).join(".mdeditor").join("analytics");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let day = match day_from_filename(&name) {
                Some(d) => d,
                None => continue,
            };
            let content = match std::fs::read_to_string(e.path()) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let v: Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(docs) = v.get("docs").and_then(|d| d.as_object()) {
                for (doc_key, c) in docs {
                    let bucket = merged
                        .entry(doc_key.clone())
                        .or_default()
                        .entry(day.clone())
                        .or_default();
                    bucket.read_ms += num(c, "read_ms");
                    bucket.edit_ms += num(c, "edit_ms");
                    bucket.edit_sessions += num(c, "edit_sessions");
                    bucket.mark_ops += num(c, "mark_ops");
                }
            }
        }
    }

    // Aggregate each doc over the inclusive [from_day, to_day] range (day keys
    // are YYYY-MM-DD → lexicographic order == calendar order).
    let mut rows: Vec<(String, Counters)> = Vec::new();
    for (doc_key, days) in &merged {
        let mut acc = Counters::default();
        let mut any = false;
        for (day, c) in days {
            if day.as_str() < from_day.as_str() || day.as_str() > to_day.as_str() {
                continue;
            }
            any = true;
            acc.read_ms += c.read_ms;
            acc.edit_ms += c.edit_ms;
            acc.edit_sessions += c.edit_sessions;
            acc.mark_ops += c.mark_ops;
        }
        if any {
            rows.push((doc_key.clone(), acc));
        }
    }
    rows.sort_by(|a, b| (b.1.read_ms + b.1.edit_ms).cmp(&(a.1.read_ms + a.1.edit_ms)));

    let md = render(&rows, &from_day, &to_day);

    if stdout {
        print!("{md}");
        return ExitCode::from(0);
    }
    let stat_dir = Path::new(&vault).join("stat");
    if let Err(e) = std::fs::create_dir_all(&stat_dir) {
        eprintln!("mdedit: failed to create stat dir: {e}");
        return ExitCode::from(1);
    }
    let fname = if from_day == to_day {
        format!("{from_day}-daily-stat.md")
    } else {
        format!("{from_day}_{to_day}-stat.md")
    };
    let out = stat_dir.join(&fname);
    match std::fs::write(&out, &md) {
        Ok(()) => {
            println!("wrote {}", out.display());
            ExitCode::from(0)
        }
        Err(e) => {
            eprintln!("mdedit: failed to write report: {e}");
            ExitCode::from(1)
        }
    }
}

fn num(c: &Value, key: &str) -> i64 {
    c.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// `<YYYY-MM-DD>.<device>.json` → the day part (validated), else None.
fn day_from_filename(name: &str) -> Option<String> {
    if !name.ends_with(".json") {
        return None;
    }
    let day = name.get(0..10)?;
    let b = day.as_bytes();
    if b.len() == 10
        && name.as_bytes().get(10) == Some(&b'.')
        && b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[2].is_ascii_digit() && b[3].is_ascii_digit()
        && b[4] == b'-' && b[5].is_ascii_digit() && b[6].is_ascii_digit()
        && b[7] == b'-' && b[8].is_ascii_digit() && b[9].is_ascii_digit()
    {
        Some(day.to_string())
    } else {
        None
    }
}

fn resolve_preset(preset: &str) -> (String, String) {
    let today = Local::now().date_naive();
    let f = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    match preset {
        "today" => (f(today), f(today)),
        "7d" => (f(today - Duration::days(6)), f(today)),
        "30d" => (f(today - Duration::days(29)), f(today)),
        "month" => (f(today.with_day(1).unwrap_or(today)), f(today)),
        // "yesterday" and anything unrecognized default to yesterday.
        _ => {
            let y = today - Duration::days(1);
            (f(y), f(y))
        }
    }
}

fn fmt_duration(ms: i64) -> String {
    let s = ((ms as f64) / 1000.0).round() as i64;
    if s < 60 {
        return format!("{s}s");
    }
    let m = s / 60;
    if m < 60 {
        return format!("{}m {}s", m, s % 60);
    }
    format!("{}h {}m", m / 60, m % 60)
}

fn label(doc_key: &str) -> String {
    let p = doc_key
        .strip_prefix("rel:")
        .or_else(|| doc_key.strip_prefix("abs:"))
        .unwrap_or(doc_key);
    match p.rfind('/') {
        Some(i) => p[i + 1..].to_string(),
        None => p.to_string(),
    }
}

fn render(rows: &[(String, Counters)], from_day: &str, to_day: &str) -> String {
    let range = if from_day == to_day {
        from_day.to_string()
    } else {
        format!("{from_day} → {to_day}")
    };
    if rows.is_empty() {
        return format!("# 阅读数据 · {range}\n\n此区间没有阅读或编辑记录。\n");
    }
    let total_engage: i64 = rows.iter().map(|(_, c)| c.read_ms + c.edit_ms).sum();
    let top = label(&rows[0].0);
    let summary = format!(
        "本区间你在 {} 篇文档上共停留 {}，投入最多的是《{}》。",
        rows.len(),
        fmt_duration(total_engage),
        top
    );
    let mut body = String::new();
    for (doc_key, c) in rows {
        body.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            label(doc_key),
            fmt_duration(c.read_ms),
            fmt_duration(c.edit_ms),
            c.edit_sessions,
            c.mark_ops
        ));
    }
    let total_read: i64 = rows.iter().map(|(_, c)| c.read_ms).sum();
    let total_edit: i64 = rows.iter().map(|(_, c)| c.edit_ms).sum();
    let total_sessions: i64 = rows.iter().map(|(_, c)| c.edit_sessions).sum();
    let total_marks: i64 = rows.iter().map(|(_, c)| c.mark_ops).sum();
    format!(
        "# 阅读数据 · {range}\n\n{summary}\n\n\
| 文档 | 阅读 | 编辑 | 编辑段 | 标注 |\n|---|---|---|---|---|\n{body}\
| **合计** | {} | {} | {} | {} |\n\n<sub>由 M↓ Reading Insights CLI 生成</sub>\n",
        fmt_duration(total_read),
        fmt_duration(total_edit),
        total_sessions,
        total_marks
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(read: i64, edit: i64, sess: i64, marks: i64) -> Counters {
        Counters { read_ms: read, edit_ms: edit, edit_sessions: sess, mark_ops: marks }
    }

    #[test]
    fn day_from_filename_parses_valid_and_rejects_others() {
        assert_eq!(day_from_filename("2026-07-08.DEV1.json").as_deref(), Some("2026-07-08"));
        assert_eq!(day_from_filename("notaday.json"), None);
        assert_eq!(day_from_filename("2026-07-08.DEV1.txt"), None);
    }

    #[test]
    fn label_strips_prefix_and_dir() {
        assert_eq!(label("rel:notes/a.md"), "a.md");
        assert_eq!(label("abs:/tmp/b.md"), "b.md");
    }

    #[test]
    fn fmt_duration_scales() {
        assert_eq!(fmt_duration(5000), "5s");
        assert_eq!(fmt_duration(150000), "2m 30s");
        assert_eq!(fmt_duration(3_720_000), "1h 2m");
    }

    #[test]
    fn render_has_heading_doc_and_total() {
        let rows = vec![("rel:a.md".to_string(), c(120000, 60000, 2, 3))];
        let md = render(&rows, "2026-07-08", "2026-07-08");
        assert!(md.contains("# 阅读数据"));
        assert!(md.contains("a.md"));
        assert!(md.contains("合计"));
        assert!(md.contains("2m 0s")); // 120000ms read
    }

    #[test]
    fn render_empty() {
        let md = render(&[], "2026-07-08", "2026-07-08");
        assert!(md.contains("没有"));
    }
}
