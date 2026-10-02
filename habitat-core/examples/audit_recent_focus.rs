//! Read-only, explicitly invoked candidate audit. Output stays outside Vault.
use habitat_core::{focus, model::*};
use std::{collections::BTreeMap, fs, path::PathBuf};
fn main() -> Result<(), String> {
    let a: Vec<_> = std::env::args().collect();
    if !(5..=6).contains(&a.len()) {
        return Err("audit_recent_focus ROOT MANIFEST OUT_JSON AS_OF".into());
    }
    let root = fs::canonicalize(&a[1]).map_err(|e| e.to_string())?;
    let out = PathBuf::from(&a[3]);
    if out.starts_with(&root) {
        return Err("audit output must be outside vault".into());
    }
    let inputs: Vec<SourceInput> =
        serde_json::from_slice(&fs::read(&a[2]).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let context = FocusContext {
        as_of: a[4].clone(),
        window_days: 30,
        utc_offset_minutes: 480,
    };
    let mut events = Vec::new();
    let mut anchors = BTreeMap::new();
    let mut count = 0;
    for input in &inputs {
        if !habitat_core::codec::safe_source_path(&input.path)
            || input
                .path
                .split('/')
                .any(|p| matches!(p, ".credentials" | ".git" | ".local" | "node_modules"))
        {
            continue;
        }
        if input.path.starts_with("wikipage/") {
            let stem = input
                .path
                .rsplit('/')
                .next()
                .unwrap_or("")
                .trim_end_matches(".md")
                .trim_end_matches(".note");
            anchors.insert(stem.to_lowercase(), "concept".to_string());
        }
        if !input.path.starts_with("agent-sessions/")
            && !input.path.ends_with(".note.md")
            && !input.path.starts_with("inbox/traces/")
        {
            continue;
        }
        let path = root.join(&input.path);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        count += 1;
        events.extend(focus::events_from_markdown(
            &input.path,
            &raw,
            context.utc_offset_minutes,
        ));
    }
    if let Some(snapshot) = a.get(5) {
        for line in fs::read_to_string(snapshot)
            .map_err(|e| e.to_string())?
            .lines()
        {
            let Ok(n) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if n["kind"] == "node" && n["nodeType"] == "project" {
                if let Some(label) = n["label"].as_str() {
                    anchors.insert(label.to_lowercase(), "context".into());
                }
            }
        }
    }
    let total = events.len();
    let candidates = focus::rank_events(events, &context, &anchors)?;
    let foreground = focus::foreground(&candidates);
    let associations = focus::associations(&foreground);
    let mut degree = BTreeMap::new();
    for edge in &associations {
        *degree.entry(edge.a.clone()).or_insert(0) += 1;
        *degree.entry(edge.b.clone()).or_insert(0) += 1;
    }
    let top: Vec<_> = foreground
        .into_iter()
        .map(|mut c| {
            c.occurrences.sort_by(|a, b| b.date.cmp(&a.date));
            c.occurrences.truncate(2);
            c
        })
        .collect();
    let report = serde_json::json!({"asOf":context.as_of,"windowDays":context.window_days,"filesRead":count,"trustedEventLines":total,"candidateCount":candidates.len(),"associationCount":associations.len(),"foregroundDegree":degree,"associations":associations,"foreground":top});
    fs::write(&out, serde_json::to_vec_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"candidates":candidates.len(),"events":total,"top40":candidates.iter().take(40).map(|c|format!("{} | {} | {:.3} | {}d",c.term,c.kind,c.score,c.active_days)).collect::<Vec<_>>(),"output":out})).unwrap());
    Ok(())
}
