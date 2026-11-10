//! `notemd lookup` — the whole smart-lookup pipeline without a window, and
//! `notemd lookup eval` to tune its parameters (spec Appendix G.5 / G.6).
//!
//! Nothing here decides what is sent, how results are judged or repaired, or
//! how errors map to statuses: `smart_enhance::pipeline::run_pipeline` calls
//! the same host functions the Smart Lookup window does. This module parses
//! flags, reads keys from the environment and prints.
//!
//! Consent on the command line is `--allow-send <host>`: it becomes the Jev
//! config's consent host, so the host's own gate sends nothing unless it
//! equals the endpoint's host. Keys come only from `NOTEMD_JEV_KEY` /
//! `NOTEMD_CHAT_KEY` and are never printed.

use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::json;

use crate::lookup_params::{self, LookupParams, PARAMS_ENV};
use crate::search::smart_eval::{
    compare_metrics, gate_verdicts, load_eval_rows, load_tasks, lookup_metrics, metric_values, run_lookup_eval,
    GateVerdicts, LookupEvalRow, LookupMetrics, Split,
};
use crate::search::time_group::TimeMode;
use crate::search::IndexHandle;
use crate::smart_enhance::keys::normalize_key;
use crate::smart_enhance::pipeline::{run_pipeline, EnhanceSetup, PipelineInput, PipelineOutput, PipelineRoute};
use crate::smart_enhance::{enhance_client, ChatRequestConfig, EnhanceStatus, JevRequestConfig, Tier};
use crate::smart_model::AuthMode;

/// The window label of a `notemd lookup` query run.
const QUERY_WINDOW: &str = "cli";
const JEV_KEY_ENV: &str = "NOTEMD_JEV_KEY";
const CHAT_KEY_ENV: &str = "NOTEMD_CHAT_KEY";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LookupMode {
    #[default]
    Query,
    Eval,
}

#[derive(Debug, Clone, Default)]
pub struct LookupArgs {
    pub mode: LookupMode,
    pub question: Vec<String>,
    pub vault: Option<String>,
    pub params: Option<PathBuf>,
    pub deep: bool,
    pub time_mode: Option<TimeMode>,
    pub no_enhance: bool,
    pub jev_url: Option<String>,
    pub jev_model: Option<String>,
    pub jev_auth: Option<AuthMode>,
    pub chat_url: Option<String>,
    pub chat_model: Option<String>,
    pub allow_send: Option<String>,
    pub tasks: Option<PathBuf>,
    pub out: Option<PathBuf>,
    pub compare: Option<PathBuf>,
    pub today: Option<NaiveDate>,
    pub json: bool,
    /// Kept until `run` so routing stays pure (as `notemd search` does).
    pub errors: Vec<String>,
}

impl LookupArgs {
    pub fn with_global_json(mut self, global: bool) -> Self {
        self.json = self.json || global;
        self
    }
}

/// The value after `flag`; a missing one, or one that is another `--flag`,
/// is an error.
fn value(rest: &[String], i: &mut usize, flag: &str, errors: &mut Vec<String>) -> Option<String> {
    match rest.get(*i + 1) {
        Some(v) if !v.starts_with("--") => {
            *i += 1;
            Some(v.clone())
        }
        _ => {
            errors.push(format!("{flag} requires a value"));
            None
        }
    }
}

/// `notemd lookup [options] <question…>` or `notemd lookup eval --tasks
/// <file> [options]`. Everything after `--` is the question. Flags may each
/// be given once.
pub fn parse_args(rest: &[String], json_global: bool) -> LookupArgs {
    let mut a = LookupArgs { json: json_global, ..Default::default() };
    let mut errors = Vec::new();
    let mut i = 0usize;
    if rest.first().map(String::as_str) == Some("eval") {
        a.mode = LookupMode::Eval;
        i = 1;
    }
    let mut positional_only = false;
    let mut seen = BTreeSet::new();
    while i < rest.len() {
        let arg = rest[i].as_str();
        if positional_only {
            a.question.push(arg.to_string());
            i += 1;
            continue;
        }
        if arg.starts_with("--") && arg != "--" && !seen.insert(arg.to_string()) {
            errors.push(format!("{arg} may only be specified once"));
        }
        match arg {
            "--" => positional_only = true,
            "--json" => a.json = true,
            "--deep" => a.deep = true,
            "--no-enhance" => a.no_enhance = true,
            "--vault" => a.vault = value(rest, &mut i, arg, &mut errors),
            "--params" => a.params = value(rest, &mut i, arg, &mut errors).map(PathBuf::from),
            "--time-mode" => {
                a.time_mode = value(rest, &mut i, arg, &mut errors).and_then(|v| match v.as_str() {
                    "group" => Some(TimeMode::Group),
                    "window" => Some(TimeMode::Window),
                    "ignore" => Some(TimeMode::Ignore),
                    other => {
                        errors.push(format!("--time-mode expects group|window|ignore, got '{other}'"));
                        None
                    }
                })
            }
            "--jev-url" => a.jev_url = value(rest, &mut i, arg, &mut errors),
            "--jev-model" => a.jev_model = value(rest, &mut i, arg, &mut errors),
            "--jev-auth" => {
                a.jev_auth = value(rest, &mut i, arg, &mut errors).and_then(|v| match v.as_str() {
                    "bearer" => Some(AuthMode::Bearer),
                    "none" => Some(AuthMode::None),
                    other => {
                        errors.push(format!("--jev-auth expects bearer|none, got '{other}'"));
                        None
                    }
                })
            }
            "--chat-url" => a.chat_url = value(rest, &mut i, arg, &mut errors),
            "--chat-model" => a.chat_model = value(rest, &mut i, arg, &mut errors),
            "--allow-send" => a.allow_send = value(rest, &mut i, arg, &mut errors),
            "--tasks" => a.tasks = value(rest, &mut i, arg, &mut errors).map(PathBuf::from),
            "--out" => a.out = value(rest, &mut i, arg, &mut errors).map(PathBuf::from),
            "--compare" => a.compare = value(rest, &mut i, arg, &mut errors).map(PathBuf::from),
            "--today" => {
                a.today = value(rest, &mut i, arg, &mut errors).and_then(|v| {
                    NaiveDate::parse_from_str(&v, "%Y-%m-%d")
                        .map_err(|_| errors.push(format!("--today expects YYYY-MM-DD, got '{v}'")))
                        .ok()
                })
            }
            // Only the flag's name: a mistyped `--key=…` must not be echoed.
            other if other.starts_with('-') => errors.push(format!(
                "unknown option '{}' (use '--' before a question word that starts with '-'; keys are read only from {JEV_KEY_ENV} / {CHAT_KEY_ENV})",
                other.split('=').next().unwrap_or(other)
            )),
            other => a.question.push(other.to_string()),
        }
        i += 1;
    }
    match a.mode {
        LookupMode::Query => {
            if a.question.join(" ").trim().is_empty() {
                errors.push("missing question".to_string());
            }
            if a.tasks.is_some() || a.out.is_some() || a.compare.is_some() {
                errors.push("--tasks, --out and --compare belong to 'notemd lookup eval'".to_string());
            }
        }
        LookupMode::Eval => {
            if a.tasks.is_none() {
                errors.push("eval requires --tasks <file>".to_string());
            }
            if !a.question.is_empty() {
                errors.push("eval takes no question (the task file holds them)".to_string());
            }
            if a.deep || a.time_mode.is_some() {
                errors.push("eval runs without --deep or --time-mode; set time.mode in --params".to_string());
            }
        }
    }
    a.errors = errors;
    a
}

