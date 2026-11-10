//! The whole smart-lookup pipeline in one call, for `notemd lookup` and its
//! eval mode (spec Appendix G.5 / G.6): local lookup → route → judge, or
//! diagnosis → repair → regrouped search.
//!
//! Orchestration only. Every decision is made by the functions the window's
//! commands call — `lookup_local_in`, `route`, `judge_run`,
//! `diagnose_locked`, `repair_run`, `search_groups_in` — so confidentiality,
//! re-reading blocks, consent, error-to-status mapping and the one-automatic-
//! request budget are the same code here as in the app.

use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::candidates::{route, Route};
use super::judge::{judge_run, JudgeRequest, JudgeResult};
use super::repair::{repair_run, RepairRequest, RepairSuggestion};
use super::{fresh_cancel_flag, ChatRequestConfig, EnhanceStatus, JevRequestConfig, SkipReason, Trigger};
use crate::lookup_params::LookupParams;
use crate::search::smart::SmartHitDto;
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
    pub judge: Option<JudgeResult>,
    pub diagnosis: Option<Diagnosis>,
    pub repair: Option<RepairSuggestion>,
    pub regrouped: Option<GroupLookupResponse>,
    /// 最终展示顺序：判断成功时按 JudgeResult.order，修复成功时是按说法重搜的结果，否则是本地顺序。
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
///    - `Repair`: `diagnose_locked`; with a chat config and a chat key,
///      `repair_run` (automatic), and on `ok` `search_groups_in`;
///    - `Judge`: `judge_run` (automatic) on the host display order, with
///      the in-range count as the only section break in `Group` time mode;
///      on `ok` the hits follow `JudgeResult.order`;
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
        judge: None,
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
            if let (Some(chat), Some(key)) = (enhance.chat.as_ref(), enhance.chat_key.as_deref()) {
                let cancel = fresh_cancel_flag(&run.id);
                let request = RepairRequest {
                    run_id: &run.id,
                    window_label: input.window_label,
                    chat,
                    key: Some(key),
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
            let display_order: Vec<String> = out.local.search.hits.iter().filter_map(|h| h.result_id.clone()).collect();
            let section_breaks = match &out.local.time {
                Some(t) if t.mode == TimeMode::Group && 0 < t.in_window && t.in_window < display_order.len() => {
                    vec![t.in_window]
                }
                _ => Vec::new(),
            };
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
            let cancel = fresh_cancel_flag(&run.id);
            let request = JudgeRequest {
                run_id: &run.id,
                window_label: input.window_label,
                vault_root: &vault_root,
                display_order: &display_order,
                section_breaks: &section_breaks,
                config,
                key: enhance.jev_key.as_deref(),
                trigger: Trigger::Auto,
                params,
                timeout: params.enhance.timeout(),
            };
            let judge = judge_run(request, input.index, client, &cancel).await?;
            if judge.status == EnhanceStatus::Ok {
                let by_id: std::collections::HashMap<&str, &SmartHitDto> =
                    out.local.search.hits.iter().filter_map(|h| Some((h.result_id.as_deref()?, h))).collect();
                out.hits = judge.order.iter().filter_map(|id| by_id.get(id.as_str()).map(|h| (*h).clone())).collect();
            }
            out.judge = Some(judge);
        }
    }
    out.total_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}
