//! The whole smart-lookup pipeline in one call, for `notemd lookup` and its
//! eval mode (spec Appendix G.5 / G.6, H.1): local lookup → route → evidence rounds, or
//! diagnosis → repair → regrouped search.
//!
//! Orchestration only. Every decision is made by the functions the window's
//! commands call — `lookup_local_in`, `route`, `evidence_step`,
//! `diagnose_locked`, `repair_run`, `search_groups_in` — so confidentiality,
//! re-reading blocks, consent, error-to-status mapping and the one-automatic-
//! request budget are the same code here as in the app.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::candidates::{route, Route};
use super::evidence::{evidence_step, ready_reader, unavailable, EvidenceItemDto, EvidenceRequest, EvidenceStepResult};
use super::repair::{repair_run, RepairRequest, RepairSuggestion};
use super::{cancel_flag_for, ChatRequestConfig, EnhanceStatus, JevRequestConfig, SkipReason, Trigger};
use crate::lookup_params::LookupParams;
use crate::search::smart::SmartHitDto;
use crate::search::HitDto;
use crate::search::time_group::TimeMode;
use crate::search::{
    diagnose_locked, lookup_local_in, search_groups_in, Diagnosis, GroupLookupResponse, IndexHandle,
    LocalLookupResponse,
};
use crate::smart_lookup::run_for_window;
use crate::smart_model::AuthMode;

/// The model endpoints and keys a run may use. A missing config (or key) is
/// reported by the host functions as `notConfigured`, never worked around.
pub(crate) struct EnhanceSetup {
    pub jev: Option<JevRequestConfig>,
    pub jev_key: Option<String>,
    pub chat: Option<ChatRequestConfig>,
    pub chat_key: Option<String>,
}

pub(crate) struct PipelineInput<'a> {
    pub question: &'a str,
    pub vault_root: &'a Path,
    pub index: &'a IndexHandle,
    pub window_label: &'a str,
    pub params: &'a LookupParams,
    pub deep: bool,
    pub time_mode: Option<TimeMode>,
    pub today: NaiveDate,
    /// `None`: local only, nothing is sent (`--no-enhance`).
    pub enhance: Option<&'a EnhanceSetup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PipelineRoute {
    Local,
    Judge,
    Repair,
    Skip,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipelineOutput {
    pub local: LocalLookupResponse,
    pub local_ms: u64,
    pub route: PipelineRoute,
    pub skip_reason: Option<SkipReason>,
    /// The judge route's evidence rounds, one per `evidence_step` call.
    pub evidence_rounds: Vec<EvidenceStepResult>,
    pub diagnosis: Option<Diagnosis>,
    pub repair: Option<RepairSuggestion>,
    pub regrouped: Option<GroupLookupResponse>,
    /// 最终展示顺序：有证据时先证据、再其余本地命中（spec H.10），修复成功时是按说法重搜的结果，否则是本地顺序。
    pub hits: Vec<SmartHitDto>,
    /// Per hit of `hits`, the wordings (from 1) that found it; empty unless
    /// the hits come from the regrouped search.
    pub hit_groups: Vec<Vec<u8>>,
    pub total_ms: u64,
}

