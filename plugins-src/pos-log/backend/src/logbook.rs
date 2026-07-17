//! 纯函数层：行格式化 / 地址比较 / 追加决策。无 IO，全部可单测。

/// 反查得到的一个地点。空串 = 该段缺失。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub country: String,
    pub province: String,
    pub city: String,
    pub poi: String,
}

/// `国家-省份-城市 POI`；空段省略，连字符只连非空段；全空 → 空串（调用方按取位失败跳过）。
pub fn format_address(p: &Place) -> String {
    let geo: Vec<&str> = [p.country.as_str(), p.province.as_str(), p.city.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let geo = geo.join("-");
    match (geo.is_empty(), p.poi.is_empty()) {
        (true, true) => String::new(),
        (true, false) => p.poi.clone(),
        (false, true) => geo,
        (false, false) => format!("{geo} {}", p.poi),
    }
}

/// `- YYYY-MM-DD HH:mm <addr>`（本地时间由调用方传入，便于测试）。
pub fn format_line(ts: &chrono::DateTime<chrono::Local>, addr: &str) -> String {
    format!("- {} {addr}", ts.format("%Y-%m-%d %H:%M"))
}

/// 当天文件的 vault 相对路径 `pos/YYYY-MM-DD-pos.md`。
pub fn file_rel_path(ts: &chrono::DateTime<chrono::Local>) -> String {
    format!("pos/{}-pos.md", ts.format("%Y-%m-%d"))
}

/// 现有文件内容里最后一条记录的地址部分（剥掉 `- YYYY-MM-DD HH:mm ` 前缀）。
/// 无行/行不合形 → None（调用方视为需要追加）。
pub fn last_address(content: &str) -> Option<String> {
    let line = content.lines().rev().find(|l| !l.trim().is_empty())?;
    let rest = line.strip_prefix("- ")?;
    // 时间戳形：`YYYY-MM-DD HH:mm ` = 17 字节纯 ASCII；地址在其后（可含多字节
    // UTF-8，split_at 落在 ASCII 边界安全）。
    if rest.len() < 17 || !rest.is_char_boundary(17) {
        return None;
    }
    let (stamp, addr) = rest.split_at(17);
    let bytes = stamp.as_bytes();
    let shape_ok = bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b' '
        && bytes[13] == b':'
        && bytes[16] == b' '
        && stamp.chars().enumerate().all(|(i, c)| match i {
            4 | 7 | 10 | 13 | 16 => true,
            _ => c.is_ascii_digit(),
        });
    if !shape_ok || addr.is_empty() {
        return None;
    }
    Some(addr.to_string())
}

/// 追加决策：
/// - `existing = None`（当天文件不存在）→ 无条件基线：`Some(line + "\n")`
/// - 最后一条地址 == addr → `None`（跳过）
/// - 否则 → `Some(existing 补齐尾部换行 + line + "\n")`
pub fn decide(existing: Option<&str>, line: &str, addr: &str) -> Option<String> {
    match existing {
        None => Some(format!("{line}\n")),
        Some(c) if c.trim().is_empty() => Some(format!("{line}\n")),
        Some(c) => {
            if last_address(c).as_deref() == Some(addr) {
                return None;
            }
            let mut out = c.to_string();
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(line);
            out.push('\n');
            Some(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn place(c: &str, p: &str, ci: &str, poi: &str) -> Place {
        Place { country: c.into(), province: p.into(), city: ci.into(), poi: poi.into() }
    }
    fn ts() -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(2026, 7, 18, 14, 30, 0).unwrap()
    }

    #[test]
    fn address_full() {
        assert_eq!(
            format_address(&place("中国", "湖北", "武汉", "光谷软件园")),
            "中国-湖北-武汉 光谷软件园"
        );
    }
    #[test]
    fn address_missing_province() {
        assert_eq!(format_address(&place("中国", "", "武汉", "光谷软件园")), "中国-武汉 光谷软件园");
    }
    #[test]
    fn address_no_poi() {
        assert_eq!(format_address(&place("中国", "湖北", "武汉", "")), "中国-湖北-武汉");
    }
    #[test]
    fn address_poi_only() {
        assert_eq!(format_address(&place("", "", "", "光谷软件园")), "光谷软件园");
    }
    #[test]
    fn address_all_empty() {
        assert_eq!(format_address(&place("", "", "", "")), "");
    }
    #[test]
    fn line_format() {
        assert_eq!(
            format_line(&ts(), "中国-湖北-武汉 光谷软件园"),
            "- 2026-07-18 14:30 中国-湖北-武汉 光谷软件园"
        );
    }
    #[test]
    fn rel_path() {
        assert_eq!(file_rel_path(&ts()), "pos/2026-07-18-pos.md");
    }
    #[test]
    fn last_address_of_normal_file() {
        let c = "- 2026-07-18 09:00 中国-湖北-武汉 A\n- 2026-07-18 12:00 中国-湖北-武汉 B\n";
        assert_eq!(last_address(c).as_deref(), Some("中国-湖北-武汉 B"));
    }
    #[test]
    fn last_address_skips_trailing_blank_lines() {
        let c = "- 2026-07-18 09:00 X\n\n";
        assert_eq!(last_address(c).as_deref(), Some("X"));
    }
    #[test]
    fn last_address_malformed_line_is_none() {
        assert_eq!(last_address("手写的一行\n"), None);
        assert_eq!(last_address(""), None);
        assert_eq!(last_address("- 短\n"), None);
    }
    #[test]
    fn decide_baseline_when_no_file() {
        assert_eq!(
            decide(None, "- 2026-07-18 14:30 X", "X").as_deref(),
            Some("- 2026-07-18 14:30 X\n")
        );
    }
    #[test]
    fn decide_skip_when_same() {
        let c = "- 2026-07-18 09:00 X\n";
        assert_eq!(decide(Some(c), "- 2026-07-18 14:30 X", "X"), None);
    }
    #[test]
    fn decide_append_when_changed() {
        let c = "- 2026-07-18 09:00 X\n";
        assert_eq!(
            decide(Some(c), "- 2026-07-18 14:30 Y", "Y").as_deref(),
            Some("- 2026-07-18 09:00 X\n- 2026-07-18 14:30 Y\n")
        );
    }
    #[test]
    fn decide_append_fixes_missing_trailing_newline() {
        let c = "- 2026-07-18 09:00 X";
        assert_eq!(
            decide(Some(c), "- 2026-07-18 14:30 Y", "Y").as_deref(),
            Some("- 2026-07-18 09:00 X\n- 2026-07-18 14:30 Y\n")
        );
    }
    #[test]
    fn decide_appends_after_malformed_tail() {
        // 手工编辑过的行 → last_address None → 视为变化，照常追加
        let c = "随手一行\n";
        assert_eq!(
            decide(Some(c), "- 2026-07-18 14:30 Y", "Y").as_deref(),
            Some("随手一行\n- 2026-07-18 14:30 Y\n")
        );
    }
    #[test]
    fn decide_baseline_on_empty_existing_file() {
        assert_eq!(
            decide(Some(""), "- 2026-07-18 14:30 Y", "Y").as_deref(),
            Some("- 2026-07-18 14:30 Y\n")
        );
    }
}