/// Writes a failure the way `notemd search` does: a JSON error object on
/// stdout with `--json`, else `notemd: <message>` on stderr.
fn fail(json: bool, out: &mut dyn Write, err: &mut dyn Write, code: u8, kind: &str, message: &str) -> u8 {
    if json {
        let _ = writeln!(out, "{}", json!({ "ok": false, "error": { "code": kind, "message": message } }));
    } else {
        let _ = writeln!(err, "notemd: {message}");
    }
    code
}

/// What `run` reads from the machine, so its error paths can be tested.
pub(crate) struct Host<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
    /// The app data directory (`dirs::data_dir()/BUNDLE_ID`).
    pub app_data: Option<PathBuf>,
    pub resolve_vault: &'a dyn Fn(Option<&str>) -> Option<PathBuf>,
    /// Opens and freshness-sweeps the vault's index; `None` when unusable.
    pub open_index: &'a dyn Fn(&Path) -> Option<searchidx::SearchIndex>,
}

pub fn run(args: LookupArgs) -> ExitCode {
    let env = |name: &str| std::env::var(name).ok();
    let resolve_vault = |explicit: Option<&str>| super::search::resolve_vault_root(explicit);
    // Same open and freshness sweep as `notemd search`; no file-scan fallback,
    // so the warning claims none.
    let open_index = |root: &Path| {
        let opts = super::search::scan_options_for(root);
        super::search::open_fresh_index(root, &opts, false, false, "").0
    };
    let host = Host {
        env: &env,
        app_data: dirs::data_dir().map(|d| d.join(crate::app_dirs::BUNDLE_ID)),
        resolve_vault: &resolve_vault,
        open_index: &open_index,
    };
    let mut stdout = std::io::stdout().lock();
    let mut stderr = std::io::stderr().lock();
    ExitCode::from(run_with(args, &host, &mut stdout, &mut stderr))
}

/// `run`'s body: arguments, parameter file, Vault, index, then the query or
/// the eval on a current-thread runtime. Every failure is exit 2.
pub(crate) fn run_with(args: LookupArgs, host: &Host<'_>, out: &mut dyn Write, err: &mut dyn Write) -> u8 {
    let json = args.json;
    if !args.errors.is_empty() {
        let message = args.errors.join("; ");
        return fail(json, out, err, 2, "invalid_arguments", &format!("{message} — see: notemd help lookup"));
    }
    let env_params = (host.env)(PARAMS_ENV).map(std::ffi::OsString::from);
    let source = lookup_params::resolve_source(args.params.as_deref(), env_params.as_deref(), host.app_data.as_deref());
    let params = match lookup_params::load(&source) {
        Ok(params) => params,
        Err(error) => return fail(json, out, err, 2, "invalid_params", &error),
    };
    let Some(root) = (host.resolve_vault)(args.vault.as_deref()) else {
        return fail(
            json,
            out,
            err,
            2,
            "vault_not_configured",
            "no vault configured. Set one in Preferences, or pass --vault PATH.",
        );
    };
    if !root.is_dir() {
        return fail(json, out, err, 2, "vault_not_found", &format!("vault not found: {}", root.display()));
    }
    let Some(index) = (host.open_index)(&root) else {
        return fail(
            json,
            out,
            err,
            2,
            "invalid_index",
            "the search index is unavailable; notemd lookup needs it (try: notemd search --rebuild <query>)",
        );
    };
    let handle: IndexHandle = Arc::new(Mutex::new(Some(index)));
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => return fail(json, out, err, 2, "runtime", &format!("could not start the runtime: {error}")),
    };
    let outcome = runtime.block_on(async {
        match args.mode {
            LookupMode::Query => run_query(&args, &root, &handle, &params, host.env, out).await,
            LookupMode::Eval => run_eval(&args, &root, &handle, &params, host.env, out).await,
        }
    });
    match outcome {
        Ok(code) => code,
        Err(error) => fail(json, out, err, 2, "lookup_failed", &error),
    }
}

/// A key from `env`, through `normalize_key`. Unset or invalid means no key;
/// the warning names the variable, never the value.
fn env_key(env: &dyn Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    let raw = env(name)?;
    match normalize_key(&raw) {
        Ok(key) => Some(key),
        Err(reason) => {
            eprintln!("notemd: {name} ignored ({reason})");
            None
        }
    }
}

/// `None` with `--no-enhance`. A Jev config needs both `--jev-url` and
/// `--jev-model`, a chat config both `--chat-url` and `--chat-model`; the
/// consent host is `--allow-send` (empty without it, so nothing is sent).
fn enhance_setup(args: &LookupArgs, env: &dyn Fn(&str) -> Option<String>) -> Option<EnhanceSetup> {
    if args.no_enhance {
        return None;
    }
    let auth_mode = args.jev_auth.unwrap_or(AuthMode::Bearer);
    let jev = match (&args.jev_url, &args.jev_model) {
        (Some(url), Some(model)) => Some(JevRequestConfig {
            url: url.clone(),
            model: model.clone(),
            auth_mode,
            consent_host: args.allow_send.clone().unwrap_or_default(),
        }),
        _ => None,
    };
    let jev_key = match (&jev, auth_mode) {
        (Some(_), AuthMode::Bearer) => env_key(env, JEV_KEY_ENV),
        _ => None,
    };
    let chat = match (&args.chat_url, &args.chat_model) {
        (Some(url), Some(model)) => Some(ChatRequestConfig { url: url.clone(), model: model.clone() }),
        _ => None,
    };
    let chat_key = if chat.is_some() { env_key(env, CHAT_KEY_ENV) } else { None };
    Some(EnhanceSetup { jev, jev_key, chat, chat_key })
}

fn today_or_local(args: &LookupArgs) -> NaiveDate {
    args.today.unwrap_or_else(|| chrono::Local::now().date_naive())
}

