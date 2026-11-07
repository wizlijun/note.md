//! Long-lived background replica. It is never shared with the input thread.
//! Only a fully validated preparation can cross into the live document.
use super::*;
use std::collections::VecDeque;

#[derive(Clone)]
pub struct CandidateCommit {
    session: Uuid,
    generation: u64,
    base_revision: u64,
    update: Arc<[u8]>,
}

pub struct CandidateSession {
    id: Uuid,
    writer: u64,
    baseline: Document,
    candidate: Document,
    root: String,
    generation: u64,
    pending: VecDeque<(u64, Vec<u8>)>,
    confirmed: VecDeque<(u64, String)>,
    poisoned: bool,
}
impl CandidateSession {
    /// Cold seed, once per open or journal overflow. `writer` is the active UI
    /// actor, not the fresh actor used by this read-only background replica.
    pub fn new(page: &str, epoch: u32, writer: u64, state: &[u8], revision: u64) -> Result<Self> {
        let decoded = Update::decode_v1(state).map_err(|e| Error::Invalid(e.to_string()))?;
        let actors = update_actors(&decoded);
        let fresh = |excluded| loop {
            let id = u32::from_le_bytes(Uuid::new_v4().as_bytes()[..4].try_into().unwrap()) as u64;
            if id != writer && id != excluded && !actors.contains_key(&id) {
                break id;
            }
        };
        let baseline = Document::restore(page, epoch, fresh(writer), state, revision)?;
        let mut candidate = Document::empty(page, epoch, fresh(baseline.client_id()))?;
        candidate.integrate(state)?;
        candidate.revision = revision;
        *candidate.events.get_mut().unwrap() = baseline.events.read().unwrap().clone();
        let snapshot = baseline.snapshot()?;
        let root = snapshot.root_line_id.clone();
        *candidate.cached.get_mut().unwrap() = Some(snapshot);
        Ok(Self {
            id: Uuid::new_v4(),
            writer,
            baseline,
            candidate,
            root,
            generation: 0,
            pending: VecDeque::new(),
            confirmed: VecDeque::new(),
            poisoned: false,
        })
    }
    pub fn base_revision(&self) -> u64 {
        self.baseline.revision
    }
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
    fn check(&self) -> Result<()> {
        if self.poisoned {
            Err(Error::Invalid(
                "candidate quarantined; rebuild from last confirmed state and retained inbox"
                    .into(),
            ))
        } else {
            Ok(())
        }
    }
    /// Apply a FIFO record already committed by the live document. A skipped
    /// revision must trigger a new seed; never infer trust from network bytes.
    pub fn advance_local(&mut self, revision: u64, bytes: &[u8]) -> Result<()> {
        self.check()?;
        if revision
            != self
                .baseline
                .revision
                .checked_add(1)
                .ok_or(Error::StaleRevision)?
        {
            return Err(Error::StaleRevision);
        }
        // Local changes may resolve an old pending remote packet. Validate the
        // combined candidate before publishing it, even though this record is trusted.
        if let Err(error) = self.integrate_candidate(bytes) {
            self.poisoned = true;
            return Err(error);
        }
        self.baseline.integrate(bytes)?;
        self.confirmed
            .push_back((revision, crate::storage::sha256(bytes)));
        if self.confirmed.len() > 2048 {
            self.confirmed.pop_front();
        }
        Ok(())
    }
    /// Enqueue a remote packet, retaining its original bytes until confirmed.
    /// Failure poisons this private replica, never the live or confirmed state.
    pub fn receive_remote(&mut self, bytes: &[u8]) -> Result<()> {
        self.check()?;
        let decoded = Update::decode_v1(bytes).map_err(|e| Error::Invalid(e.to_string()))?;
        if update_actors(&decoded)
            .get(&self.writer)
            .copied()
            .unwrap_or(0)
            > self
                .baseline
                .doc
                .transact()
                .state_vector()
                .get(&self.writer)
        {
            return Err(Error::Invalid(
                "remote update references future clocks of active writer".into(),
            ));
        }
        if self.pending.len() >= 2048
            || self.pending.iter().map(|(_, u)| u.len()).sum::<usize>() + bytes.len()
                > 64 * 1024 * 1024
        {
            return Err(Error::Capacity);
        }
        self.generation = self.generation.checked_add(1).ok_or(Error::Capacity)?;
        self.pending.push_back((self.generation, bytes.to_vec()));
        if let Err(error) = self.integrate_candidate(bytes) {
            self.poisoned = true;
            return Err(error);
        }
        Ok(())
    }
    fn integrate_candidate(&mut self, bytes: &[u8]) -> Result<()> {
        self.candidate
            .integrate_observed(bytes, &self.root)
            .map(|_| ())
    }
    /// Re-emit after catch-up without copying the document or re-decoding its
    /// timing history. Main-thread commit still checks the exact causal cut.
    pub fn prepare_current(&self) -> Result<Option<PreparedRemote>> {
        self.check()?;
        let Some((generation, _)) = self.pending.back() else {
            return Ok(None);
        };
        let update: Arc<[u8]> =
            yrs::merge_updates_v1(self.pending.iter().map(|(_, u)| u.as_slice()))
                .map_err(|e| Error::Invalid(e.to_string()))?
                .into();
        let decoded = Update::decode_v1(&update).map_err(|e| Error::Invalid(e.to_string()))?;
        let causal = self.baseline.doc.transact().snapshot();
        let pending_hash = self
            .baseline
            .doc
            .transact()
            .has_missing_updates()
            .then(|| crate::storage::sha256(&self.baseline.encode_full()));
        let mut snapshot = self.candidate.snapshot()?;
        snapshot.revision = self
            .baseline
            .revision
            .checked_add(1)
            .ok_or(Error::Capacity)?;
        let token = CandidateCommit {
            session: self.id,
            generation: *generation,
            base_revision: self.baseline.revision,
            update: update.clone(),
        };
        Ok(Some(PreparedRemote {
            base_revision: self.baseline.revision,
            causal,
            pending_hash,
            actors: update_actors(&decoded),
            update,
            token: Some(token),
            snapshot,
            events: self.candidate.events.read().unwrap().clone(),
        }))
    }
    /// Acknowledge only after commit_prepared succeeded. This is called on the
    /// background owner, before catching up subsequent local journal records.
    /// If the committed record was already replayed, its exact bytes must match.
    pub fn ack_committed(&mut self, token: CandidateCommit) -> Result<()> {
        self.check()?;
        if token.session != self.id {
            return Err(Error::StaleRevision);
        }
        let target = token.base_revision.checked_add(1).ok_or(Error::Capacity)?;
        if self.baseline.revision == token.base_revision {
            self.baseline.integrate(&token.update)?;
            self.confirmed
                .push_back((target, crate::storage::sha256(&token.update)));
            if self.confirmed.len() > 2048 {
                self.confirmed.pop_front();
            }
        } else if self.baseline.revision < target
            || !self
                .confirmed
                .iter()
                .any(|(r, h)| *r == target && *h == crate::storage::sha256(&token.update))
        {
            return Err(Error::StaleRevision);
        }
        self.pending
            .retain(|(generation, _)| *generation > token.generation);
        Ok(())
    }
}
