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

/// `(lat, lon)`，各保留 5 位小数，如 `(30.50762, 114.41956)`。追加到行末，仅作
/// 展示 / 复制进地图之用；**不进去重 key**（GPS 每轮都抖动）。
pub fn format_coords(lat: f64, lon: f64) -> String {
    format!("({lat:.5}, {lon:.5})")
}

/// `- YYYY-MM-DD HH:mm <addr>`，`coords` 存在时再于行末补 ` <coords>`（本地时间与
/// 坐标由调用方传入，便于测试；非 macOS / 老宿主不返回坐标时传 `None` 退回原样）。
pub fn format_line(
    ts: &chrono::DateTime<chrono::Local>,
    addr: &str,
    coords: Option<&str>,
) -> String {
    let stamp = ts.format("%Y-%m-%d %H:%M");
    match coords {
        Some(c) => format!("- {stamp} {addr} {c}"),
        None => format!("- {stamp} {addr}"),
    }
}

/// 当天文件的 vault 相对路径 `pos/YYYY-MM-DD-pos.md`。
pub fn file_rel_path(ts: &chrono::DateTime<chrono::Local>) -> String {
    format!("pos/{}-pos.md", ts.format("%Y-%m-%d"))
}

/// 剥掉地址串行末的 ` (lat, lon)` 坐标段，只保留地址本体。保守：仅当括号内恰是
/// 两个逗号分隔的十进制数才剥，避免误伤 POI 里本身带的括号（如 `Foo (bar)`）。
fn strip_coords(addr: &str) -> &str {
    let t = addr.trim_end();
    if !t.ends_with(')') {
        return addr;
    }
    let Some(open) = t.rfind(" (") else { return addr };
    let inner = &t[open + 2..t.len() - 1]; // 括号内部
    let mut parts = inner.split(", ");
    match (parts.next(), parts.next(), parts.next()) {
        (Some(a), Some(b), None) if is_decimal(a) && is_decimal(b) => t[..open].trim_end(),
        _ => addr,
    }
}

/// 十进制数形（可带前导 `-`，至多一个小数点）。
fn is_decimal(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    !body.is_empty()
        && body.chars().all(|c| c.is_ascii_digit() || c == '.')
        && body.chars().filter(|&c| c == '.').count() <= 1
}

/// 现有文件内容里最后一条记录的地址部分（剥掉 `- YYYY-MM-DD HH:mm ` 前缀，再剥掉
/// 行末可能的 ` (lat, lon)` 坐标段）。无行/行不合形 → None（调用方视为需要追加）。
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
    let addr = strip_coords(addr);
    if addr.is_empty() {
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
            format_line(&ts(), "中国-湖北-武汉 光谷软件园", None),
            "- 2026-07-18 14:30 中国-湖北-武汉 光谷软件园"
        );
    }
    #[test]
    fn coords_format_five_decimals() {
        assert_eq!(format_coords(30.5076213, 114.4195627), "(30.50762, 114.41956)");
        assert_eq!(format_coords(-33.8, 151.2), "(-33.80000, 151.20000)");
    }
    #[test]
    fn line_format_with_coords() {
        assert_eq!(
            format_line(
                &ts(),
                "中国-湖北-武汉 光谷软件园",
                Some(&format_coords(30.50762, 114.41956))
            ),
            "- 2026-07-18 14:30 中国-湖北-武汉 光谷软件园 (30.50762, 114.41956)"
        );
    }
    #[test]
    fn last_address_strips_trailing_coords() {
        let c = "- 2026-07-18 09:00 中国-湖北-武汉 光谷软件园 (30.50762, 114.41956)\n";
        assert_eq!(last_address(c).as_deref(), Some("中国-湖北-武汉 光谷软件园"));
    }
    #[test]
    fn last_address_keeps_poi_parens_when_not_coords() {
        // POI 自带括号、行末无坐标 → 不误剥
        let c = "- 2026-07-18 09:00 中国-北京 天安门 (东侧)\n";
        assert_eq!(last_address(c).as_deref(), Some("中国-北京 天安门 (东侧)"));
    }
    #[test]
    fn dedup_ignores_coord_jitter() {
        // 上一行带坐标，本轮地址相同但坐标抖动 → 仍跳过（按地址去重）
        let c = "- 2026-07-18 09:00 中国-湖北-武汉 光谷 (30.50762, 114.41956)\n";
        let line = format_line(&ts(), "中国-湖北-武汉 光谷", Some("(30.50799, 114.41902)"));
        assert_eq!(decide(Some(c), &line, "中国-湖北-武汉 光谷"), None);
    }
    #[test]
    fn append_when_address_changes_over_coord_line() {
        let c = "- 2026-07-18 09:00 中国-湖北-武汉 光谷 (30.50762, 114.41956)\n";
        let line = format_line(&ts(), "中国-湖北-武汉 街道口", Some("(30.53000, 114.35000)"));
        assert_eq!(
            decide(Some(c), &line, "中国-湖北-武汉 街道口").as_deref(),
            Some("- 2026-07-18 09:00 中国-湖北-武汉 光谷 (30.50762, 114.41956)\n- 2026-07-18 14:30 中国-湖北-武汉 街道口 (30.53000, 114.35000)\n")
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