/// Runs the pipeline once:
///
/// 1. `lookup_local_in` with a fresh counter, ticket 1 (budget, fusion and
///    time mode from `params` unless the input names them);
/// 2. no `enhance` → done, route `Local`;
/// 3. `route` on the retained run's facts:
///    - `Repair`: `diagnose_locked`; with a chat config, `repair_run`
///      (automatic; without a key the host answers `notConfigured`), and on
///      `ok` `search_groups_in`;
///    - `Judge`: `evidence_step` (automatic) until it reports `done`, one
///      round per call as the window runs them (spec H.1); the hits are the
///      latest `ok` round's evidence, then the other local hits;
///    - `Skip`: done, with the reason.
pub(crate) async fn run_pipeline(input: PipelineInput<'_>, client: &reqwest::Client) -> Result<PipelineOutput, String> {
    let started = Instant::now();
    let counter = Arc::new(AtomicU64::new(1));
    let ticket = 1;
    let params = input.params;
    let local = lookup_local_in(
        input.index,
        input.vault_root,
        input.window_label,
        input.question,
        None,
        input.deep,
        None,
        input.time_mode,
        input.today,
        params,
        &counter,
        ticket,
    )?;
    let local_ms = started.elapsed().as_millis() as u64;
    let hits = local.search.hits.clone();
    let mut out = PipelineOutput {
        local,
        local_ms,
        route: PipelineRoute::Local,
        skip_reason: None,
        evidence_rounds: Vec::new(),
        diagnosis: None,
        repair: None,
        regrouped: None,
        hits,
        hit_groups: Vec::new(),
        total_ms: 0,
    };
    let Some(enhance) = input.enhance else {
        out.total_ms = started.elapsed().as_millis() as u64;
        return Ok(out);
    };

    let run = run_for_window(&out.local.lookup_run_id, input.window_label)?;
    match route(&run.facts, params.routing.few_terms_max) {
        Route::Skip(reason) => {
            out.route = PipelineRoute::Skip;
            out.skip_reason = Some(reason);
        }
        Route::Repair => {
            out.route = PipelineRoute::Repair;
            out.diagnosis = Some(diagnose_locked(input.index, &run, &params.local.fusion(), &counter, ticket)?);
            // As the window does: a missing key is the host's to report.
            if let Some(chat) = enhance.chat.as_ref() {
                let cancel = cancel_flag_for(Trigger::Auto, &run.id);
                let request = RepairRequest {
                    run_id: &run.id,
                    window_label: input.window_label,
                    chat,
                    key: enhance.chat_key.as_deref(),
                    trigger: Trigger::Auto,
                    limits: &params.repair,
                    timeout: params.enhance.timeout(),
                };
                let repair = repair_run(request, client, &cancel).await?;
                if repair.status == EnhanceStatus::Ok {
                    let regrouped = search_groups_in(
                        input.window_label,
                        input.vault_root,
                        input.index,
                        &run,
                        &repair.groups,
                        Some(params.local.limit),
                        input.today,
                        &counter,
                        ticket,
                        params,
                    )?;
                    out.hits = regrouped.search.hits.clone();
                    out.hit_groups = regrouped.hit_groups.clone();
                    out.regrouped = Some(regrouped);
                }
                out.repair = Some(repair);
            }
        }
        Route::Judge => {
            out.route = PipelineRoute::Judge;
            // No Jev config: the host's gate reports what is missing.
            let unconfigured = JevRequestConfig {
                url: String::new(),
                model: String::new(),
                auth_mode: AuthMode::Bearer,
                consent_host: String::new(),
            };
            let config = enhance.jev.as_ref().unwrap_or(&unconfigured);
            let vault_root =
                std::fs::canonicalize(input.vault_root).map_err(|error| format!("resolve vault: {error}"))?;
            let cancel = cancel_flag_for(Trigger::Auto, &run.id);
            let reader = ready_reader(input.index, &vault_root).await?;
            // `done` ends the loop; the bound (one round more than the
            // rounds there can be) only guards against a host bug.
            for _ in 0..params.retrieval.max_hops + 2 {
                let Some(reader) = reader.clone() else {
                    out.evidence_rounds.push(unavailable());
                    break;
                };
                let request = EvidenceRequest {
                    run_id: &run.id,
                    window_label: input.window_label,
                    vault_root: &vault_root,
                    config,
                    key: enhance.jev_key.as_deref(),
                    trigger: Trigger::Auto,
                    deep: input.deep,
                    params,
                    reader,
                };
                let round = evidence_step(request, client, &cancel).await?;
                let done = round.done;
                out.evidence_rounds.push(round);
                if done {
                    break;
                }
            }
            if let Some(latest) = out.evidence_rounds.iter().rev().find(|r| r.status == EnhanceStatus::Ok) {
                out.hits = evidence_first(&latest.evidence, &out.local.search.hits, input.vault_root);
            }
        }
    }
    out.total_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

/// What the window shows top to bottom (spec H.8, H.10): the evidence list,
/// each item as the local hit with the same path and line range (or built
/// from the item when the local lookup did not return it), then the other
/// local hits in their order.
fn evidence_first(evidence: &[EvidenceItemDto], local: &[SmartHitDto], vault_root: &Path) -> Vec<SmartHitDto> {
    let mut used = HashSet::new();
    let mut hits = Vec::with_capacity(evidence.len() + local.len());
    for item in evidence {
        let same = |h: &SmartHitDto| (h.hit.path.as_str(), h.hit.line, h.hit.line_end) == (item.path.as_str(), item.line, item.line_end);
        match local.iter().position(same) {
            Some(i) => {
                used.insert(i);
                hits.push(local[i].clone());
            }
            None => hits.push(hit_from_evidence(item, vault_root)),
        }
    }
    hits.extend(local.iter().enumerate().filter(|(i, _)| !used.contains(i)).map(|(_, h)| h.clone()));
    hits
}

/// A line-level hit for an evidence item the local lookup did not return.
/// Only what the item knows is filled in; it has no result id.
fn hit_from_evidence(item: &EvidenceItemDto, vault_root: &Path) -> SmartHitDto {
    SmartHitDto {
        hit: HitDto {
            path: item.path.clone(),
            abs_path: vault_root.join(&item.path).to_string_lossy().to_string(),
            line: item.line,
            line_end: item.line_end,
            text: item.text.clone(),
            breadcrumb: item.breadcrumb.clone(),
            level: "line".to_string(),
            score: 0.0,
            doc_date: None,
            source_ref: format!("{}#L{}", item.path, item.line),
            agent_by: None,
            human_verified: false,
            origin: String::new(),
            concept_type: None,
            pinned: false,
        },
        fused_score: 0.0,
        relevance_reasons: Vec::new(),
        matched_queries: Vec::new(),
        result_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_enhance::enhance_client;
    use crate::smart_enhance::evidence::tests::{config, fixture, server, QUESTION};
    use std::sync::atomic::Ordering::SeqCst;
    use std::time::Duration;

    #[tokio::test]
    async fn pipeline_judge_route_runs_evidence_rounds() {
        let f = fixture();
        let s = server(|_| Duration::ZERO).await;
        let setup = EnhanceSetup { jev: Some(config(&s.base)), jev_key: None, chat: None, chat_key: None };
        let params = LookupParams::default();
        let input = PipelineInput {
            question: QUESTION,
            vault_root: &f.root,
            index: &f.index,
            window_label: "test-pipeline-evidence",
            params: &params,
            deep: false,
            time_mode: None,
            today: NaiveDate::from_ymd_opt(2026, 11, 11).unwrap(),
            enhance: Some(&setup),
        };
        let out = run_pipeline(input, &enhance_client().unwrap()).await.unwrap();
        assert_eq!(out.route, PipelineRoute::Judge);
        assert_eq!(out.evidence_rounds.len(), 2); // maxHops 1: rounds 0 and 1
        assert_eq!(out.evidence_rounds.iter().map(|r| (r.hop, r.done)).collect::<Vec<_>>(), [(0, false), (1, true)]);
        assert_eq!(s.accepted.load(SeqCst), 2);
        let evidence = &out.evidence_rounds[1].evidence;
        let key = |path: &str, line: u32, end: u32| (path.to_string(), line, end);
        let shown: Vec<_> = out.hits.iter().map(|h| key(&h.hit.path, h.hit.line, h.hit.line_end)).collect();
        let want: Vec<_> = evidence.iter().map(|i| key(&i.path, i.line, i.line_end)).collect();
        assert_eq!(shown[..want.len()], want[..], "the hits begin with the evidence");
        // An item the local lookup did not return is built from the item;
        // one it did return is that local hit.
        let p = out.hits.iter().find(|h| h.hit.path == "p.md").expect("p.md came from round 1");
        assert!(p.result_id.is_none() && p.hit.text.contains("Alice Paul"));
        let q = &out.hits[shown.iter().position(|k| k.0 == "q.md").unwrap()];
        assert!(q.result_id.is_some());
        // Every local hit is still there, once.
        for local in &out.local.search.hits {
            let k = key(&local.hit.path, local.hit.line, local.hit.line_end);
            assert_eq!(shown.iter().filter(|s| **s == k).count(), 1, "{k:?}");
        }
    }
}
