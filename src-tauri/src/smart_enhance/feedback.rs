//! The local correction log: one JSON line per "this result was (not) a fit"
//! click. It lives in the app data directory, is never sent anywhere and never
//! enters the vault. A row carries the question and a pointer to the result,
//! not the result's text, and never a key. Spec Appendix F.4.

use std::fs;
use std::io::Write;
use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::Tier;
use crate::smart_lookup::{run_for_window, LookupRun};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserVerdict {
    Fit,
    Unfit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackRow {
    pub ts: String,
    pub question: String,
    pub path: String,
    pub line: u32,
    pub line_end: u32,
    pub model_tier: Tier,
    pub user_verdict: UserVerdict,
    pub endpoint_host: String,
    pub model: String,
}

pub(crate) const FEEDBACK_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Append one JSON line; creates the directory when missing. A file already
/// at the cap is left alone and reported.
pub(crate) fn append_feedback(path: &Path, row: &FeedbackRow) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create feedback dir: {e}"))?;
    }
    if fs::metadata(path).is_ok_and(|m| m.len() >= FEEDBACK_MAX_BYTES) {
        return Err("feedback log is full".to_string());
    }
    let mut line = serde_json::to_string(row).map_err(|e| format!("encode feedback: {e}"))?;
    line.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open feedback log: {e}"))?;
    file.write_all(line.as_bytes()).map_err(|e| format!("write feedback log: {e}"))
}

/// Build the row from the retained run. `result_id` is a local result id
/// (tiered by the one-round judge or by the evidence rounds) or an evidence
/// id; the tier is the one last reported for it (spec H.8). A result the
/// model did not judge has no tier to correct.
pub(crate) fn feedback_row(
    run: &LookupRun,
    result_id: &str,
    verdict: UserVerdict,
    now: DateTime<Utc>,
) -> Result<FeedbackRow, String> {
    let not_judged = || "result was not judged".to_string();
    let local = |id: &str| run.hits.iter().find(|h| h.result_id == id).map(|h| (h.path.clone(), h.line, h.line_end));
    let judged = run
        .judgement
        .as_ref()
        .and_then(|j| Some((*j.tiers.get(result_id)?, j.endpoint_host.clone(), j.model.clone(), local(result_id)?)));
    let evidence = || {
        let e = run.evidence.as_ref()?;
        let tier = *e.tiers.get(result_id)?;
        let place = match e.items.iter().find(|(id, _)| id == result_id) {
            Some((_, block)) => {
                let c = e.state.latest.get(block)?;
                (c.path.clone(), c.line, c.line_end)
            }
            None => local(result_id)?,
        };
        Some((tier, e.endpoint_host.clone(), e.model.clone(), place))
    };
    let (model_tier, endpoint_host, model, (path, line, line_end)) =
        judged.or_else(evidence).ok_or_else(not_judged)?;
    Ok(FeedbackRow {
        ts: now.to_rfc3339_opts(SecondsFormat::Secs, true),
        question: run.question.clone(),
        path,
        line,
        line_end,
        model_tier,
        user_verdict: verdict,
        endpoint_host,
        model,
    })
}

