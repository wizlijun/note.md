// Ported from SAG-Wiki 61f63c6 `core/src/models.rs` (jev_batches_with_runtime, estimate, score_with_runtime), MIT License,
// Copyright (c) 2026 sag contributors. Changes for note.md: see spec Appendix H.

//! SAG2 Jev requests: the `state` string, one noul question per candidate,
//! batching by the context budget, and one round of scoring (spec H.3.7).
//!
//! What is sent: the original question, earlier evidence and each candidate's
//! title (file name without extension), heading (breadcrumb) and passage.
//! Never a Vault path. Which blocks may be sent at all (confidentiality,
//! consent) is decided by the caller before a candidate reaches this module.

use std::time::Duration;

use futures_util::stream::{self, StreamExt, TryStreamExt};
use serde::Serialize;
use serde_json::{json, Value};

use super::{SagCandidate, CRITERIA_FALSE, CRITERIA_TRUE, CRITERION, SCORE_NOTE};
use crate::smart_enhance::candidates::estimate_tokens;
use crate::smart_enhance::judge::{CRITERIA_FALSE as DIRECT_FALSE, CRITERIA_TRUE as DIRECT_TRUE};
use crate::smart_enhance::CancelFlag;
use crate::smart_model::{score_noul, JevConfig, ModelError, NoulQuestion};

/// The question wording (defined with the parameters, `judge.preset`; P7).
pub(crate) use crate::lookup_params::Preset;

/// Batches in flight at once (`RuntimeSettings::jev_concurrency` default).
const JEV_CONCURRENCY: usize = 20;

/// Fields we add after SAG2's three `state` fields (spec H.3.7). Both are
/// omitted when empty, so a lookup without filters or time sends SAG2's
/// `state` byte for byte.
#[derive(Default, Clone, Debug, PartialEq)]
pub(crate) struct StateExtras {
    /// `render_filters` output.
    pub explicit_filters: Vec<String>,
    /// Set when `time.mode` is not `ignore` and a time was recognised.
    pub time_range: Option<TimeRange>,
}

#[derive(Default, Clone, Debug, PartialEq, Serialize)]
pub(crate) struct TimeRange {
    pub after: String,
    pub before: String,
    pub source_text: String,
}

/// `state`, in SAG2's key order (serde serialises struct fields in
/// declaration order; our serde_json has no `preserve_order`).
#[derive(Serialize)]
struct State<'a> {
    original_question: &'a str,
    previously_retrieved_evidence: Vec<Passage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence_score_note: Option<&'static str>,
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    explicit_filters: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    time_range: Option<&'a TimeRange>,
}

#[derive(Serialize)]
struct Passage<'a> {
    title: &'a str,
    passage: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    heading: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_jev_score: Option<f64>,
}

/// The compact `state` string of `jev_batches_with_runtime` (its
/// `encode_state` closure), plus [`StateExtras`].
pub(crate) fn encode_state(question: &str, evidence: &[SagCandidate], extras: &StateExtras) -> String {
    let state = State {
        original_question: question,
        previously_retrieved_evidence: evidence
            .iter()
            .map(|c| Passage {
                title: &c.title,
                passage: &c.content,
                heading: &c.heading,
                previous_jev_score: c.previous_score,
            })
            .collect(),
        evidence_score_note: evidence.iter().any(|c| c.previous_score.is_some()).then_some(SCORE_NOTE),
        explicit_filters: &extras.explicit_filters,
        time_range: extras.time_range.as_ref(),
    };
    serde_json::to_string(&state).expect("state serialises")
}