/// Runs one lookup and prints it. Exit code: 0 with hits, 1 without.
pub(crate) async fn run_query(
    args: &LookupArgs,
    root: &Path,
    index: &IndexHandle,
    params: &LookupParams,
    env: &dyn Fn(&str) -> Option<String>,
    out: &mut dyn Write,
) -> Result<u8, String> {
    let question = args.question.join(" ");
    let enhance = enhance_setup(args, env);
    let client = enhance_client()?;
    let input = PipelineInput {
        question: &question,
        vault_root: root,
        index,
        window_label: QUERY_WINDOW,
        params,
        deep: args.deep,
        time_mode: args.time_mode,
        today: today_or_local(args),
        enhance: enhance.as_ref(),
    };
    let output = run_pipeline(input, &client).await?;
    let code = if output.hits.is_empty() { 1 } else { 0 };
    let lines = if args.json { json_lines(&output, code) } else { text_lines(&output) };
    write_lines(out, &lines);
    Ok(code)
}

/// Ignores write errors (a closed pipe): the exit code still tells the story.
fn write_lines(out: &mut dyn Write, lines: &[String]) {
    for line in lines {
        if writeln!(out, "{line}").is_err() {
            return;
        }
    }
    let _ = out.flush();
}

/// A serde unit variant as its JSON string (`"noConsent"`).
fn name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// Per final hit: its tier (from the latest `ok` evidence round: the
/// evidence item at the same place, else the local row's tier) and its
/// 1-based local rank when the evidence moved it.
fn hit_marks(output: &PipelineOutput) -> Vec<(Option<Tier>, Option<usize>)> {
    let Some(latest) = output.evidence_rounds.iter().rev().find(|r| r.status == EnhanceStatus::Ok) else {
        return vec![(None, None); output.hits.len()];
    };
    let by_place: HashMap<(&str, u32, u32), Tier> =
        latest.evidence.iter().map(|i| ((i.path.as_str(), i.line, i.line_end), i.tier)).collect();
    let by_id: HashMap<&str, Tier> = latest.local_tiers.iter().map(|v| (v.result_id.as_str(), v.tier)).collect();
    let local: HashMap<&str, usize> = output
        .local
        .search
        .hits
        .iter()
        .enumerate()
        .filter_map(|(i, h)| Some((h.result_id.as_deref()?, i + 1)))
        .collect();
    output
        .hits
        .iter()
        .enumerate()
        .map(|(i, hit)| {
            let id = hit.result_id.as_deref().unwrap_or_default();
            let moved = local.get(id).copied().filter(|&from| from != i + 1);
            let place = (hit.hit.path.as_str(), hit.hit.line, hit.hit.line_end);
            (by_place.get(&place).or_else(|| by_id.get(id)).copied(), moved)
        })
        .collect()
}

fn json_lines(output: &PipelineOutput, code: u8) -> Vec<String> {
    let mut lines = vec![json!({
        "kind": "local",
        "tookMs": output.local_ms,
        "hitCount": output.local.search.hits.len(),
        "time": output.local.time,
        "extractedTerms": output.local.search.extracted_terms,
    })];
    match output.route {
        PipelineRoute::Local => {}
        PipelineRoute::Judge => {
            lines.extend(output.evidence_rounds.iter().map(|round| json!({ "kind": "evidence", "result": round })))
        }
        PipelineRoute::Repair => {
            if let Some(diagnosis) = &output.diagnosis {
                lines.push(json!({ "kind": "diagnosis", "terms": diagnosis.terms }));
            }
            if let Some(repair) = &output.repair {
                lines.push(json!({ "kind": "repair", "result": repair }));
            }
            if let Some(regrouped) = &output.regrouped {
                lines.push(json!({ "kind": "regrouped", "groupCounts": regrouped.group_counts }));
            }
        }
        PipelineRoute::Skip => lines.push(json!({ "kind": "skip", "reason": output.skip_reason })),
    }
    for (i, (hit, (tier, moved))) in output.hits.iter().zip(hit_marks(output)).enumerate() {
        lines.push(json!({
            "kind": "hit",
            "rank": i + 1,
            "path": hit.hit.path,
            "line": hit.hit.line,
            "lineEnd": hit.hit.line_end,
            "level": hit.hit.level,
            "tier": tier,
            "movedFrom": moved,
            "groups": output.hit_groups.get(i),
            "text": hit.hit.text,
        }));
    }
    lines.push(json!({ "kind": "done", "route": output.route, "exitCode": code, "totalMs": output.total_ms }));
    lines.into_iter().map(|v| v.to_string()).collect()
}

/// The first non-empty line, whitespace collapsed, at most 120 characters.
fn one_line(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let short: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}

/// `{what} {status}` then the host, the skip reason, what is missing and
/// the status class, when present.
fn status_line(
    what: &str,
    status: EnhanceStatus,
    host: Option<&String>,
    skip: Option<&crate::smart_enhance::SkipReason>,
    missing: Option<&crate::smart_enhance::Missing>,
    class: Option<&String>,
) -> String {
    let mut parts = vec![format!("{what} {}", name(&status))];
    parts.extend(host.cloned());
    parts.extend(skip.map(name));
    parts.extend(missing.map(|m| format!("missing {}", name(m))));
    parts.extend(class.cloned());
    parts.join(" · ")
}

fn text_lines(output: &PipelineOutput) -> Vec<String> {
    let mut first = format!("local {} hits · {} ms", output.local.search.hits.len(), output.local_ms);
    if let Some(t) = &output.local.time {
        first.push_str(&format!(" · time {} ({}, {} in range)", t.source_text, name(&t.mode), t.in_window));
    }
    let mut lines = vec![first];
    match output.route {
        PipelineRoute::Local => lines.push("enhance off".to_string()),
        PipelineRoute::Skip => {
            lines.push(format!("skip · {}", output.skip_reason.as_ref().map(name).unwrap_or_default()))
        }
        PipelineRoute::Judge => {
            for r in &output.evidence_rounds {
                let mut line = if r.status == EnhanceStatus::Ok {
                    format!(
                        "evidence ok · {} · round {} · {} sent · {} ms · {} items",
                        r.endpoint_host.clone().unwrap_or_default(),
                        r.hop,
                        r.sent_blocks,
                        r.elapsed_ms,
                        r.evidence.len()
                    )
                } else {
                    status_line(
                        "evidence",
                        r.status,
                        r.endpoint_host.as_ref(),
                        r.skip_reason.as_ref(),
                        r.missing.as_ref(),
                        r.status_class.as_ref(),
                    )
                };
                if let Some(stop) = &r.stop {
                    line.push_str(&format!(" · stop {}", name(stop)));
                }
                lines.push(line);
            }
        }
        PipelineRoute::Repair => {
            if let Some(d) = &output.diagnosis {
                let terms: Vec<String> = d
                    .terms
                    .iter()
                    .map(|t| format!("{} {}{}", t.term, t.hits, if t.capped { "+" } else { "" }))
                    .collect();
                lines.push(if terms.is_empty() {
                    "diagnosis · no terms".to_string()
                } else {
                    format!("diagnosis · {}", terms.join(" · "))
                });
            }
            match &output.repair {
                Some(r) if r.status == EnhanceStatus::Ok => lines.push(format!("repair ok · {} wordings", r.groups.len())),
                Some(r) => lines.push(status_line(
                    "repair",
                    r.status,
                    r.endpoint_host.as_ref(),
                    r.skip_reason.as_ref(),
                    r.missing.as_ref(),
                    r.status_class.as_ref(),
                )),
                None => lines.push("repair off (needs --chat-url and --chat-model)".to_string()),
            }
            if let Some(g) = &output.regrouped {
                let counts: Vec<String> = g.group_counts.iter().map(usize::to_string).collect();
                lines.push(format!("regrouped · {} hits per wording", counts.join("/")));
            }
        }
    }
    for (i, (hit, (tier, _))) in output.hits.iter().zip(hit_marks(output)).enumerate() {
        let mark = match tier {
            Some(Tier::Fit) => " [fit]",
            Some(Tier::Unfit) => " [unfit]",
            Some(Tier::Unsure) | None => "",
        };
        lines.push(format!("{}. {}:{}{} {}", i + 1, hit.hit.path, hit.hit.line, mark, one_line(&hit.hit.text)));
    }
    lines
}

