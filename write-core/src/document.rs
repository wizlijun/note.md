use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use unicode_segmentation::UnicodeSegmentation;
use uuid::Uuid;
use yrs::{types::EntryChange, Observable};
#[path = "candidate.rs"]
mod candidate;
pub use candidate::{CandidateCommit, CandidateSession};
#[path = "selection.rs"]
mod selection;
pub use selection::SelectionAnchor;
use yrs::types::Attrs;
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{
    Any, Assoc, Doc, GetString, IndexedSequence, Map, MapRef, OffsetKind, Options, ReadTxn,
    StateVector, StickyIndex, Text, TextRef, Transact, Update,
};

pub const SCHEMA: u32 = 1;
pub const MAX_BODY_UTF16: u32 = 1_000_000;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid document: {0}")]
    Invalid(String),
    #[error("edit does not match current revision")]
    StaleRevision,
    #[error("offset splits a Unicode grapheme or is out of bounds")]
    InvalidOffset,
    #[error("document exceeds capacity")]
    Capacity,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LineSnapshot {
    pub id: String,
    pub text: String,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub time_source: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub page_id: String,
    pub epoch: u32,
    pub revision: u64,
    pub body: String,
    pub root_line_id: String,
    pub lines: Vec<LineSnapshot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimingSpan {
    pub start: StickyIndex,
    pub end: StickyIndex,
    pub first_ms: Option<i64>,
    pub touch: bool,
    pub origins: Vec<(u64, u32, u32)>,
    #[serde(default)]
    pub carried_last_ms: Option<i64>,
    #[serde(default)]
    pub carried_sources: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimingEvent {
    pub at_ms: i64,
    pub source: String,
    pub spans: Vec<TimingSpan>,
}

#[derive(Clone)]
struct LineTime {
    id: String,
    first: Option<i64>,
    last: Option<i64>,
    source: String,
}
impl From<&LineSnapshot> for LineTime {
    fn from(l: &LineSnapshot) -> Self {
        Self {
            id: l.id.clone(),
            first: l.first_ms,
            last: l.last_ms,
            source: l.time_source.clone(),
        }
    }
}
struct HistoryTimes {
    before: Vec<LineTime>,
    after: Vec<LineTime>,
}

/// Validated off-thread, committed only if the live causal baseline still matches.
pub struct PreparedRemote {
    base_revision: u64,
    causal: yrs::Snapshot,
    pending_hash: Option<String>,
    update: Arc<[u8]>,
    token: Option<CandidateCommit>,
    actors: std::collections::HashMap<u64, u32>,
    snapshot: Snapshot,
    events: Option<Vec<Arc<TimingEvent>>>,
}
impl PreparedRemote {
    pub fn commit_token(&self) -> Option<CandidateCommit> {
        self.token.clone()
    }
    pub fn base_revision(&self) -> u64 {
        self.base_revision
    }
    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }
    pub fn update(&self) -> &[u8] {
        &self.update
    }
}

pub struct Document {
    doc: Doc,
    body: TextRef,
    page: MapRef,
    timing: MapRef,
    page_id: String,
    epoch: u32,
    revision: u64,
    undo: yrs::UndoManager,
    undo_times: Vec<HistoryTimes>,
    redo_times: Vec<HistoryTimes>,
    cached: std::sync::RwLock<Option<Snapshot>>,
    events: std::sync::RwLock<Option<Vec<Arc<TimingEvent>>>>,
}

impl Document {
    fn empty(page_id: &str, epoch: u32, client_id: u64) -> Result<Self> {
        Uuid::parse_str(page_id).map_err(|_| Error::Invalid("page UUID".into()))?;
        if epoch == 0 || client_id > u32::MAX as u64 {
            return Err(Error::Invalid("epoch/client".into()));
        }
        let doc = Doc::with_options(Options {
            client_id,
            offset_kind: OffsetKind::Utf16,
            skip_gc: true,
            ..Options::default()
        });
        let body = doc.get_or_insert_text("body");
        let page = doc.get_or_insert_map("page");
        let timing = doc.get_or_insert_map("timing");
        let mut undo = yrs::UndoManager::with_scope_and_options(
            &doc,
            &body,
            yrs::undo::Options {
                capture_timeout_millis: 0,
                ..Default::default()
            },
        );
        undo.include_origin("local");
        Ok(Self {
            doc,
            body,
            page,
            timing,
            page_id: page_id.into(),
            epoch,
            revision: 0,
            undo,
            undo_times: Vec::new(),
            redo_times: Vec::new(),
            cached: Default::default(),
            events: std::sync::RwLock::new(Some(Vec::new())),
        })
    }
    /// Only the page creator initializes shared identity. Other replicas use `load`.
    pub fn new(page_id: &str, epoch: u32, client_id: u64) -> Result<Self> {
        let this = Self::empty(page_id, epoch, client_id)?;
        {
            let mut txn = this.doc.transact_mut();
            this.page.insert(&mut txn, "schema", SCHEMA as i64);
            this.page.insert(&mut txn, "page_id", page_id);
            this.page.insert(&mut txn, "epoch", epoch as i64);
            this.page
                .insert(&mut txn, "root_line_id", Uuid::new_v4().to_string());
        }
        Ok(this)
    }
    /// Recover a portable snapshot as a separate page. Never reuse an old page/epoch
    /// without its complete causal state: offline peers could otherwise corrupt it.
    pub fn fork_snapshot(snapshot: &Snapshot, new_page_id: &str, client_id: u64) -> Result<Self> {
        if snapshot.page_id == new_page_id {
            return Err(Error::Invalid(
                "snapshot recovery requires a new page UUID".into(),
            ));
        }
        if snapshot.body.contains('\r')
            || snapshot.body.encode_utf16().count() > MAX_BODY_UTF16 as usize
            || snapshot
                .body
                .split('\n')
                .ne(snapshot.lines.iter().map(|l| l.text.as_str()))
            || snapshot.lines.first().map(|l| l.id.as_str()) != Some(snapshot.root_line_id.as_str())
        {
            return Err(Error::Invalid("snapshot body/lines mismatch".into()));
        }
        let mut ids = std::collections::HashSet::new();
        for line in &snapshot.lines {
            if Uuid::parse_str(&line.id).is_err()
                || !ids.insert(&line.id)
                || !matches!(
                    line.time_source.as_str(),
                    "unknown" | "device" | "import" | "mixed"
                )
                || [line.first_ms, line.last_ms]
                    .into_iter()
                    .flatten()
                    .any(|t| !(0..=9_007_199_254_740_991).contains(&t))
            {
                return Err(Error::Invalid("snapshot metadata".into()));
            }
        }
        let mut doc = Self::empty(new_page_id, 1, client_id)?;
        {
            let mut txn = doc.doc.transact_mut_with("restore");
            doc.page.insert(&mut txn, "schema", SCHEMA as i64);
            doc.page.insert(&mut txn, "page_id", new_page_id);
            doc.page.insert(&mut txn, "epoch", 1i64);
            doc.page
                .insert(&mut txn, "root_line_id", snapshot.root_line_id.clone());
            let mut delta = Vec::<yrs::types::Delta<String>>::new();
            for (i, line) in snapshot.lines.iter().enumerate() {
                if i > 0 {
                    delta.push(yrs::types::Delta::Inserted(
                        "\n".into(),
                        Some(Box::new(Attrs::from([(
                            "next_line_id".into(),
                            line.id.clone().into(),
                        )]))),
                    ));
                }
                if !line.text.is_empty() {
                    delta.push(yrs::types::Delta::Inserted(
                        line.text.clone(),
                        Some(Box::new(Attrs::from([("next_line_id".into(), Any::Null)]))),
                    ));
                }
            }
            doc.body.apply_delta(&mut txn, delta);
            let index = body_index(&doc.body, &mut txn);
            let mut spans = Vec::new();
            let mut pos = 0;
            for line in &snapshot.lines {
                let end = pos + line.text.encode_utf16().count() as u32;
                if line.first_ms.is_some()
                    || line.last_ms.is_some()
                    || line.time_source != "unknown"
                {
                    let mut item = span(&doc.body, &mut txn, pos, end, line.first_ms, false)?;
                    item.origins = origins_in(&index, pos, end);
                    item.carried_last_ms = line.last_ms;
                    item.carried_sources = source_set(&line.time_source);
                    spans.push(item);
                }
                pos = end + 1;
            }
            for chunk in spans.chunks(512) {
                let event = TimingEvent {
                    at_ms: 0,
                    source: "unknown".into(),
                    spans: chunk.to_vec(),
                };
                doc.timing
                    .insert(&mut txn, Uuid::new_v4().to_string(), encode_timing(&event)?);
                doc.events
                    .get_mut()
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .push(Arc::new(event));
            }
        }
        doc.snapshot()?;
        Ok(doc)
    }
    /// Import text with no trustworthy timing sidecar; do not invent creation timestamps.
    pub fn import_unknown(body: &str, new_page_id: &str, client_id: u64) -> Result<Self> {
        let lines: Vec<_> = body
            .split('\n')
            .map(|text| LineSnapshot {
                id: Uuid::new_v4().to_string(),
                text: text.into(),
                first_ms: None,
                last_ms: None,
                time_source: "unknown".into(),
            })
            .collect();
        let snapshot = Snapshot {
            page_id: Uuid::new_v4().to_string(),
            epoch: 1,
            revision: 0,
            body: body.into(),
            root_line_id: lines[0].id.clone(),
            lines,
        };
        Self::fork_snapshot(&snapshot, new_page_id, client_id)
    }
    pub fn load(page_id: &str, epoch: u32, client_id: u64, bytes: &[u8]) -> Result<Self> {
        let mut this = Self::empty(page_id, epoch, client_id)?;
        let decoded = Update::decode_v1(bytes).map_err(|e| Error::Invalid(e.to_string()))?;
        if update_actors(&decoded).contains_key(&client_id) {
            return Err(Error::Invalid(
                "client ID already exists in causal or pending state".into(),
            ));
        }
        this.integrate(bytes)?;
        if this.doc.transact().state_vector().get(&client_id) != 0 {
            return Err(Error::Invalid(
                "client ID already exists; create a fresh replica actor".into(),
            ));
        }
        this.snapshot()?;
        Ok(this)
    }
    /// Restore a durable session/checkpoint revision; use a fresh client ID for each replica.
    pub fn restore(
        page_id: &str,
        epoch: u32,
        client_id: u64,
        bytes: &[u8],
        revision: u64,
    ) -> Result<Self> {
        let mut doc = Self::load(page_id, epoch, client_id, bytes)?;
        doc.revision = revision;
        if let Some(snapshot) = doc.cached.get_mut().unwrap().as_mut() {
            snapshot.revision = revision;
        }
        Ok(doc)
    }
    pub fn fresh_client_id(&self) -> u64 {
        let vector = self.doc.transact().state_vector();
        let pending = if self.doc.transact().has_missing_updates() {
            Update::decode_v1(&self.encode_full())
                .ok()
                .map(|u| update_actors(&u))
        } else {
            None
        };
        loop {
            let bytes = *Uuid::new_v4().as_bytes();
            let id = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as u64;
            if id != self.doc.client_id()
                && vector.get(&id) == 0
                && pending.as_ref().is_none_or(|p| !p.contains_key(&id))
            {
                return id;
            }
        }
    }
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }
    pub fn encode_update(&self, vector: &[u8]) -> Result<Vec<u8>> {
        let vector = StateVector::decode_v1(vector).map_err(|e| Error::Invalid(e.to_string()))?;
        Ok(self.doc.transact().encode_state_as_update_v1(&vector))
    }
    pub fn encode_full(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }
    pub fn client_id(&self) -> u64 {
        self.doc.client_id()
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn body(&self) -> String {
        self.body.get_string(&self.doc.transact())
    }

    pub fn anchor_selection(&self, start: u32, length: u32) -> Result<SelectionAnchor> {
        let body = self.body();
        let end = start.checked_add(length).ok_or(Error::InvalidOffset)?;
        utf16_to_byte(&body, start)?;
        utf16_to_byte(&body, end)?;
        let mut txn = self.doc.transact_mut();
        let root_line_id = self.selection_root(&txn)?;
        let mut anchor = |at: u32, assoc: Assoc| -> Result<StickyIndex> {
            if at == body.encode_utf16().count() as u32 && assoc == Assoc::After {
                Ok(StickyIndex::from_type(&txn, &self.body, assoc))
            } else {
                self.body
                    .sticky_index(&mut txn, at, assoc)
                    .ok_or(Error::InvalidOffset)
            }
        };
        Ok(SelectionAnchor {
            page_id: self.page_id.clone(),
            epoch: self.epoch,
            root_line_id,
            start: anchor(start, Assoc::After)?,
            end: anchor(
                end,
                if length == 0 {
                    Assoc::After
                } else {
                    Assoc::Before
                },
            )?,
            collapsed: length == 0,
        })
    }
    pub fn resolve_selection(&self, anchor: &SelectionAnchor) -> Result<(u32, u32)> {
        let txn = self.doc.transact();
        self.check_selection_identity(anchor, &txn)?;
        let resolve = |a: &StickyIndex| -> Result<u32> {
            let at = a.get_offset(&txn).ok_or(Error::InvalidOffset)?;
            if !std::ptr::eq(&*at.branch, self.body.as_ref()) {
                return Err(Error::InvalidOffset);
            }
            Ok(at.index)
        };
        let a = resolve(&anchor.start)?;
        let b = resolve(&anchor.end)?;
        let body = self.body.get_string(&txn);
        let mut boundaries = vec![0u32];
        for g in body.graphemes(true) {
            boundaries.push(boundaries.last().unwrap() + g.encode_utf16().count() as u32);
        }
        let ceil = |at: u32| {
            boundaries[boundaries
                .partition_point(|n| *n < at)
                .min(boundaries.len() - 1)]
        };
        let floor =
            |at: u32| boundaries[boundaries.partition_point(|n| *n <= at).saturating_sub(1)];
        if anchor.collapsed {
            let at = ceil(a);
            return Ok((at, 0));
        }
        let start = floor(a.min(b));
        let end = ceil(a.max(b));
        Ok((start, end - start))
    }
    /// Run on a separate persistence replica or background checkpoint, never while
    /// holding the active native input lock. Stale preparations are safe to retry.
    pub fn prepare_remote(&self, bytes: &[u8]) -> Result<PreparedRemote> {
        let causal = self.doc.transact().snapshot();
        let pending_hash = if self.doc.transact().has_missing_updates() {
            Some(crate::storage::sha256(&self.encode_full()))
        } else {
            None
        };
        let decoded = Update::decode_v1(bytes).map_err(|e| Error::Invalid(e.to_string()))?;
        let actors = update_actors(&decoded);
        let mut candidate = self.validate_update(bytes)?;
        let mut snapshot = candidate.snapshot()?;
        snapshot.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| Error::Invalid("revision overflow".into()))?;
        Ok(PreparedRemote {
            base_revision: self.revision,
            causal,
            pending_hash,
            update: bytes.into(),
            token: None,
            actors,
            snapshot,
            events: candidate.events.get_mut().unwrap().take(),
        })
    }
    pub fn commit_prepared(&mut self, prepared: PreparedRemote) -> Result<()> {
        if self.revision != prepared.base_revision
            || self.page_id != prepared.snapshot.page_id
            || self.epoch != prepared.snapshot.epoch
            || self.doc.transact().snapshot() != prepared.causal
        {
            return Err(Error::StaleRevision);
        }
        let pending = self.doc.transact().has_missing_updates();
        if pending != prepared.pending_hash.is_some()
            || prepared
                .pending_hash
                .as_ref()
                .is_some_and(|h| *h != crate::storage::sha256(&self.encode_full()))
        {
            return Err(Error::StaleRevision);
        }
        if prepared
            .actors
            .get(&self.doc.client_id())
            .copied()
            .unwrap_or(0)
            > self
                .doc
                .transact()
                .state_vector()
                .get(&self.doc.client_id())
        {
            return Err(Error::Invalid(
                "prepared update collides with active actor".into(),
            ));
        }
        self.integrate(&prepared.update)?;
        *self.cached.get_mut().unwrap() = Some(prepared.snapshot);
        *self.events.get_mut().unwrap() = prepared.events;
        Ok(())
    }
    /// Caller validates envelope identity and persists the update before publishing the view.
    /// Validation happens on a candidate document so malformed updates never mutate this session.
    pub fn apply_remote(&mut self, bytes: &[u8]) -> Result<()> {
        self.validate_update(bytes)?;
        self.integrate(bytes)
    }
    fn validate_update(&self, bytes: &[u8]) -> Result<Self> {
        // Pending inserts/deletes for this live actor are collisions too. Checking
        // only the integrated state vector would let a future packet take effect
        // during a later local keystroke when its missing clocks finally exist.
        let decoded = Update::decode_v1(bytes).map_err(|e| Error::Invalid(e.to_string()))?;
        let own = self.doc.client_id();
        let clock = self.doc.transact().state_vector().get(&own);
        if decoded
            .insertions(true)
            .get(&own)
            .is_some_and(|ranges| ranges.iter().any(|r| r.end > clock))
            || decoded
                .delete_set()
                .iter()
                .any(|(client, ranges)| *client == own && ranges.iter().any(|r| r.end > clock))
        {
            return Err(Error::Invalid(
                "remote update references future clocks of this live replica".into(),
            ));
        }
        let mut candidate = Self::load(
            &self.page_id,
            self.epoch,
            self.fresh_client_id(),
            &self.encode_full(),
        )?;
        candidate.integrate(bytes)?;
        let own_client = self.doc.client_id();
        if candidate.doc.transact().state_vector().get(&own_client)
            > self.doc.transact().state_vector().get(&own_client)
        {
            return Err(Error::Invalid(
                "remote update uses this live replica's client ID".into(),
            ));
        }
        let next = candidate.snapshot()?;
        if next.root_line_id != self.snapshot()?.root_line_id {
            return Err(Error::Invalid("root line identity changed".into()));
        }
        {
            let before = self.doc.transact();
            let after = candidate.doc.transact();
            for (key, value) in self.timing.iter(&before) {
                if candidate
                    .timing
                    .get(&after, key)
                    .map(|v| v.to_string(&after))
                    != Some(value.to_string(&before))
                {
                    return Err(Error::Invalid("timing events are immutable".into()));
                }
            }
        }
        Ok(candidate)
    }
    /// A source-editor save is a local undoable transaction, even though its
    /// non-overlapping changes were prepared on a CRDT baseline branch.
    pub fn apply_source_update(&mut self, bytes: &[u8]) -> Result<()> {
        self.validate_update(bytes)?;
        let before = self.snapshot()?;
        self.doc
            .transact_mut_with("local")
            .apply_update(Update::decode_v1(bytes).map_err(|e| Error::Invalid(e.to_string()))?)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        self.revision += 1;
        *self.events.get_mut().unwrap() = None;
        let after = self.snapshot()?;
        let old: std::collections::HashMap<_, _> =
            before.lines.iter().map(|l| (l.id.as_str(), l)).collect();
        let new: std::collections::HashMap<_, _> =
            after.lines.iter().map(|l| (l.id.as_str(), l)).collect();
        let before_times = before
            .lines
            .iter()
            .filter(|l| new.get(l.id.as_str()).is_none_or(|n| **n != **l))
            .map(LineTime::from)
            .collect();
        let after_times = after
            .lines
            .iter()
            .filter(|l| old.get(l.id.as_str()).is_none_or(|o| **o != **l))
            .map(LineTime::from)
            .collect();
        self.undo_times.push(HistoryTimes {
            before: before_times,
            after: after_times,
        });
        self.redo_times.clear();
        Ok(())
    }
    /// Replay an already-confirmed same-process FIFO transaction on a disposable
    /// persistence replica. The target revision must be exactly current + 1.
    ///
    /// Unlike `apply_remote`, this avoids cloning the full history. It still
    /// validates the combined state and immutable timing, including old pending
    /// packets. On ANY error after entry the caller MUST discard this replica
    /// and reload the durable checkpoint; it may already have been mutated.
    /// Never use this API on the live editor or to accept unconfirmed network data.
    pub fn apply_confirmed_update(
        &mut self,
        target_revision: u64,
        bytes: &[u8],
    ) -> Result<Snapshot> {
        if self.revision.checked_add(1) != Some(target_revision) {
            return Err(Error::StaleRevision);
        }
        let root = {
            let txn = self.doc.transact();
            self.page
                .get(&txn, "root_line_id")
                .map(|v| v.to_string(&txn))
                .ok_or_else(|| Error::Invalid("missing root line identity".into()))?
        };
        self.integrate_observed(bytes, &root)
    }
    fn integrate_observed(&mut self, bytes: &[u8], expected_root: &str) -> Result<Snapshot> {
        // A previously isolated remote import may have invalidated the decoded
        // cache; warm it before observing any new changes.
        if self.events.read().unwrap().is_none() {
            self.snapshot()?;
        }
        let next_revision = self.revision.checked_add(1).ok_or(Error::Capacity)?;
        #[derive(Default)]
        struct Changes {
            values: Vec<(String, String)>,
            mutated: bool,
        }
        let changes = Arc::new(Mutex::new(Changes::default()));
        let capture = changes.clone();
        let observer = self.timing.observe(move |txn, event| {
            let mut capture = capture.lock().unwrap();
            for (key, change) in event.keys(txn) {
                match change {
                    EntryChange::Inserted(yrs::Out::Any(Any::String(value))) => {
                        capture.values.push((key.to_string(), value.to_string()))
                    }
                    EntryChange::Updated(old, new) if old == new => {}
                    _ => capture.mutated = true,
                }
            }
        });
        let update = Update::decode_v1(bytes).map_err(|e| Error::Invalid(e.to_string()))?;
        self.doc
            .transact_mut()
            .apply_update(update)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        drop(observer);
        let changes = Arc::try_unwrap(changes).ok().unwrap().into_inner().unwrap();
        if changes.mutated {
            return Err(Error::Invalid("timing events are immutable strings".into()));
        }
        let events = self.events.get_mut().unwrap().as_mut().unwrap();
        for (key, value) in changes.values {
            Uuid::parse_str(&key).map_err(|_| Error::Invalid("timing event UUID".into()))?;
            events.push(Arc::new(decode_timing(&value)?));
        }
        self.revision = next_revision;
        let snapshot = self.snapshot()?;
        if snapshot.root_line_id != expected_root {
            return Err(Error::Invalid("root line identity changed".into()));
        }
        Ok(snapshot)
    }
    fn integrate(&mut self, bytes: &[u8]) -> Result<()> {
        let update = Update::decode_v1(bytes).map_err(|e| Error::Invalid(e.to_string()))?;
        self.doc
            .transact_mut()
            .apply_update(update)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        self.revision += 1;
        *self.events.get_mut().unwrap() = None;
        Ok(())
    }
    /// UTF-16 range from the exact revision displayed by the editor. IME marked text is never passed.
    pub fn replace(
        &mut self,
        revision: u64,
        start: u32,
        len: u32,
        inserted: &str,
        at_ms: i64,
    ) -> Result<Vec<u8>> {
        self.replace_from_source(revision, start, len, inserted, at_ms, "device")
    }
    pub fn replace_from_source(
        &mut self,
        revision: u64,
        start: u32,
        len: u32,
        inserted: &str,
        at_ms: i64,
        source: &str,
    ) -> Result<Vec<u8>> {
        if !matches!(source, "device" | "import") {
            return Err(Error::Invalid("time source".into()));
        }
        if revision != self.revision {
            return Err(Error::StaleRevision);
        }
        if !(0..=9_007_199_254_740_991).contains(&at_ms) {
            return Err(Error::Invalid(
                "timestamp outside safe nonnegative range".into(),
            ));
        }
        if inserted.contains('\r') {
            return Err(Error::Invalid("body must use LF".into()));
        }
        let before = self.snapshot()?;
        let end = start.checked_add(len).ok_or(Error::InvalidOffset)?;
        let a = utf16_to_byte(&before.body, start)?;
        let b = utf16_to_byte(&before.body, end)?;
        if a == b && inserted.is_empty() {
            return Ok(vec![0, 0]);
        }
        let insert_len = inserted.encode_utf16().count() as u32;
        if before.body.encode_utf16().count() as u32 - len + insert_len > MAX_BODY_UTF16 {
            return Err(Error::Capacity);
        }
        let old_bounds = bounds(&before.lines);
        let touched: Vec<_> = old_bounds
            .iter()
            .enumerate()
            .filter(|(_, (s, e))| *s <= end && *e >= start)
            .map(|(i, _)| i)
            .collect();
        let prior_times: Vec<_> = touched
            .iter()
            .map(|&i| LineTime::from(&before.lines[i]))
            .collect();
        let inherited_first = touched
            .iter()
            .filter_map(|&i| before.lines[i].first_ms)
            .min();
        let changes_boundaries = before.body[a..b].contains('\n') || inserted.contains('\n');
        let vector = self.doc.transact().state_vector();
        let mut inserted_line_ids = Vec::new();
        {
            let mut txn = self.doc.transact_mut_with("local");
            let start_clock = txn.state_vector().get(&self.doc.client_id());
            let mut delta = vec![yrs::types::Delta::<String>::Retain(start, None)];
            if len > 0 {
                delta.push(yrs::types::Delta::Deleted(len));
            }
            for part in inserted.split_inclusive('\n') {
                let text = part.strip_suffix('\n').unwrap_or(part);
                if !text.is_empty() {
                    delta.push(yrs::types::Delta::Inserted(
                        text.into(),
                        Some(Box::new(Attrs::from([("next_line_id".into(), Any::Null)]))),
                    ));
                }
                if part.ends_with('\n') {
                    let id = Uuid::new_v4().to_string();
                    inserted_line_ids.push(id.clone());
                    delta.push(yrs::types::Delta::Inserted(
                        "\n".into(),
                        Some(Box::new(Attrs::from([("next_line_id".into(), id.into())]))),
                    ));
                }
            }
            self.body.apply_delta(&mut txn, delta);
            let end_clock = txn.state_vector().get(&self.doc.client_id());
            let index = if changes_boundaries {
                body_index(&self.body, &mut txn)
            } else {
                Vec::new()
            };
            let mut spans = Vec::new();
            // Exact inserted/deleted position: remote splits cannot leave the event on the old line.
            spans.push(span(
                &self.body,
                &mut txn,
                start,
                start + insert_len,
                if inserted.chars().any(|c| c != '\n') {
                    Some(at_ms)
                } else {
                    None
                },
                true,
            )?);
            if insert_len > 0 {
                spans[0].origins = vec![(self.doc.client_id(), start_clock, end_clock)];
            }
            if len > 0 {
                let mut retained =
                    span(&self.body, &mut txn, start, start, inherited_first, false)?;
                retained.carried_last_ms = touched
                    .iter()
                    .filter_map(|&i| before.lines[i].last_ms)
                    .max();
                retained.carried_sources = touched
                    .iter()
                    .flat_map(|&i| source_set(&before.lines[i].time_source))
                    .collect();
                spans.push(retained);
            }
            if changes_boundaries {
                // A split inherits first only through retained characters. Newly pasted middle
                // lines do not inherit a date belonging to the surrounding original line.
                let first = *touched.first().ok_or(Error::InvalidOffset)?;
                let last = *touched.last().ok_or(Error::InvalidOffset)?;
                if old_bounds[first].0 < start {
                    let mut inherited = span(
                        &self.body,
                        &mut txn,
                        old_bounds[first].0,
                        start,
                        before.lines[first].first_ms,
                        false,
                    )?;
                    inherited.origins = compact_origins(&index, old_bounds[first].0, start);
                    inherited.carried_sources = source_set(&before.lines[first].time_source);
                    spans.push(inherited);
                }
                let tail_len = old_bounds[last].1 - end;
                if tail_len > 0 {
                    let mut inherited = span(
                        &self.body,
                        &mut txn,
                        start + insert_len,
                        start + insert_len + tail_len,
                        before.lines[last].first_ms,
                        false,
                    )?;
                    inherited.origins =
                        compact_origins(&index, start + insert_len, start + insert_len + tail_len);
                    inherited.carried_sources = source_set(&before.lines[last].time_source);
                    spans.push(inherited);
                }
                spans.push(span(
                    &self.body,
                    &mut txn,
                    old_bounds[first].0,
                    start + insert_len + tail_len,
                    None,
                    true,
                )?);
            }
            let event = TimingEvent {
                at_ms,
                source: source.into(),
                spans,
            };
            self.timing
                .insert(&mut txn, Uuid::new_v4().to_string(), encode_timing(&event)?);
            if let Some(events) = self.events.get_mut().unwrap() {
                events.push(Arc::new(event));
            }
        }
        self.revision += 1;
        if !changes_boundaries {
            let mut next = before;
            next.revision = self.revision;
            next.body.replace_range(a..b, inserted);
            let line_index = *touched.first().ok_or(Error::InvalidOffset)?;
            let line = &mut next.lines[line_index];
            let local_start = utf16_to_byte(&line.text, start - old_bounds[line_index].0)?;
            let local_end = utf16_to_byte(&line.text, end - old_bounds[line_index].0)?;
            line.text.replace_range(local_start..local_end, inserted);
            if !inserted.is_empty() {
                line.first_ms = Some(line.first_ms.map_or(at_ms, |t| t.min(at_ms)));
            }
            line.last_ms = Some(line.last_ms.map_or(at_ms, |t| t.max(at_ms)));
            let mut sources = source_set(&line.time_source);
            sources.push(source.into());
            line.time_source = combine_sources(sources);
            *self.cached.write().unwrap() = Some(next);
        } else if len == 0 && inserted.chars().all(|c| c == '\n') {
            let i = touched[0];
            // The common Enter path has retained characters on its left and a monotonic
            // wall clock. Other splits use the general provenance reducer.
            if start > old_bounds[i].0 && before.lines[i].last_ms.is_none_or(|last| at_ms >= last) {
                let mut next = before;
                next.revision = self.revision;
                next.body.replace_range(a..b, inserted);
                let old = &next.lines[i];
                let cut = utf16_to_byte(&old.text, start - old_bounds[i].0)?;
                let sources = combine_sources(
                    source_set(&old.time_source)
                        .into_iter()
                        .chain([source.into()])
                        .collect(),
                );
                let mut replacement = vec![LineSnapshot {
                    id: old.id.clone(),
                    text: old.text[..cut].into(),
                    first_ms: old.first_ms,
                    last_ms: Some(at_ms),
                    time_source: sources.clone(),
                }];
                for (n, id) in inserted_line_ids.iter().enumerate() {
                    let text = if n + 1 == inserted_line_ids.len() {
                        old.text[cut..].to_owned()
                    } else {
                        String::new()
                    };
                    let nonempty = !text.is_empty();
                    replacement.push(LineSnapshot {
                        id: id.clone(),
                        text,
                        first_ms: if nonempty { old.first_ms } else { None },
                        last_ms: Some(at_ms),
                        time_source: if nonempty {
                            sources.clone()
                        } else {
                            source.into()
                        },
                    });
                }
                next.lines.splice(i..=i, replacement);
                *self.cached.write().unwrap() = Some(next);
            }
        }
        let next = self.snapshot()?;
        let next_bounds = bounds(&next.lines);
        let after_times = next
            .lines
            .iter()
            .zip(next_bounds)
            .filter(|(_, (a, b))| *a <= start + insert_len && *b >= start)
            .map(|(line, _)| LineTime::from(line))
            .collect();
        self.undo_times.push(HistoryTimes {
            before: prior_times,
            after: after_times,
        });
        self.redo_times.clear();
        Ok(self.doc.transact().encode_state_as_update_v1(&vector))
    }

    pub fn undo(&mut self, at_ms: i64) -> Result<Vec<u8>> {
        self.history(false, at_ms)
    }
    pub fn redo(&mut self, at_ms: i64) -> Result<Vec<u8>> {
        self.history(true, at_ms)
    }
    fn history(&mut self, redo: bool, at_ms: i64) -> Result<Vec<u8>> {
        if !(0..=9_007_199_254_740_991).contains(&at_ms) {
            return Err(Error::Invalid(
                "timestamp outside safe nonnegative range".into(),
            ));
        }
        let before = self.snapshot()?;
        let vector = self.doc.transact().state_vector();
        let changed = if redo {
            self.undo.redo_blocking()
        } else {
            self.undo.undo_blocking()
        };
        if !changed {
            return Ok(vec![0, 0]);
        }
        let record = if redo {
            self.redo_times.pop()
        } else {
            self.undo_times.pop()
        };
        let target = record
            .as_ref()
            .map(|r| if redo { &r.after } else { &r.before });
        let restored = self.compute_snapshot(true)?;
        let after = self.body();
        let a: Vec<_> = before.body.chars().collect();
        let b: Vec<_> = after.chars().collect();
        let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
        let suffix = a[prefix..]
            .iter()
            .rev()
            .zip(b[prefix..].iter().rev())
            .take_while(|(x, y)| x == y)
            .count();
        let start = b[..prefix]
            .iter()
            .map(|c| c.len_utf16() as u32)
            .sum::<u32>();
        let end = b[..b.len() - suffix]
            .iter()
            .map(|c| c.len_utf16() as u32)
            .sum::<u32>();
        let previous_end = a[..a.len() - suffix]
            .iter()
            .map(|c| c.len_utf16() as u32)
            .sum::<u32>();
        let previous_bounds = bounds(&before.lines);
        let previous: Vec<_> = before
            .lines
            .iter()
            .zip(&previous_bounds)
            .filter(|(_, (a, b))| *a <= previous_end && *b >= start)
            .map(|(line, _)| line)
            .collect();
        let inherited_first = previous.iter().filter_map(|l| l.first_ms).min();
        let inherited_last = previous.iter().filter_map(|l| l.last_ms).max();
        let mut txn = self.doc.transact_mut_with("timing-history");
        let index = body_index(&self.body, &mut txn);
        let mut spans = Vec::new();
        let mut pos = 0;
        for line in &restored.lines {
            let line_end = pos + line.text.encode_utf16().count() as u32;
            if pos <= end && line_end >= start {
                let historical = target.and_then(|v| v.iter().find(|t| t.id == line.id));
                let first = if redo {
                    historical.map(|t| t.first).unwrap_or(inherited_first)
                } else {
                    historical.and_then(|t| t.first).or(inherited_first)
                };
                let mut item = span(&self.body, &mut txn, pos, line_end, first, true)?;
                item.origins = compact_origins(&index, pos, line_end);
                item.carried_last_ms = historical
                    .and_then(|t| t.last)
                    .into_iter()
                    .chain(inherited_last)
                    .max();
                item.carried_sources =
                    historical
                        .map(|t| source_set(&t.source))
                        .unwrap_or_else(|| {
                            previous
                                .iter()
                                .flat_map(|l| source_set(&l.time_source))
                                .collect()
                        });
                spans.push(item);
            }
            pos = line_end + 1;
        }
        let event = TimingEvent {
            at_ms,
            source: "device".into(),
            spans,
        };
        self.timing
            .insert(&mut txn, Uuid::new_v4().to_string(), encode_timing(&event)?);
        if let Some(events) = self.events.get_mut().unwrap() {
            events.push(Arc::new(event));
        }
        drop(txn);
        if let Some(record) = record {
            if redo {
                self.undo_times.push(record)
            } else {
                self.redo_times.push(record)
            }
        }
        self.revision += 1;
        Ok(self.doc.transact().encode_state_as_update_v1(&vector))
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        if let Some(snapshot) = self
            .cached
            .read()
            .unwrap()
            .as_ref()
            .filter(|s| s.revision == self.revision)
        {
            return Ok(snapshot.clone());
        }
        let snapshot = self.compute_snapshot(true)?;
        *self.cached.write().unwrap() = Some(snapshot.clone());
        Ok(snapshot)
    }
    /// Full provenance replay, also used to verify the exact incremental keyboard path.
    pub fn verify_snapshot(&self) -> Result<Snapshot> {
        self.compute_snapshot(false)
    }
    fn compute_snapshot(&self, indexed: bool) -> Result<Snapshot> {
        let mut txn = self.doc.transact_mut();
        let page_id = self
            .page
            .get(&txn, "page_id")
            .map(|x| x.to_string(&txn))
            .unwrap_or_default();
        let epoch = self
            .page
            .get(&txn, "epoch")
            .map(|x| x.to_string(&txn))
            .unwrap_or_default();
        if page_id != self.page_id || epoch != self.epoch.to_string() {
            return Err(Error::Invalid("identity mismatch".into()));
        }
        if self.page.get(&txn, "schema").map(|x| x.to_string(&txn)) != Some("1".into()) {
            return Err(Error::Invalid("schema".into()));
        }
        if txn
            .root_refs()
            .any(|(name, _)| !matches!(name, "body" | "page" | "timing"))
        {
            return Err(Error::Invalid("unknown shared root".into()));
        }
        let root = self
            .page
            .get(&txn, "root_line_id")
            .map(|x| x.to_string(&txn))
            .unwrap_or_default();
        Uuid::parse_str(&root).map_err(|_| Error::Invalid("root line UUID".into()))?;
        let body = self.body.get_string(&txn);
        if body.contains('\r') {
            return Err(Error::Invalid("canonical body contains CR".into()));
        }
        if body.encode_utf16().count() > MAX_BODY_UTF16 as usize {
            return Err(Error::Capacity);
        }
        let mut lines = vec![LineSnapshot {
            id: root.clone(),
            text: String::new(),
            first_ms: None,
            last_ms: None,
            time_source: "unknown".into(),
        }];
        let intervals = body_index(&self.body, &mut txn);
        let mut anchor_index = std::collections::HashMap::<u64, Vec<(u32, u32, u32)>>::new();
        for &(client, a, b, offset) in &intervals {
            anchor_index.entry(client).or_default().push((a, b, offset));
        }
        for part in self.body.diff(&txn, yrs::types::text::YChange::identity) {
            let text = match part.insert {
                yrs::Out::Any(Any::String(s)) => s,
                _ => return Err(Error::Invalid("body embed".into())),
            };
            for c in text.chars() {
                if c == '\n' {
                    let id = part
                        .attributes
                        .as_ref()
                        .and_then(|a| a.get("next_line_id"))
                        .and_then(|v| match v {
                            Any::String(s) => Some(s.to_string()),
                            _ => None,
                        })
                        .ok_or_else(|| Error::Invalid("newline lacks ID".into()))?;
                    Uuid::parse_str(&id).map_err(|_| Error::Invalid("line UUID".into()))?;
                    lines.push(LineSnapshot {
                        id,
                        text: String::new(),
                        first_ms: None,
                        last_ms: None,
                        time_source: "unknown".into(),
                    });
                } else {
                    lines.last_mut().unwrap().text.push(c);
                }
            }
        }
        for entries in anchor_index.values_mut() {
            entries.sort_unstable_by_key(|(a, _, _)| *a);
        }
        let resolve = |anchor: &StickyIndex| -> Result<u32> {
            if indexed {
                if let Some(id) = anchor.id() {
                    if let Some(entries) = anchor_index.get(&id.client) {
                        let slot = entries.partition_point(|(a, _, _)| *a <= id.clock);
                        if slot > 0 {
                            let (a, b, offset) = entries[slot - 1];
                            if id.clock < b {
                                return Ok(offset + id.clock - a
                                    + u32::from(anchor.assoc == Assoc::Before));
                            }
                        }
                    }
                }
            }
            let position = anchor
                .get_offset(&txn)
                .ok_or_else(|| Error::Invalid("unresolved timing anchor".into()))?;
            if !std::ptr::eq(&*position.branch, self.body.as_ref()) {
                return Err(Error::Invalid("timing anchor outside body".into()));
            }
            Ok(position.index)
        };
        let line_bounds = bounds(&lines);
        let line_origins: Vec<_> = line_bounds
            .iter()
            .map(|&(a, b)| {
                let mut clients = std::collections::HashMap::<u64, Vec<(u32, u32)>>::new();
                for (c, a, b) in origins_in(&intervals, a, b) {
                    clients.entry(c).or_default().push((a, b));
                }
                for ranges in clients.values_mut() {
                    ranges.sort_unstable();
                }
                clients
            })
            .collect();
        if self.events.read().unwrap().is_none() {
            let events = self
                .timing
                .iter(&txn)
                .map(|(key, value)| {
                    Uuid::parse_str(key).map_err(|_| Error::Invalid("timing event UUID".into()))?;
                    decode_timing(&value.to_string(&txn)).map(Arc::new)
                })
                .collect::<Result<Vec<_>>>()?;
            *self.events.write().unwrap() = Some(events);
        }
        let events_guard = self.events.read().unwrap();
        for event in events_guard.as_ref().unwrap() {
            for span in &event.spans {
                let start = resolve(&span.start)?;
                let end = resolve(&span.end)?;
                let (start, end) = (start.min(end), start.max(end));
                let first_line = line_bounds.partition_point(|(_, b)| *b < start);
                for (i, (a, b)) in line_bounds
                    .iter()
                    .enumerate()
                    .skip(first_line)
                    .take_while(|(_, (a, _))| *a <= end)
                {
                    let overlaps =
                        if start == end || (span.origins.is_empty() && span.first_ms.is_none()) {
                            *a <= end && start <= *b
                        } else {
                            *a < end && *b > start
                        };
                    if overlaps
                        && (span.origins.is_empty()
                            || span.origins.iter().any(|&(c, a, b)| {
                                line_origins[i].get(&c).is_some_and(|ranges| {
                                    let slot = ranges.partition_point(|&(oa, _)| oa < b);
                                    slot > 0 && ranges[slot - 1].1 > a
                                })
                            }))
                    {
                        if let Some(first) = span
                            .first_ms
                            .filter(|_| !lines[i].text.is_empty() || start == end)
                        {
                            lines[i].first_ms =
                                Some(lines[i].first_ms.map_or(first, |x| x.min(first)));
                        }
                        if let Some(last) = span.carried_last_ms {
                            lines[i].last_ms = Some(lines[i].last_ms.map_or(last, |x| x.max(last)));
                        }
                        if span.touch {
                            lines[i].last_ms =
                                Some(lines[i].last_ms.map_or(event.at_ms, |x| x.max(event.at_ms)));
                        }
                        let mut sources = source_set(&lines[i].time_source);
                        sources.extend(span.carried_sources.iter().cloned());
                        if (span.touch || span.first_ms.is_some()) && event.source != "unknown" {
                            sources.push(event.source.clone());
                        }
                        lines[i].time_source = combine_sources(sources);
                    }
                }
            }
        }
        let mut ids = std::collections::HashSet::new();
        if lines.iter().any(|l| !ids.insert(l.id.clone())) {
            return Err(Error::Invalid("duplicate line ID".into()));
        }
        Ok(Snapshot {
            page_id: self.page_id.clone(),
            epoch: self.epoch,
            revision: self.revision,
            body,
            root_line_id: root,
            lines,
        })
    }
}
fn span(
    text: &TextRef,
    txn: &mut yrs::TransactionMut,
    start: u32,
    end: u32,
    first_ms: Option<i64>,
    touch: bool,
) -> Result<TimingSpan> {
    // Start sticks to the right character; end sticks to the left character, excluding later append.
    let start_pos = text
        .sticky_index(
            txn,
            start,
            if start == end {
                Assoc::Before
            } else {
                Assoc::After
            },
        )
        .ok_or(Error::InvalidOffset)?;
    let end_pos = text
        .sticky_index(txn, end, Assoc::Before)
        .ok_or(Error::InvalidOffset)?;
    Ok(TimingSpan {
        start: start_pos,
        end: end_pos,
        first_ms,
        touch,
        origins: Vec::new(),
        carried_last_ms: None,
        carried_sources: Vec::new(),
    })
}
fn bounds(lines: &[LineSnapshot]) -> Vec<(u32, u32)> {
    let mut offset = 0;
    lines
        .iter()
        .map(|l| {
            let a = offset;
            let b = a + l.text.encode_utf16().count() as u32;
            offset = b + 1;
            (a, b)
        })
        .collect()
}
pub fn utf16_to_byte(text: &str, offset: u32) -> Result<usize> {
    let mut units = 0;
    for (byte, g) in text.grapheme_indices(true) {
        if units == offset {
            return Ok(byte);
        }
        units += g.encode_utf16().count() as u32;
        if units > offset {
            return Err(Error::InvalidOffset);
        }
    }
    if units == offset {
        Ok(text.len())
    } else {
        Err(Error::InvalidOffset)
    }
}