/// One noul question, id `candidate_{id}`. `Sag2V10` asks [`CRITERION`] with
/// SAG2's criteria; `DirectMatch` asks `criterion` with `judge.rs`'s criteria.
/// The instructions have the same shape either way.
pub(crate) fn question_for(c: &SagCandidate, preset: Preset, criterion: &str) -> NoulQuestion {
    let (question, criteria_true, criteria_false) = match preset {
        Preset::Sag2V10 => (CRITERION, CRITERIA_TRUE, CRITERIA_FALSE),
        Preset::DirectMatch => (criterion, DIRECT_TRUE, DIRECT_FALSE),
    };
    let mut instructions = json!({
        "question": question,
        "candidate_title": c.title,
        "candidate_passage": c.content,
    });
    if !c.heading.is_empty() {
        instructions["candidate_heading"] = json!(c.heading);
    }
    NoulQuestion {
        id: format!("candidate_{}", c.id),
        instructions,
        criteria_true: criteria_true.to_string(),
        criteria_false: criteria_false.to_string(),
    }
}

/// `models.rs:estimate`, with strings counted by `estimate_tokens` instead of
/// tokenx (spec H.5).
pub(crate) fn estimate_value(v: &Value, cjk: u32, other: u32) -> u64 {
    match v {
        Value::String(text) => estimate_tokens(text, cjk, other),
        Value::Array(items) => 2 + items.iter().map(|item| estimate_value(item, cjk, other)).sum::<u64>(),
        Value::Object(fields) => {
            2 + fields
                .iter()
                .map(|(key, value)| estimate_tokens(key, cjk, other) + estimate_value(value, cjk, other) + 4)
                .sum::<u64>()
        }
        Value::Number(number) => (number.to_string().len() as u64).div_ceil(3),
        Value::Bool(_) | Value::Null => 1,
    }
}

/// The question as it goes on the wire (`score_noul`'s body entry), which is
/// what SAG2 estimates (D1).
fn wire_question(q: &NoulQuestion) -> Value {
    json!({
        "type": "noul",
        "instructions": q.instructions,
        "criteria": {"true": q.criteria_true, "false": q.criteria_false},
    })
}

/// One request: questions and their candidates in pool order. `estimated` is
/// the request's budget estimate: `estimate(state) + 1024 + Σ(estimate(question) + 64)`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Batch {
    pub questions: Vec<NoulQuestion>,
    pub items: Vec<SagCandidate>,
    pub estimated: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BatchError {
    /// The evidence alone leaves no room for a question (SAG2:
    /// 「已有证据超过上下文预算」); nothing is sent.
    EvidenceTooLarge,
}

/// `jev_batches_with_runtime`: split `pool` into requests under
/// `context_tokens`. A candidate too large for a request of its own is skipped
/// (never truncated); the second value counts them.
pub(crate) fn jev_batches(
    state: &str,
    pool: Vec<SagCandidate>,
    preset: Preset,
    criterion: &str,
    context_tokens: u64,
    cjk: u32,
    other: u32,
) -> Result<(Vec<Batch>, usize), BatchError> {
    let prepared = pool
        .into_iter()
        .map(|c| {
            let question = question_for(&c, preset, criterion);
            let n = estimate_value(&wire_question(&question), cjk, other) + 64;
            (c, question, n)
        })
        .collect::<Vec<_>>();
    let base = estimate_value(&Value::String(state.to_string()), cjk, other) + 1024;
    if base + 64 > context_tokens {
        return Err(BatchError::EvidenceTooLarge);
    }
    let mut size = base;
    let mut questions = vec![];
    let mut items = vec![];
    let mut batches = vec![];
    let mut skipped = 0;
    for (c, question, n) in prepared {
        if base + n > context_tokens {
            // One oversized passage (a table or a file without sentence
            // breaks) cannot be scored; leaving it out keeps the query alive.
            crate::log_cat!("search", "info", "SAG2 skipped block {} larger than one Jev request", c.id);
            skipped += 1;
            continue;
        }
        if size + n > context_tokens {
            batches.push(Batch {
                questions: std::mem::take(&mut questions),
                items: std::mem::take(&mut items),
                estimated: size,
            });
            size = base;
        }
        size += n;
        questions.push(question);
        items.push(c);
    }
    if !items.is_empty() {
        batches.push(Batch { questions, items, estimated: size });
    }
    Ok((batches, skipped))
}