#[tauri::command]
pub fn smart_lookup_feedback(
    app: tauri::AppHandle,
    window: tauri::Window,
    lookup_run_id: String,
    result_id: String,
    verdict: UserVerdict,
) -> Result<(), String> {
    let run = run_for_window(&lookup_run_id, window.label())?;
    let row = feedback_row(&run, &result_id, verdict, Utc::now())?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    append_feedback(&dir.join("smart-lookup").join("feedback.jsonl"), &row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_lookup::{CanonicalHit, JudgeRecord, RouteFacts};
    use chrono::TimeZone;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::Instant;

    fn run(judged: bool) -> LookupRun {
        LookupRun {
            id: "run".into(),
            created_at: Instant::now(),
            window_label: "w".into(),
            root: PathBuf::from("/vault"),
            question: "where is the plan".into(),
            hits: vec![CanonicalHit {
                result_id: "r1".into(),
                path: "a.md".into(),
                line: 3,
                line_end: 5,
                level: "line".into(),
                indexed_text: "secret body".into(),
                breadcrumb: String::new(),
                pinned: false,
            }],
            facts: RouteFacts::default(),
            time: None,
            auto_request_used: false,
            repaired: false,
            auto_claim: None,
            judgement: judged.then(|| JudgeRecord {
                endpoint_host: "api.typesafe.ai".into(),
                model: "m".into(),
                tiers: HashMap::from([("r1".to_string(), Tier::Fit)]),
            }),
            evidence: None,
        }
    }

    fn fixed_now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 10, 1, 2, 3).unwrap()
    }

    #[test]
    fn feedback_rows_come_from_the_run_and_append_as_jsonl() {
        let row = feedback_row(&run(true), "r1", UserVerdict::Unfit, fixed_now()).unwrap();
        assert_eq!((row.path.as_str(), row.model_tier, row.endpoint_host.as_str()), ("a.md", Tier::Fit, "api.typesafe.ai"));
        assert_eq!((row.line, row.line_end, row.ts.as_str()), (3, 5, "2026-11-10T01:02:03Z"));
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("smart-lookup/feedback.jsonl");
        append_feedback(&file, &row).unwrap();
        append_feedback(&file, &row).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text.lines().count(), 2);
        let value: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        for key in ["ts", "question", "path", "line", "lineEnd", "modelTier", "userVerdict", "endpointHost", "model"] {
            assert!(value.get(key).is_some(), "{key}");
        }
        assert_eq!(value.as_object().unwrap().len(), 9);
        assert!(!text.contains("secret body"));
        assert!(feedback_row(&run(false), "r1", UserVerdict::Fit, fixed_now()).is_err());
        assert_eq!(
            feedback_row(&run(true), "nope", UserVerdict::Fit, fixed_now()).unwrap_err(),
            "result was not judged"
        );
    }

    /// An evidence run that scored block 7 (b.md:4, evidence id `e1`, fit)
    /// and tiered the local hit `r1` unfit.
    fn evidence_run() -> crate::smart_enhance::evidence::EvidenceRun {
        use crate::smart_enhance::sag::round::{EvidenceState, RoundSettings};
        use crate::smart_enhance::sag::SagCandidate;
        let block = SagCandidate {
            id: 7,
            path: "b.md".into(),
            line: 4,
            line_end: 4,
            title: "b".into(),
            heading: String::new(),
            content: "found text".into(),
            bm25: -1.0,
            score: 0.9,
            previous_score: None,
            order: 0,
        };
        let state = EvidenceState {
            generation: 1,
            query: "where is the plan".into(),
            expression: "\"plan\"".into(),
            next_hop: 1,
            retained: vec![block.clone()],
            frontier: vec![],
            expanded: Default::default(),
            seen: Default::default(),
            carried: Default::default(),
            protected: Default::default(),
            latest: [(7, block)].into_iter().collect(),
            trace: vec![],
            found_round: Default::default(),
            stop: None,
            tokens_used: 0,
            settings: RoundSettings { candidate_k: 50, seed_k: 10, term_limit: 20, max_hops: 1, top_k: 10, protected_k: 5 },
        };
        crate::smart_enhance::evidence::EvidenceRun {
            state,
            items: vec![("e1".into(), 7)],
            endpoint_host: "jev.example".into(),
            model: "jev-m".into(),
            auto_claimed: true,
            tiers: HashMap::from([("e1".to_string(), Tier::Fit), ("r1".to_string(), Tier::Unfit)]),
            shown: None,
        }
    }

    #[test]
    fn feedback_accepts_evidence_ids() {
        let mut r = run(false);
        r.evidence = Some(evidence_run());
        let row = feedback_row(&r, "e1", UserVerdict::Unfit, fixed_now()).unwrap();
        assert_eq!((row.path.as_str(), row.line, row.line_end), ("b.md", 4, 4));
        assert_eq!((row.model_tier, row.endpoint_host.as_str(), row.model.as_str()), (Tier::Fit, "jev.example", "jev-m"));
        // A local row tiered by the evidence rounds.
        let local = feedback_row(&r, "r1", UserVerdict::Fit, fixed_now()).unwrap();
        assert_eq!((local.path.as_str(), local.line, local.model_tier), ("a.md", 3, Tier::Unfit));
        assert_eq!(local.endpoint_host, "jev.example");
        assert_eq!(feedback_row(&r, "e9", UserVerdict::Fit, fixed_now()).unwrap_err(), "result was not judged");
        // The one-round judge's record still answers for its own results.
        let mut both = run(true);
        both.evidence = Some(evidence_run());
        let judged = feedback_row(&both, "r1", UserVerdict::Fit, fixed_now()).unwrap();
        assert_eq!((judged.model_tier, judged.endpoint_host.as_str()), (Tier::Fit, "api.typesafe.ai"));
        assert_eq!(feedback_row(&both, "e1", UserVerdict::Fit, fixed_now()).unwrap().model_tier, Tier::Fit);
    }

    #[test]
    fn a_full_log_refuses_more_rows() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("feedback.jsonl");
        let f = std::fs::File::create(&file).unwrap();
        f.set_len(FEEDBACK_MAX_BYTES).unwrap();
        let row = feedback_row(&run(true), "r1", UserVerdict::Fit, fixed_now()).unwrap();
        assert_eq!(append_feedback(&file, &row).unwrap_err(), "feedback log is full");
    }
}