fn source_set(source: &str) -> Vec<String> {
    match source {
        "unknown" => Vec::new(),
        "mixed" => vec!["device".into(), "import".into()],
        s => vec![s.into()],
    }
}
fn combine_sources(sources: Vec<String>) -> String {
    let set: std::collections::BTreeSet<_> = sources.into_iter().collect();
    if set.is_empty() {
        "unknown".into()
    } else if set.len() == 1 {
        set.into_iter().next().unwrap()
    } else {
        "mixed".into()
    }
}

// (client, inclusive clock, exclusive clock, visible UTF-16 offset).
type BodyInterval = (u64, u32, u32, u32);
fn body_index(text: &TextRef, txn: &mut yrs::TransactionMut) -> Vec<BodyInterval> {
    let hi = txn.snapshot();
    // Yrs 0.24/0.26 split_by_snapshot probes the clock at each boundary. A
    // boundary past the final item can panic. Use each final valid clock as
    // the boundary and account for the excluded final body unit explicitly.
    let mut missing = Vec::new();
    for (&client, &clock) in hi.state_map.iter().filter(|(_, clock)| **clock > 0) {
        let id = yrs::ID::new(client, clock - 1);
        if !hi.delete_set.is_deleted(&id) {
            if let Some(position) = StickyIndex::from_id(id, Assoc::After).get_offset(txn) {
                if std::ptr::eq(&*position.branch, text.as_ref()) {
                    missing.push((position.index, client, clock - 1));
                }
            }
        }
        let _ = clock;
    }
    missing.sort_unstable();
    let safe = yrs::Snapshot::new(
        hi.state_map
            .iter()
            .filter(|(_, clock)| **clock > 1)
            .map(|(c, k)| (*c, *k - 1))
            .collect(),
        hi.delete_set.clone(),
    );
    let index_diff = text.diff_range(
        txn,
        Some(&safe),
        Some(&yrs::Snapshot::default()),
        yrs::types::text::YChange::identity,
    );
    let mut intervals = Vec::new();
    let mut text_offset = 0;
    for part in index_diff {
        if let yrs::Out::Any(Any::String(value)) = part.insert {
            let width = value.encode_utf16().count() as u32;
            let mut adjusted = text_offset;
            for (position, _, _) in &missing {
                if *position <= adjusted {
                    adjusted += 1;
                }
            }
            if let Some(change) = part.ychange {
                intervals.push((
                    change.id.client,
                    change.id.clock,
                    change.id.clock + width,
                    adjusted,
                ));
            }
            text_offset += width;
        }
    }
    for (position, client, clock) in missing {
        intervals.push((client, clock, clock + 1, position));
    }

    intervals.sort_unstable_by_key(|i| i.3);
    intervals
}
fn origins_in(index: &[BodyInterval], start: u32, end: u32) -> Vec<(u64, u32, u32)> {
    if start == end {
        return Vec::new();
    }
    let first = index.partition_point(|&(_, a, b, offset)| offset + b - a <= start);
    index[first..]
        .iter()
        .take_while(|&&(_, _, _, offset)| offset < end)
        .map(|&(client, a, b, offset)| {
            (
                client,
                a + start.saturating_sub(offset),
                a + (end - offset).min(b - a),
            )
        })
        .collect()
}
// Join clock gaps only when they contain no visible body contribution. Map/format
// items and already-deleted text cannot become future original characters (undo uses new IDs).
fn compact_origins(index: &[BodyInterval], start: u32, end: u32) -> Vec<(u64, u32, u32)> {
    let mut selected = origins_in(index, start, end);
    selected.sort_unstable();
    let mut all = std::collections::HashMap::<u64, Vec<(u32, u32)>>::new();
    for &(c, a, b, _) in index {
        all.entry(c).or_default().push((a, b));
    }
    for ranges in all.values_mut() {
        ranges.sort_unstable();
    }
    let mut result: Vec<(u64, u32, u32)> = Vec::new();
    for (c, a, b) in selected {
        if let Some(last) = result.last_mut().filter(|r| r.0 == c) {
            let ranges = &all[&c];
            let slot = ranges.partition_point(|&(_, end)| end <= last.2);
            if ranges.get(slot).is_none_or(|&(begin, _)| begin >= a) {
                last.2 = b;
                continue;
            }
        }
        result.push((c, a, b));
    }
    result
}
// Versioned compact arrays avoid repeating field names and UUID attributes for every keystroke.
type WireSpan = (
    String,
    String,
    Option<i64>,
    bool,
    Vec<(u64, u32, u32)>,
    Option<i64>,
    u8,
);
type WireEvent = (u8, i64, u8, Vec<WireSpan>);
fn encode_timing(event: &TimingEvent) -> Result<String> {
    let spans: Vec<WireSpan> = event
        .spans
        .iter()
        .map(|s| {
            (
                STANDARD.encode(s.start.encode_v1()),
                STANDARD.encode(s.end.encode_v1()),
                s.first_ms,
                s.touch,
                s.origins.clone(),
                s.carried_last_ms,
                s.carried_sources
                    .iter()
                    .fold(0, |mask, s| mask | if s == "device" { 1 } else { 2 }),
            )
        })
        .collect();
    Ok(serde_json::to_string(&(
        1,
        event.at_ms,
        match event.source.as_str() {
            "device" => 1,
            "import" => 2,
            _ => 0,
        },
        spans,
    ))?)
}
fn decode_timing(value: &str) -> Result<TimingEvent> {
    let (version, at_ms, source, spans): WireEvent = serde_json::from_str(value)?;
    let safe = |t: i64| (0..=9_007_199_254_740_991).contains(&t);
    if version != 1 || !safe(at_ms) || !matches!(source, 0..=2) {
        return Err(Error::Invalid("timing schema".into()));
    }
    let spans = spans
        .into_iter()
        .map(|(a, b, first, touch, origins, last, mask)| {
            if (source == 0 && touch)
                || first.is_some_and(|t| !safe(t))
                || last.is_some_and(|t| !safe(t))
                || mask > 3
                || origins
                    .iter()
                    .any(|&(c, a, b)| c > u32::MAX as u64 || a >= b)
            {
                return Err(Error::Invalid("timing span".into()));
            }
            let anchor = |s: &str| {
                StickyIndex::decode_v1(
                    &STANDARD
                        .decode(s)
                        .map_err(|e| Error::Invalid(e.to_string()))?,
                )
                .map_err(|e| Error::Invalid(e.to_string()))
            };
            let mut sources = Vec::new();
            if mask & 1 != 0 {
                sources.push("device".into());
            }
            if mask & 2 != 0 {
                sources.push("import".into());
            }
            Ok(TimingSpan {
                start: anchor(&a)?,
                end: anchor(&b)?,
                first_ms: first,
                touch,
                origins,
                carried_last_ms: last,
                carried_sources: sources,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(TimingEvent {
        at_ms,
        source: match source {
            1 => "device",
            2 => "import",
            _ => "unknown",
        }
        .into(),
        spans,
    })
}

pub(crate) fn update_actors(update: &Update) -> std::collections::HashMap<u64, u32> {
    let mut actors = std::collections::HashMap::new();
    let insertions: yrs::DeleteSet = update.insertions(true).into();
    for (&client, ranges) in insertions.iter() {
        for range in ranges.iter() {
            actors
                .entry(client)
                .and_modify(|v: &mut u32| *v = (*v).max(range.end))
                .or_insert(range.end);
        }
    }
    for (&client, ranges) in update.delete_set().iter() {
        for range in ranges.iter() {
            actors
                .entry(client)
                .and_modify(|v: &mut u32| *v = (*v).max(range.end))
                .or_insert(range.end);
        }
    }
    actors
}