/// One scored round: every batch's candidates with `score = noul`, in batch
/// order. `usage` sums `(input, output)` over the batches that report it and
/// is `None` when none does (D4).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RoundScore {
    pub scored: Vec<SagCandidate>,
    pub requests: u32,
    pub usage: Option<(u64, u64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RoundError {
    /// The first failing batch (in batch order); `Timeout` when `deadline` passed.
    Model(ModelError),
    Cancelled,
}

/// `score_with_runtime` without retries or splitting (spec H.3.7, G.3): one
/// `score_noul` per batch, at most 20 in flight, all under one `deadline`.
/// Any failing batch fails the round; a cancel ends it at once.
pub(crate) async fn score_round(
    client: &reqwest::Client,
    jev: &JevConfig,
    key: Option<&str>,
    state: &str,
    batches: Vec<Batch>,
    deadline: Duration,
    cancel: &CancelFlag,
) -> Result<RoundScore, RoundError> {
    if cancel.is_cancelled() {
        return Err(RoundError::Cancelled);
    }
    let requests = batches.len() as u32;
    let work = async {
        let outcomes: Vec<(Vec<SagCandidate>, Option<(u64, u64)>)> = stream::iter(batches.into_iter().map(|batch| async move {
            // Each request may use the whole round; the outer timeout ends
            // the round when the shared deadline passes.
            let outcome = score_noul(client, jev, key, state, &batch.questions, deadline).await?;
            let mut items = batch.items;
            for (item, (id, noul)) in items.iter_mut().zip(outcome.scores) {
                debug_assert_eq!(id, format!("candidate_{}", item.id));
                item.score = noul;
            }
            Ok::<_, ModelError>((items, outcome.usage.map(|u| (u.input_tokens, u.output_tokens))))
        }))
        .buffered(JEV_CONCURRENCY)
        .try_collect()
        .await?;
        let mut scored = vec![];
        let mut usage: Option<(u64, u64)> = None;
        for (items, reported) in outcomes {
            scored.extend(items);
            if let Some((input, output)) = reported {
                let (i, o) = usage.unwrap_or((0, 0));
                usage = Some((i + input, o + output));
            }
        }
        Ok::<_, ModelError>(RoundScore { scored, requests, usage })
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(RoundError::Cancelled),
        done = tokio::time::timeout(deadline, work) => match done {
            Err(_) => Err(RoundError::Model(ModelError::Timeout)),
            Ok(result) => result.map_err(RoundError::Model),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smart_model::AuthMode;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, LazyLock, Mutex};
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    static ORACLE: LazyLock<Value> =
        LazyLock::new(|| serde_json::from_str(include_str!("fixtures/sag2_v10_oracle.json")).unwrap());

    /// `cases[0].requests[2].state` of the oracle fixture (spec H.9).
    static ORACLE_CASE1_REQ2_STATE: LazyLock<String> =
        LazyLock::new(|| ORACLE["cases"][0]["requests"][2]["state"].as_str().unwrap().to_string());

    fn cand(id: i64, title: &str, heading: &str, content: &str) -> SagCandidate {
        SagCandidate {
            id,
            path: format!("private/dir/{title}.md"),
            line: 1,
            line_end: 1,
            title: title.into(),
            heading: heading.into(),
            content: content.into(),
            bm25: -1.0,
            score: 0.0,
            previous_score: None,
            order: id as usize,
        }
    }

    fn ev(title: &str, passage: &str, previous: f64) -> SagCandidate {
        SagCandidate { previous_score: Some(previous), ..cand(0, title, "", passage) }
    }

    #[test]
    fn state_matches_sag2_byte_for_byte() {
        // oracle 第 1 题第 3 个请求的 state（spec H.9），夹具字符串原样
        let ev = vec![
            ev("Multiple", "Alice Paul birthplace Bob Smith.", 0.95),
            ev("Anchor", "Anchor birthplace depicts Alice Paul. Alice Paul. Bob Smith.", 0.8),
            ev("High", "Anchor highname commonname.", 0.7),
            ev("Series", "Anchor lowname commonname.", 0.08),
            ev("Single", "Alice Paul birthplace missing text.", 0.01),
            ev("Record 0", "Bob Smith.", 0.01),
        ];
        assert_eq!(encode_state("Anchor birthplace depicts", &ev, &StateExtras::default()), *ORACLE_CASE1_REQ2_STATE);
        assert_eq!(
            encode_state("Anchor birthplace depicts", &[], &StateExtras::default()),
            r#"{"original_question":"Anchor birthplace depicts","previously_retrieved_evidence":[]}"#
        );
    }

    #[test]
    fn every_oracle_state_without_scores_or_headings_round_trips() {
        // The other oracle states: no previous scores means no score note.
        for case in ORACLE["cases"].as_array().unwrap() {
            for request in case["requests"].as_array().unwrap() {
                let expected = request["state"].as_str().unwrap();
                let parsed: Value = serde_json::from_str(expected).unwrap();
                let evidence: Vec<SagCandidate> = parsed["previously_retrieved_evidence"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| SagCandidate {
                        previous_score: p.get("previous_jev_score").and_then(Value::as_f64),
                        ..cand(
                            0,
                            p["title"].as_str().unwrap(),
                            p.get("heading").and_then(Value::as_str).unwrap_or(""),
                            p["passage"].as_str().unwrap(),
                        )
                    })
                    .collect();
                let question = parsed["original_question"].as_str().unwrap();
                assert_eq!(encode_state(question, &evidence, &StateExtras::default()), expected);
            }
        }
    }

    #[test]
    fn heading_goes_after_passage_and_only_when_present() {
        let c = SagCandidate { previous_score: Some(0.5), ..cand(1, "T", "A > B", "p") };
        assert_eq!(
            encode_state("q", &[c, cand(2, "U", "", "r")], &StateExtras::default()),
            format!(
                r#"{{"original_question":"q","previously_retrieved_evidence":[{{"title":"T","passage":"p","heading":"A > B","previous_jev_score":0.5}},{{"title":"U","passage":"r"}}],"evidence_score_note":"{SCORE_NOTE}"}}"#
            )
        );
    }

    #[test]
    fn extras_follow_sag2_fields_and_are_omitted_when_empty() {
        let s = encode_state("q", &[], &StateExtras { explicit_filters: vec!["tag:x".into()], time_range: None });
        assert_eq!(s, r#"{"original_question":"q","previously_retrieved_evidence":[],"explicit_filters":["tag:x"]}"#);
        let time = TimeRange { after: "2026-01-01".into(), before: "2026-02-01".into(), source_text: "一月".into() };
        let evidence = [SagCandidate { previous_score: Some(0.25), ..cand(3, "T", "", "p") }];
        let s = encode_state(
            "q",
            &evidence,
            &StateExtras { explicit_filters: vec!["tag:x".into(), "path:a".into()], time_range: Some(time) },
        );
        assert_eq!(
            s,
            format!(
                r#"{{"original_question":"q","previously_retrieved_evidence":[{{"title":"T","passage":"p","previous_jev_score":0.25}}],"evidence_score_note":"{SCORE_NOTE}","explicit_filters":["tag:x","path:a"],"time_range":{{"after":"2026-01-01","before":"2026-02-01","source_text":"一月"}}}}"#
            )
        );
    }

    #[test]
    fn question_shape_follows_preset() {
        let q = question_for(&cand(7, "T", "h1", "body"), Preset::Sag2V10, "ignored");
        assert_eq!(q.id, "candidate_7");
        assert_eq!(
            q.instructions,
            json!({"question": CRITERION, "candidate_title": "T", "candidate_passage": "body", "candidate_heading": "h1"})
        );
        assert_eq!((q.criteria_true.as_str(), q.criteria_false.as_str()), (CRITERIA_TRUE, CRITERIA_FALSE));
        let d = question_for(&cand(7, "T", "", "body"), Preset::DirectMatch, "准则");
        assert_eq!(d.instructions["question"], "准则");
        assert!(d.instructions.get("candidate_heading").is_none());
        assert_eq!((d.criteria_true.as_str(), d.criteria_false.as_str()), (DIRECT_TRUE, DIRECT_FALSE));
        assert_eq!(d.instructions, json!({"question": "准则", "candidate_title": "T", "candidate_passage": "body"}));
    }

    #[test]
    fn questions_equal_every_oracle_question() {
        // Each fixture question rebuilt from its own title / heading / passage
        // and id equals the fixture entry, criteria included.
        let mut checked = 0;
        for case in ORACLE["cases"].as_array().unwrap() {
            for request in case["requests"].as_array().unwrap() {
                for (key, expected) in request["questions"].as_object().unwrap() {
                    let id: i64 = key.strip_prefix("candidate_").unwrap().parse().unwrap();
                    let i = &expected["instructions"];
                    let c = cand(
                        id,
                        i["candidate_title"].as_str().unwrap(),
                        i.get("candidate_heading").and_then(Value::as_str).unwrap_or(""),
                        i["candidate_passage"].as_str().unwrap(),
                    );
                    let q = question_for(&c, Preset::Sag2V10, "");
                    assert_eq!(&q.id, key);
                    assert_eq!(&wire_question(&q), expected);
                    checked += 1;
                }
            }
        }
        assert!(checked > 10, "{checked}");
    }

    #[test]
    fn estimate_follows_sag2_structure() {
        // String: estimate_tokens; array 2 + Σ; object 2 + Σ(key + value + 4);
        // number ceil(len / 3); bool and null 1.
        assert_eq!(estimate_value(&json!("abcdefgh"), 1, 4), 2);
        assert_eq!(estimate_value(&json!("中文ab"), 1, 4), 3);
        assert_eq!(estimate_value(&json!([true, null, "abcd"]), 1, 4), 2 + 1 + 1 + 1);
        assert_eq!(estimate_value(&json!({"ab": 1234}), 1, 4), 2 + (1 + 2 + 4));
        assert_eq!(estimate_value(&json!(0.95), 1, 4), 2);
        assert_eq!(estimate_value(&json!({}), 1, 4), 2);
    }

    /// Candidates whose passages estimate to the given token counts (`x` × 4n).
    fn pool_of_sizes(sizes: &[usize]) -> Vec<SagCandidate> {
        sizes.iter().enumerate().map(|(i, n)| cand(i as i64, "T", "", &"x".repeat(n * 4))).collect()
    }

    #[test]
    fn batches_split_on_budget_skip_oversize_and_reject_large_evidence() {
        // context 2000：base = estimate(state)+1024；n = estimate(question)+64
        let state = encode_state("q", &[], &StateExtras::default());
        let huge_state = encode_state("q", &[cand(9, "T", "", &"x".repeat(4 * 1000))], &StateExtras::default());
        let (b, skipped) = jev_batches(&state, pool_of_sizes(&[200, 200, 5000, 200]), Preset::Sag2V10, "", 2000, 1, 4).unwrap();
        assert_eq!(skipped, 1);
        assert!(b.iter().all(|b| b.estimated <= 2000));
        assert_eq!(b.iter().flat_map(|b| b.items.iter().map(|c| c.id)).collect::<Vec<_>>(), vec![0, 1, 3]); // 原顺序
        assert!(matches!(
            jev_batches(&huge_state, vec![], Preset::Sag2V10, "", 2000, 1, 4),
            Err(BatchError::EvidenceTooLarge)
        ));

        // Exact arithmetic: one question with a 200-token passage.
        let base = estimate_value(&Value::String(state.clone()), 1, 4) + 1024;
        let n = estimate_value(&wire_question(&question_for(&pool_of_sizes(&[200])[0], Preset::Sag2V10, "")), 1, 4) + 64;
        assert!(n > 200 + 64);
        // Two fit, the third opens a new batch.
        let ctx = base + 2 * n;
        let (b, skipped) = jev_batches(&state, pool_of_sizes(&[200, 200, 200]), Preset::Sag2V10, "", ctx, 1, 4).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(b.iter().map(|b| b.items.len()).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(b.iter().map(|b| b.estimated).collect::<Vec<_>>(), vec![base + 2 * n, base + n]);
        assert_eq!(b[0].questions.iter().map(|q| q.id.as_str()).collect::<Vec<_>>(), ["candidate_0", "candidate_1"]);
        // base + n exactly at the limit still fits; one less is skipped.
        assert_eq!(jev_batches(&state, pool_of_sizes(&[200]), Preset::Sag2V10, "", base + n, 1, 4).unwrap().1, 0);
        let (b, skipped) = jev_batches(&state, pool_of_sizes(&[200]), Preset::Sag2V10, "", base + n - 1, 1, 4).unwrap();
        assert_eq!((b.len(), skipped), (0, 1));
        // base + 64 exactly at the limit is not an error.
        assert!(jev_batches(&state, vec![], Preset::Sag2V10, "", base + 64, 1, 4).unwrap().0.is_empty());
        assert_eq!(
            jev_batches(&state, vec![], Preset::Sag2V10, "", base + 63, 1, 4),
            Err(BatchError::EvidenceTooLarge)
        );
    }

    // ---- score_round against a local stand-in --------------------------------

    struct Reply {
        status: u16,
        delay: Duration,
        usage: Option<(u64, u64)>,
    }

    struct Fake {
        base: String,
        bodies: Arc<Mutex<Vec<String>>>,
        accepted: Arc<AtomicUsize>,
        max_in_flight: Arc<AtomicUsize>,
    }

    /// Answers each question `candidate_{id}` with `noul = id / 100`; `reply`
    /// picks status, delay and usage from the request's question ids.
    async fn fake(reply: impl Fn(&[i64]) -> Reply + Send + Sync + 'static) -> Fake {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(vec![]));
        let accepted = Arc::new(AtomicUsize::new(0));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_in_flight = Arc::new(AtomicUsize::new(0));
        let reply = Arc::new(reply);
        let fake = Fake { base, bodies: bodies.clone(), accepted: accepted.clone(), max_in_flight: max_in_flight.clone() };
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                accepted.fetch_add(1, Ordering::SeqCst);
                let (bodies, reply, in_flight, max_in_flight) =
                    (bodies.clone(), reply.clone(), in_flight.clone(), max_in_flight.clone());
                tokio::spawn(async move {
                    let mut received = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let body = loop {
                        let read = stream.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        received.extend_from_slice(&chunk[..read]);
                        let text = String::from_utf8_lossy(&received).to_string();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end]
                                .lines()
                                .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_string()))
                                .and_then(|v| v.parse::<usize>().ok())
                                .unwrap_or(0);
                            if received.len() >= end + 4 + length {
                                break String::from_utf8_lossy(&received[end + 4..end + 4 + length]).to_string();
                            }
                        }
                    };
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    max_in_flight.fetch_max(now, Ordering::SeqCst);
                    bodies.lock().unwrap().push(body.clone());
                    let parsed: Value = serde_json::from_str(&body).unwrap();
                    let ids: Vec<i64> = parsed["questions"]
                        .as_object()
                        .unwrap()
                        .keys()
                        .map(|k| k.strip_prefix("candidate_").unwrap().parse().unwrap())
                        .collect();
                    let r = reply(&ids);
                    tokio::time::sleep(r.delay).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    let answers: serde_json::Map<String, Value> = ids
                        .iter()
                        .map(|id| (format!("candidate_{id}"), json!({"type": "noul", "noul": *id as f64 / 100.0})))
                        .collect();
                    let mut out = json!({"answers": answers});
                    if let Some((i, o)) = r.usage {
                        out["usage"] = json!({"input_tokens": i, "output_tokens": o});
                    }
                    let out = if r.status == 200 { out.to_string() } else { "oops".to_string() };
                    let response = format!(
                        "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                        r.status,
                        out.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        fake
    }

    fn ok(delay_ms: u64) -> Reply {
        Reply { status: 200, delay: Duration::from_millis(delay_ms), usage: None }
    }

    fn config(base: &str) -> JevConfig {
        JevConfig { url: base.into(), model: "jev-latest".into(), auth_mode: AuthMode::None }
    }

    /// Batches of the given ids, one candidate list per batch.
    fn batches(groups: &[&[i64]]) -> Vec<Batch> {
        groups
            .iter()
            .map(|ids| {
                let items: Vec<SagCandidate> = ids.iter().map(|&id| cand(id, "T", "", &format!("passage {id}"))).collect();
                Batch {
                    questions: items.iter().map(|c| question_for(c, Preset::Sag2V10, "")).collect(),
                    items,
                    estimated: 0,
                }
            })
            .collect()
    }

    #[tokio::test]
    async fn a_failing_batch_fails_the_round_and_results_keep_batch_order() {
        // 本机假服务：第 2 批 500 → Err(Model(Http(500)))
        let server = fake(|ids| if ids.contains(&3) { Reply { status: 500, ..ok(0) } } else { ok(0) }).await;
        let client = reqwest::Client::new();
        let cancel = CancelFlag::new();
        let result = score_round(
            &client,
            &config(&server.base),
            None,
            "{}",
            batches(&[&[1, 2], &[3], &[4]]),
            Duration::from_secs(5),
            &cancel,
        )
        .await;
        assert_eq!(result, Err(RoundError::Model(ModelError::Http(500))));

        // 全部 200 → scored 按批次顺序，score = noul，requests = 批数.
        // The first batch answers last; the order is still batch order.
        let server = fake(|ids| if ids.contains(&9) { ok(200) } else { ok(0) }).await;
        let state = encode_state("q", &[], &StateExtras::default());
        let round = score_round(
            &client,
            &config(&server.base),
            None,
            &state,
            batches(&[&[9, 2], &[5], &[7, 1]]),
            Duration::from_secs(5),
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(round.requests, 3);
        assert_eq!(round.scored.iter().map(|c| c.id).collect::<Vec<_>>(), vec![9, 2, 5, 7, 1]);
        assert_eq!(round.scored.iter().map(|c| c.score).collect::<Vec<_>>(), vec![0.09, 0.02, 0.05, 0.07, 0.01]);
        assert_eq!(round.usage, None);
        assert_eq!(server.accepted.load(Ordering::SeqCst), 3);

        // Every request carries the shared state and the model; never a path.
        let bodies = server.bodies.lock().unwrap().clone();
        assert_eq!(bodies.len(), 3);
        for body in &bodies {
            assert!(!body.contains("private/dir"), "{body}");
            let v: Value = serde_json::from_str(body).unwrap();
            assert_eq!(v["state"], state);
            assert_eq!(v["model"], "jev-latest");
        }
    }

    #[tokio::test]
    async fn usage_sums_only_the_batches_that_report_it() {
        let server = fake(|ids| match ids[0] {
            1 => Reply { usage: Some((100, 3)), ..ok(0) },
            3 => Reply { usage: Some((50, 2)), ..ok(0) },
            _ => ok(0),
        })
        .await;
        let client = reqwest::Client::new();
        let round = score_round(
            &client,
            &config(&server.base),
            None,
            "{}",
            batches(&[&[1], &[2], &[3]]),
            Duration::from_secs(5),
            &CancelFlag::new(),
        )
        .await
        .unwrap();
        assert_eq!(round.usage, Some((150, 5)));
    }

    #[tokio::test]
    async fn no_batches_send_nothing() {
        let client = reqwest::Client::new();
        let config = config("http://127.0.0.1:9/v1");
        let round = score_round(&client, &config, None, "{}", vec![], Duration::from_secs(1), &CancelFlag::new())
            .await
            .unwrap();
        assert_eq!(round, RoundScore { scored: vec![], requests: 0, usage: None });
    }

    #[tokio::test]
    async fn one_deadline_covers_all_batches_and_cancel_wins() {
        // 假服务延迟 300ms、deadline 100ms → Timeout
        let server = fake(|_| ok(300)).await;
        let client = reqwest::Client::new();
        let started = Instant::now();
        let result = score_round(
            &client,
            &config(&server.base),
            None,
            "{}",
            batches(&[&[1], &[2]]),
            Duration::from_millis(100),
            &CancelFlag::new(),
        )
        .await;
        assert_eq!(result, Err(RoundError::Model(ModelError::Timeout)));
        assert!(started.elapsed() < Duration::from_millis(290), "{:?}", started.elapsed());

        // cancel 先触发 → Cancelled, and nothing is sent.
        let cancel = CancelFlag::new();
        cancel.cancel();
        let server = fake(|_| ok(0)).await;
        let result =
            score_round(&client, &config(&server.base), None, "{}", batches(&[&[1]]), Duration::from_secs(5), &cancel)
                .await;
        assert_eq!(result, Err(RoundError::Cancelled));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(server.accepted.load(Ordering::SeqCst), 0);

        // A cancel while requests are in flight ends the round at once.
        let server = fake(|_| ok(2_000)).await;
        let cancel = Arc::new(CancelFlag::new());
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            trigger.cancel();
        });
        let started = Instant::now();
        let result = score_round(
            &client,
            &config(&server.base),
            None,
            "{}",
            batches(&[&[1], &[2]]),
            Duration::from_secs(5),
            &cancel,
        )
        .await;
        assert_eq!(result, Err(RoundError::Cancelled));
        assert!(started.elapsed() < Duration::from_millis(1_500), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn at_most_twenty_batches_in_flight_under_the_one_deadline() {
        // 21 batches of 400 ms each: the first 20 run together, the 21st only
        // after one of them finishes, so it ends near 800 ms. A per-request
        // limit of 600 ms would pass; the shared 600 ms deadline does not.
        let server = fake(|_| ok(400)).await;
        let client = reqwest::Client::new();
        let groups: Vec<Vec<i64>> = (1..=21).map(|id| vec![id]).collect();
        let refs: Vec<&[i64]> = groups.iter().map(Vec::as_slice).collect();
        let result = score_round(
            &client,
            &config(&server.base),
            None,
            "{}",
            batches(&refs),
            Duration::from_millis(600),
            &CancelFlag::new(),
        )
        .await;
        assert_eq!(result, Err(RoundError::Model(ModelError::Timeout)));
        assert_eq!(server.max_in_flight.load(Ordering::SeqCst), 20);

        // With room for both waves the round succeeds, still never over 20.
        let server = fake(|_| ok(100)).await;
        let round = score_round(
            &client,
            &config(&server.base),
            None,
            "{}",
            batches(&refs),
            Duration::from_secs(10),
            &CancelFlag::new(),
        )
        .await
        .unwrap();
        assert_eq!(round.requests, 21);
        assert_eq!(round.scored.iter().map(|c| c.id).collect::<Vec<_>>(), (1..=21).collect::<Vec<_>>());
        assert!(server.max_in_flight.load(Ordering::SeqCst) <= 20);
    }
}