fn read_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Runs every task and prints metrics for all / dev / holdout, the holdout
/// gates and, with `--compare`, the change against that earlier `--out`.
pub(crate) async fn run_eval(
    args: &LookupArgs,
    root: &Path,
    index: &IndexHandle,
    params: &LookupParams,
    env: &dyn Fn(&str) -> Option<String>,
    out: &mut dyn Write,
) -> Result<u8, String> {
    let tasks_path = args.tasks.as_deref().ok_or("eval requires --tasks <file>")?;
    let tasks = load_tasks(&read_file(tasks_path)?).map_err(|e| format!("{}: {e}", tasks_path.display()))?;
    // A bad baseline fails before any request is sent.
    let baseline = match args.compare.as_deref() {
        Some(path) => Some(load_eval_rows(&read_file(path)?).map_err(|e| format!("{}: {e}", path.display()))?),
        None => None,
    };
    let enhance = enhance_setup(args, env);
    let client = enhance_client()?;
    // `--out` is written one row at a time, each flushed, so an interrupted
    // (paid) run keeps every row already finished.
    let mut sink = match args.out.as_deref() {
        Some(path) => Some((path, std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?)),
        None => None,
    };
    let mut on_row = |row: &LookupEvalRow| -> Result<(), String> {
        if let Some(error) = &row.error {
            eprintln!("notemd: task {}: {error}", row.id);
        }
        if let Some(error) = &row.deep_error {
            eprintln!("notemd: task {}: deep pass: {error}", row.id);
        }
        if let Some((path, file)) = sink.as_mut() {
            let mut line = serde_json::to_string(row).map_err(|e| format!("encode row: {e}"))?;
            line.push('\n');
            file.write_all(line.as_bytes()).and_then(|_| file.flush()).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(())
    };
    let rows =
        run_lookup_eval(index, root, &tasks, params, enhance.as_ref(), today_or_local(args), &client, &mut on_row).await?;
    let metrics: Vec<LookupMetrics> = ["all", "dev", "holdout"].iter().map(|s| lookup_metrics(&rows, s)).collect();
    let holdout: Vec<_> = rows.iter().filter(|r| r.split == Split::Holdout).cloned().collect();
    let gates = gate_verdicts(&holdout);
    let deltas = baseline.map(|b| compare_metrics(&metrics[0], &lookup_metrics(&b, "all")));

    let mut lines = Vec::new();
    if args.json {
        for m in &metrics {
            let mut value = serde_json::to_value(m).map_err(|e| e.to_string())?;
            if let Some(object) = value.as_object_mut() {
                object.insert("kind".into(), json!("metrics"));
            }
            lines.push(value.to_string());
        }
        let mut value = serde_json::to_value(&gates).map_err(|e| e.to_string())?;
        if let Some(object) = value.as_object_mut() {
            object.insert("kind".into(), json!("gates"));
        }
        lines.push(value.to_string());
        if let Some(deltas) = &deltas {
            lines.push(json!({ "kind": "compare", "deltas": deltas }).to_string());
        }
    } else {
        lines.extend(metrics_table(&metrics));
        lines.push(String::new());
        lines.push(gates_line(&gates));
        if let Some(deltas) = &deltas {
            lines.push(String::new());
            let rows: Vec<[String; 4]> = std::iter::once(["metric", "current", "baseline", "delta"].map(String::from))
                .chain(deltas.iter().map(|d| [d.metric.clone(), number(d.current), number(d.baseline), number(d.delta)]))
                .collect();
            lines.extend(align(&rows));
        }
    }
    write_lines(out, &lines);
    Ok(0)
}

/// `gates (holdout, timeout 3000 ms) · C3 pass · C4 fail (1 of 4 rescued)`;
/// at another limit both gates read `n/a (timeout ≠ 3 s)`.
fn gates_line(gates: &GateVerdicts) -> String {
    let timeout = gates.timeout_ms.map_or("mixed".to_string(), |t| format!("{t} ms"));
    let verdict = |v: Option<bool>| match (v, &gates.note) {
        (_, Some(note)) => format!("n/a ({note})"),
        (Some(true), None) => "pass".to_string(),
        (Some(false), None) => "fail".to_string(),
        (None, None) => "n/a".to_string(),
    };
    format!(
        "gates (holdout, timeout {timeout}) · C3 {} · C4 {} ({} of {} rescued)",
        verdict(gates.c3),
        verdict(gates.c4),
        gates.c4_rescued,
        gates.c4_tasks
    )
}

fn number(value: Option<f64>) -> String {
    match value {
        None => "-".to_string(),
        Some(v) if v.fract() == 0.0 => format!("{v:.0}"),
        Some(v) => format!("{v:.3}"),
    }
}

fn metrics_table(metrics: &[LookupMetrics]) -> Vec<String> {
    let columns: Vec<Vec<(&'static str, Option<f64>)>> = metrics.iter().map(metric_values).collect();
    let mut rows: Vec<Vec<String>> = vec![std::iter::once("metric".to_string()).chain(metrics.iter().map(|m| m.split.clone())).collect()];
    for (i, (metric, _)) in columns[0].iter().enumerate() {
        rows.push(std::iter::once(metric.to_string()).chain(columns.iter().map(|c| number(c[i].1))).collect());
    }
    align(&rows)
}

/// Left-aligned first column, right-aligned numbers.
fn align<R: AsRef<[String]>>(rows: &[R]) -> Vec<String> {
    let width = rows.first().map_or(0, |r| r.as_ref().len());
    let widths: Vec<usize> =
        (0..width).map(|c| rows.iter().map(|r| r.as_ref()[c].chars().count()).max().unwrap_or(0)).collect();
    rows.iter()
        .map(|row| {
            row.as_ref()
                .iter()
                .enumerate()
                .map(|(c, cell)| if c == 0 { format!("{cell:<w$}", w = widths[c]) } else { format!("{cell:>w$}", w = widths[c]) })
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_model::test_support::{serve_noul, serve_once, NoulServer};
    use std::sync::atomic::Ordering::SeqCst;
    use std::time::Duration;

    fn s(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|a| a.to_string()).collect()
    }

    struct Vault {
        root: tempfile::TempDir,
        _data: tempfile::TempDir,
        index: IndexHandle,
    }

    fn vault(files: &[(&str, &str)]) -> Vault {
        let root = tempfile::tempdir().unwrap();
        for (name, body) in files {
            std::fs::write(root.path().join(name), body).unwrap();
        }
        let data = tempfile::tempdir().unwrap();
        let mut idx = searchidx::SearchIndex::open_at(root.path(), &data.path().join("i.db"), "sync").unwrap();
        idx.sweep(&searchidx::ScanOptions::default(), None).unwrap();
        Vault { root, _data: data, index: Arc::new(Mutex::new(Some(idx))) }
    }

    /// Three public notes, each one line that matches `words` (three terms).
    fn three_notes(words: &str) -> Vault {
        vault(&[
            ("a.md", &format!("# A\n{words} first\n")),
            ("b.md", &format!("# B\n{words} second\n")),
            ("c.md", &format!("# C\n{words} third\n")),
        ])
    }

    fn answers(scores: &[f64]) -> String {
        let inner: Vec<String> =
            scores.iter().enumerate().map(|(i, s)| format!(r#""c{}":{{"type":"noul","noul":{s}}}"#, i + 1)).collect();
        format!(r#"{{"answers":{{{}}}}}"#, inner.join(","))
    }

    /// A Jev stand-in that scores each passage by its last word: `third`
    /// fit, `first` unfit, anything else unsure.
    async fn jev() -> NoulServer {
        serve_noul(
            |q| {
                let passage = q["instructions"]["candidate_passage"].as_str().unwrap_or("");
                if passage.ends_with("third") {
                    0.95
                } else if passage.ends_with("first") {
                    0.1
                } else {
                    0.5
                }
            },
            |_| Duration::ZERO,
        )
        .await
    }

    fn host(base: &str) -> String {
        crate::smart_model::endpoint_host(base).unwrap()
    }

    async fn query(argv: &[String], v: &Vault, env: &[(&str, &str)]) -> (u8, String) {
        let args = parse_args(argv, false);
        assert!(args.errors.is_empty(), "{:?}", args.errors);
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let lookup = |name: &str| env.get(name).cloned();
        let mut out = Vec::new();
        let code = run_query(&args, v.root.path(), &v.index, &LookupParams::default(), &lookup, &mut out).await.unwrap();
        (code, String::from_utf8(out).unwrap())
    }

    fn json_objects(out: &str) -> Vec<serde_json::Value> {
        out.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn kinds(objects: &[serde_json::Value]) -> Vec<String> {
        objects.iter().map(|o| o["kind"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn parse_args_reads_every_documented_flag() {
        let a = parse_args(
            &s(&[
                "--vault", "/v", "--params", "p.json", "--deep", "--time-mode", "window", "--jev-url",
                "https://j.example/v1", "--jev-model", "m", "--jev-auth", "none", "--chat-url",
                "https://c.example/v1", "--chat-model", "c", "--allow-send", "j.example", "上周", "发布",
            ]),
            false,
        );
        assert!(a.errors.is_empty(), "{:?}", a.errors);
        assert_eq!(
            (a.mode, a.question.join(" "), a.time_mode, a.jev_auth),
            (LookupMode::Query, "上周 发布".into(), Some(TimeMode::Window), Some(AuthMode::None))
        );
        assert_eq!((a.vault.as_deref(), a.params.as_deref()), (Some("/v"), Some(Path::new("p.json"))));
        assert!(a.deep && !a.no_enhance && !a.json);
        assert_eq!((a.jev_url.as_deref(), a.jev_model.as_deref()), (Some("https://j.example/v1"), Some("m")));
        assert_eq!((a.chat_url.as_deref(), a.chat_model.as_deref()), (Some("https://c.example/v1"), Some("c")));
        assert_eq!(a.allow_send.as_deref(), Some("j.example"));
        let e = parse_args(&s(&["eval", "--tasks", "t.json", "--out", "o.jsonl", "--compare", "b.jsonl", "--today", "2026-11-10"]), true);
        assert!(e.errors.is_empty(), "{:?}", e.errors);
        assert_eq!((e.mode, e.json), (LookupMode::Eval, true));
        assert_eq!((e.tasks.as_deref(), e.out.as_deref(), e.compare.as_deref()), (Some(Path::new("t.json")), Some(Path::new("o.jsonl")), Some(Path::new("b.jsonl"))));
        assert_eq!(e.today, NaiveDate::from_ymd_opt(2026, 11, 10));
        let dash = parse_args(&s(&["--no-enhance", "--json", "--", "--deep", "eval"]), false);
        assert!(dash.errors.is_empty() && dash.no_enhance && dash.json && !dash.deep);
        assert_eq!(dash.question, ["--deep", "eval"]);
        assert!(parse_args(&s(&["q"]), true).with_global_json(false).json);
    }

    #[test]
    fn parse_args_rejects_bad_values() {
        for argv in [
            &["--time-mode", "later", "q"][..],
            &["--jev-auth", "basic", "q"],
            &["--allow-send"],
            &["--bogus", "q"],
            &[],
            &["eval"],
            &["eval", "--today", "11/10", "--tasks", "t"],
            &["--deep", "--deep", "q"],
            &["--tasks", "t", "q"],
            &["eval", "--tasks", "t", "q"],
        ] {
            assert!(!parse_args(&s(argv), false).errors.is_empty(), "{argv:?}");
        }
        let leaked = parse_args(&s(&["--jev-key=sk-live-xyz", "q"]), false);
        assert!(leaked.errors.iter().all(|e| !e.contains("sk-live-xyz")), "{:?}", leaked.errors);
    }

    #[tokio::test]
    async fn judging_needs_allow_send_equal_to_the_endpoint_host() {
        let v = three_notes("consent alpha bravo charlie");
        let server = jev().await;
        let base = server.base.clone();
        let argv = |allow: &str| {
            s(&["--json", "--jev-url", &base, "--jev-model", "m", "--jev-auth", "none", "--allow-send", allow, "consent", "alpha", "bravo", "charlie"])
        };
        let (_, out) = query(&argv("other.example"), &v, &[]).await;
        let evidence = &json_objects(&out)[1];
        assert_eq!(evidence["kind"], "evidence");
        assert_eq!(evidence["result"]["status"], "noConsent", "{evidence}");
        assert_eq!(server.accepted.load(SeqCst), 0);
        // No --allow-send at all: the consent host is empty, nothing is sent.
        let no_flag = s(&["--json", "--jev-url", &base, "--jev-model", "m", "--jev-auth", "none", "consent", "alpha", "bravo", "charlie"]);
        let (_, out) = query(&no_flag, &v, &[]).await;
        assert_eq!(json_objects(&out)[1]["result"]["status"], "noConsent");
        assert_eq!(server.accepted.load(SeqCst), 0);
        let (code, out) = query(&argv(&host(&base)), &v, &[]).await;
        let evidence = &json_objects(&out)[1];
        assert_eq!(evidence["result"]["status"], "ok", "{evidence}");
        assert_eq!(code, 0);
        assert!(server.accepted.load(SeqCst) >= 1);
    }

    #[tokio::test]
    async fn keys_come_only_from_the_environment_and_never_reach_the_output() {
        let v = three_notes("keyed delta echo foxtrot");
        let server = jev().await;
        let base = server.base.clone();
        let env = [(JEV_KEY_ENV, "sk-live-xyz")];
        let argv = |json: bool| {
            let mut a = s(&["--jev-url", &base, "--jev-model", "m", "--allow-send", &host(&base), "keyed", "delta", "echo", "foxtrot"]);
            if json {
                a.insert(0, "--json".into());
            }
            a
        };
        let (_, text) = query(&argv(false), &v, &env).await;
        assert!(text.contains("evidence ok"), "{text}");
        let (_, json_out) = query(&argv(true), &v, &env).await;
        assert!(!text.contains("sk-live-xyz") && !json_out.contains("sk-live-xyz"), "{text}\n{json_out}");
        let heads = server.heads.lock().unwrap().clone();
        assert!(!heads.is_empty() && heads.iter().all(|h| h.contains("authorization: bearer sk-live-xyz")), "{heads:?}");
        // Bearer without a key in the environment: not configured, nothing sent.
        let v2 = three_notes("keyless golf hotel india");
        let server2 = jev().await;
        let base2 = server2.base.clone();
        let argv2 = s(&["--json", "--jev-url", &base2, "--jev-model", "m", "--allow-send", &host(&base2), "keyless", "golf", "hotel", "india"]);
        let (_, out) = query(&argv2, &v2, &[(JEV_KEY_ENV, "bad key with spaces")]).await;
        let evidence = &json_objects(&out)[1]["result"];
        assert_eq!((evidence["status"].as_str(), evidence["missing"].as_str()), (Some("notConfigured"), Some("key")), "{evidence}");
        assert!(!out.contains("bad key"), "{out}");
        assert_eq!(server2.accepted.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn json_lines_follow_the_documented_kinds() {
        let v = three_notes("shape juliet kilo lima");
        let server = jev().await;
        let base = server.base.clone();
        let argv = s(&["--json", "--jev-url", &base, "--jev-model", "m", "--jev-auth", "none", "--allow-send", &host(&base), "shape", "juliet", "kilo", "lima"]);
        let (code, out) = query(&argv, &v, &[]).await;
        let objects = json_objects(&out);
        let kinds = kinds(&objects);
        assert_eq!(kinds.first().map(String::as_str), Some("local"));
        assert_eq!(kinds.get(1).map(String::as_str), Some("evidence"));
        assert_eq!(kinds.last().map(String::as_str), Some("done"));
        let rounds = kinds.iter().filter(|k| *k == "evidence").count();
        assert!(kinds[1..=rounds].iter().all(|k| k == "evidence"), "{kinds:?}");
        assert!(kinds[1 + rounds..kinds.len() - 1].iter().all(|k| k == "hit"), "{kinds:?}");
        let local = &objects[0];
        assert!(local["extractedTerms"].as_array().is_some_and(|t| !t.is_empty()) && local["time"].is_null());
        let first = &objects[1]["result"];
        assert_eq!((first["status"].as_str(), first["hop"].as_u64()), (Some("ok"), Some(0)), "{first}");
        let hits = &objects[1 + rounds..objects.len() - 1];
        // Every local hit is listed once; the three are all evidence here.
        assert_eq!(hits.len() as u64, local["hitCount"].as_u64().unwrap());
        assert_eq!(hits.iter().filter(|h| !h["tier"].is_null()).count(), 3);
        assert!(hits.iter().any(|h| !h["movedFrom"].is_null()));
        // The fit block is first, and its tier is the evidence item's.
        assert_eq!((hits[0]["path"].as_str(), hits[0]["tier"].as_str()), (Some("c.md"), Some("fit")), "{:?}", hits[0]);
        let item = &first["evidence"][0];
        assert_eq!((item["path"].as_str(), item["tier"].as_str()), (Some("c.md"), Some("fit")), "{first}");
        for (i, hit) in hits.iter().enumerate() {
            assert_eq!(hit["rank"], i + 1);
            for key in ["path", "line", "lineEnd", "level", "text"] {
                assert!(!hit[key].is_null(), "{key} in {hit}");
            }
            assert!(hit["groups"].is_null());
        }
        let done = objects.last().unwrap();
        assert_eq!((done["route"].as_str(), done["exitCode"].as_u64()), (Some("judge"), Some(0)));
        assert_eq!(code, 0);
        assert!(done["totalMs"].is_u64());
    }

    #[tokio::test]
    async fn text_output_summarises_the_local_and_evidence_lines_then_lists_hits() {
        let v = three_notes("plain mike november oscar");
        let server = jev().await;
        let base = server.base.clone();
        let argv = s(&["--jev-url", &base, "--jev-model", "m", "--jev-auth", "none", "--allow-send", &host(&base), "plain", "mike", "november", "oscar"]);
        let (_, out) = query(&argv, &v, &[]).await;
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].starts_with("local ") && lines[0].contains(" hits · ") && lines[0].ends_with(" ms"), "{out}");
        assert!(lines[1].starts_with(&format!("evidence ok · {} · round 0 · 3 sent · ", host(&base))) && lines[1].ends_with(" 3 items"), "{out}");
        let first_hit = lines.iter().position(|l| l.starts_with("1. ")).unwrap();
        assert!(lines[1..first_hit].iter().all(|l| l.starts_with("evidence ")), "{out}");
        assert!(lines[first_hit].starts_with("1. c.md:") && lines[first_hit].contains(" [fit] "), "{out}");
        assert!(lines.iter().any(|l| l.contains(" [unfit] ")), "{out}");
        assert!(lines[first_hit..].iter().all(|l| !l.contains("[unsure]")), "{out}");
    }

    #[tokio::test]
    async fn zero_hits_diagnose_then_repair_through_the_fake_chat_server() {
        let v = three_notes("repair papa quebec romeo");
        let reply = serde_json::json!({
            "choices": [{"message": {"content": r#"{"groups":[{"terms":["papa"]},{"terms":["quebec"]}]}"#}}],
            "usage": {"prompt_tokens": 40, "completion_tokens": 12}
        })
        .to_string();
        let (base, _request, accepted) = serve_once(200, reply, Duration::ZERO).await;
        let argv = s(&["--json", "--chat-url", &base, "--chat-model", "c", "zulu", "yankee", "xray"]);
        let (code, out) = query(&argv, &v, &[(CHAT_KEY_ENV, "sk-chat-1")]).await;
        let objects = json_objects(&out);
        let kinds = kinds(&objects);
        assert_eq!(objects[0]["hitCount"], 0, "{out}");
        for kind in ["diagnosis", "repair", "regrouped"] {
            assert!(kinds.iter().any(|k| k == kind), "{kind} missing: {kinds:?}");
        }
        assert!(!out.contains("sk-chat-1"));
        let repair = objects.iter().find(|o| o["kind"] == "repair").unwrap();
        assert_eq!(repair["result"]["status"], "ok", "{repair}");
        assert_eq!(accepted.load(SeqCst), 1);
        let hits: Vec<&serde_json::Value> = objects.iter().filter(|o| o["kind"] == "hit").collect();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h["groups"].is_array()));
        let done = objects.last().unwrap();
        assert_eq!((done["route"].as_str(), done["exitCode"].as_u64(), code), (Some("repair"), Some(0), 0));
        // Without a chat model: diagnosis only, exit 1, nothing sent.
        let (code, out) = query(&s(&["zulu", "yankee", "xray"]), &v, &[]).await;
        assert_eq!(code, 1);
        assert!(out.lines().nth(1).is_some_and(|l| l.starts_with("diagnosis · ")), "{out}");
        assert_eq!(accepted.load(SeqCst), 1);
    }

    #[tokio::test]
    async fn no_enhance_or_missing_urls_send_nothing() {
        let v = three_notes("quiet sierra tango uniform");
        let (base, _request, accepted) = serve_once(200, answers(&[0.5, 0.5, 0.5]), Duration::ZERO).await;
        let words = ["quiet", "sierra", "tango", "uniform"];
        let with = |flags: &[&str]| s(&[flags, &words[..]].concat());
        let (code, out) = query(&with(&["--json", "--no-enhance", "--jev-url", &base, "--jev-model", "m", "--jev-auth", "none", "--allow-send", &host(&base)]), &v, &[]).await;
        let objects = json_objects(&out);
        assert_eq!(objects.last().unwrap()["route"], "local");
        assert_eq!(kinds(&objects)[1], "hit");
        assert_eq!(code, 0);
        assert_eq!(accepted.load(SeqCst), 0);
        let (_, out) = query(&with(&["--json", "--jev-url", &base, "--jev-auth", "none", "--allow-send", &host(&base)]), &v, &[]).await;
        let judge = &json_objects(&out)[1]["result"];
        assert_eq!((judge["status"].as_str(), judge["missing"].as_str()), (Some("notConfigured"), Some("url")), "{judge}");
        assert_eq!(accepted.load(SeqCst), 0);
        let (_, text) = query(&with(&["--no-enhance"]), &v, &[]).await;
        assert_eq!(text.lines().nth(1), Some("enhance off"));
    }

    #[tokio::test]
    async fn confidential_notes_are_not_sent_from_the_cli() {
        let words = "secret victor whiskey yoke";
        let v = vault(&[
            ("a.md", &format!("# A\n{words} first\n")),
            ("b.md", &format!("# B\n{words} second\n")),
            ("s.md", &format!("---\nprivate: true\n---\n# S\n{words} CLI_SECRET\n")),
        ]);
        let server = jev().await;
        let base = server.base.clone();
        let argv = s(&["--json", "--jev-url", &base, "--jev-model", "m", "--jev-auth", "none", "--allow-send", &host(&base), "secret", "victor", "whiskey", "yoke"]);
        let (_, out) = query(&argv, &v, &[]).await;
        let first = &json_objects(&out)[1]["result"];
        assert_eq!((first["status"].as_str(), first["skippedConfidential"].as_u64()), (Some("ok"), Some(1)), "{first}");
        let bodies = server.bodies.lock().unwrap().clone();
        assert!(!bodies.is_empty());
        assert!(bodies.iter().all(|b| !b.contains("CLI_SECRET") && b.contains("first")), "{bodies:?}");
    }

    #[tokio::test]
    async fn eval_prints_metrics_gates_and_a_comparison_and_writes_rows() {
        let v = three_notes("evalcli zeta eta theta");
        let dir = tempfile::tempdir().unwrap();
        let tasks = dir.path().join("tasks.json");
        std::fs::write(
            &tasks,
            r#"{"tasks":[
              {"id":"t1","question":"evalcli zeta eta theta","targets":[{"path":"b.md"}],"category":"exact","split":"dev"},
              {"id":"t2","question":"nothing like it here","targets":[],"category":"absent","split":"holdout"}
            ]}"#,
        )
        .unwrap();
        let rows_path = dir.path().join("rows.jsonl");
        let run = |extra: &[&str]| {
            let mut argv = s(&["eval", "--no-enhance", "--tasks", tasks.to_str().unwrap(), "--today", "2026-11-10"]);
            argv.extend(s(extra));
            parse_args(&argv, false)
        };
        let lookup = |_: &str| -> Option<String> { None };
        let mut out = Vec::new();
        let args = run(&["--json", "--out", rows_path.to_str().unwrap()]);
        assert!(args.errors.is_empty(), "{:?}", args.errors);
        let code = run_eval(&args, v.root.path(), &v.index, &LookupParams::default(), &lookup, &mut out).await.unwrap();
        assert_eq!(code, 0);
        let objects = json_objects(&String::from_utf8(out).unwrap());
        assert_eq!(kinds(&objects), ["metrics", "metrics", "metrics", "gates"]);
        let splits: Vec<&str> = objects[..3].iter().map(|o| o["split"].as_str().unwrap()).collect();
        assert_eq!(splits, ["all", "dev", "holdout"]);
        assert_eq!((objects[0]["tasks"].as_u64(), objects[1]["scored"].as_u64()), (Some(2), Some(1)));
        let rows = load_eval_rows(&std::fs::read_to_string(&rows_path).unwrap()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].route, Some(PipelineRoute::Local));

        let mut out = Vec::new();
        let args = run(&["--compare", rows_path.to_str().unwrap()]);
        run_eval(&args, v.root.path(), &v.index, &LookupParams::default(), &lookup, &mut out).await.unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.lines().next().is_some_and(|l| l.starts_with("metric") && l.contains("holdout")), "{text}");
        assert!(text.contains("gates (holdout, timeout 3000 ms) · C3 "), "{text}");
        assert!(text.lines().any(|l| l.starts_with("netGain") && l.trim_end().ends_with('0')), "{text}");
        // A broken baseline is an error naming the line, before any lookup.
        std::fs::write(&rows_path, "{bad}\n").unwrap();
        let err = run_eval(&run(&["--compare", rows_path.to_str().unwrap()]), v.root.path(), &v.index, &LookupParams::default(), &lookup, &mut Vec::new())
            .await
            .unwrap_err();
        assert!(err.contains("line 1"), "{err}");
    }

    #[tokio::test]
    async fn eval_gates_read_n_a_at_another_timeout_and_report_it() {
        let v = three_notes("slowgate iota kappa lambda");
        let dir = tempfile::tempdir().unwrap();
        let tasks = dir.path().join("tasks.json");
        std::fs::write(
            &tasks,
            r#"{"tasks":[{"id":"t1","question":"slowgate iota kappa lambda","targets":[{"path":"b.md"}],"category":"exact","split":"holdout"}]}"#,
        )
        .unwrap();
        let params = LookupParams {
            enhance: crate::lookup_params::EnhanceParams { timeout_ms: 5_000 },
            ..LookupParams::default()
        };
        let lookup = |_: &str| -> Option<String> { None };
        let argv = |json: bool| {
            let mut a = s(&["eval", "--no-enhance", "--tasks", tasks.to_str().unwrap()]);
            if json {
                a.push("--json".into());
            }
            parse_args(&a, false)
        };
        let mut out = Vec::new();
        run_eval(&argv(false), v.root.path(), &v.index, &params, &lookup, &mut out).await.unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains("gates (holdout, timeout 5000 ms) · C3 n/a (timeout ≠ 3 s) · C4 n/a (timeout ≠ 3 s)"),
            "{text}"
        );
        assert!(text.lines().any(|l| l.starts_with("timeoutMs") && l.trim_end().ends_with("5000")), "{text}");
        let mut out = Vec::new();
        run_eval(&argv(true), v.root.path(), &v.index, &params, &lookup, &mut out).await.unwrap();
        let objects = json_objects(&String::from_utf8(out).unwrap());
        let gates = objects.iter().find(|o| o["kind"] == "gates").unwrap();
        assert!(gates["c3"].is_null() && gates["c4"].is_null(), "{gates}");
        assert_eq!((gates["timeoutMs"].as_u64(), gates["note"].as_str()), (Some(5_000), Some("timeout ≠ 3 s")));
        assert_eq!(objects[0]["timeoutMs"], 5_000);
    }

    #[tokio::test]
    async fn a_chat_config_without_a_key_is_reported_by_the_host() {
        let v = three_notes("nokey phi chi psi");
        let (base, _request, accepted) = serve_once(200, "{}", Duration::ZERO).await;
        let argv = s(&["--json", "--chat-url", &base, "--chat-model", "c", "zulu", "yankee", "xray"]);
        let (code, out) = query(&argv, &v, &[]).await;
        let objects = json_objects(&out);
        let repair = objects.iter().find(|o| o["kind"] == "repair").expect("a repair line");
        assert_eq!(
            (repair["result"]["status"].as_str(), repair["result"]["missing"].as_str(), repair["result"]["requestCount"].as_u64()),
            (Some("notConfigured"), Some("key"), Some(0)),
            "{repair}"
        );
        assert_eq!((code, accepted.load(SeqCst)), (1, 0));
        let (_, text) = query(&s(&["--chat-url", &base, "--chat-model", "c", "zulu", "yankee", "xray"]), &v, &[]).await;
        assert!(text.lines().any(|l| l == "repair notConfigured · missing key"), "{text}");
        assert_eq!(accepted.load(SeqCst), 0);
    }

    /// Runs `run_with` with a fake host; returns (exit code, stdout, stderr).
    fn run_on(argv: &[&str], env: &[(&str, &str)], vault: Option<&Path>, index_ok: bool) -> (u8, String, String) {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let lookup = |name: &str| env.get(name).cloned();
        let resolve = |explicit: Option<&str>| explicit.map(PathBuf::from).or_else(|| vault.map(Path::to_path_buf));
        let data = tempfile::tempdir().unwrap();
        let open = |root: &Path| {
            if !index_ok {
                return None;
            }
            let mut idx = searchidx::SearchIndex::open_at(root, &data.path().join("i.db"), "sync").ok()?;
            idx.sweep(&searchidx::ScanOptions::default(), None).ok()?;
            Some(idx)
        };
        let host = Host { env: &lookup, app_data: None, resolve_vault: &resolve, open_index: &open };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_with(parse_args(&s(argv), false), &host, &mut out, &mut err);
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    #[test]
    fn run_exits_2_on_bad_arguments_params_vault_or_index() {
        let v = three_notes("exit omega sigma rho");
        let root = v.root.path();
        let code_of = |out: &str| serde_json::from_str::<serde_json::Value>(out.trim()).unwrap()["error"]["code"].as_str().unwrap().to_string();

        let (code, out, err) = run_on(&["--json", "--bogus", "q"], &[], Some(root), true);
        assert_eq!((code, code_of(&out).as_str(), err.as_str()), (2, "invalid_arguments", ""));

        let bad = root.join("bad-params.json");
        std::fs::write(&bad, r#"{"local":{"limit":0}}"#).unwrap();
        let (code, out, err) = run_on(&["--params", bad.to_str().unwrap(), "q"], &[], Some(root), true);
        assert_eq!((code, out.as_str()), (2, ""));
        assert!(err.starts_with("notemd: ") && err.contains("local.limit = 0 is outside 1..=100"), "{err}");
        let missing = root.join("missing.json");
        let (code, out, _) = run_on(&["--json", "q"], &[(PARAMS_ENV, missing.to_str().unwrap())], Some(root), true);
        assert_eq!((code, code_of(&out).as_str()), (2, "invalid_params"));
        assert!(out.contains("file not found"), "{out}");

        let (code, out, _) = run_on(&["--json", "q"], &[], None, true);
        assert_eq!((code, code_of(&out).as_str()), (2, "vault_not_configured"));
        let (code, _, err) = run_on(&["--vault", "/definitely/not/a/vault", "q"], &[], None, true);
        assert_eq!(code, 2);
        assert_eq!(err, "notemd: vault not found: /definitely/not/a/vault\n");

        let (code, out, _) = run_on(&["--json", "q"], &[], Some(root), false);
        assert_eq!((code, code_of(&out).as_str()), (2, "invalid_index"));
        let (code, _, err) = run_on(&["q"], &[], Some(root), false);
        assert_eq!(code, 2);
        assert!(err.contains("search index is unavailable") && !err.contains("scanning"), "{err}");

        // The happy paths: hits → 0, none → 1.
        let (code, out, _) = run_on(&["--no-enhance", "exit", "omega", "sigma", "rho"], &[], Some(root), true);
        assert_eq!(code, 0, "{out}");
        assert!(out.starts_with("local 3 hits"), "{out}");
        let (code, _, _) = run_on(&["--no-enhance", "nothing", "matches", "zzzq"], &[], Some(root), true);
        assert_eq!(code, 1);
    }
}
