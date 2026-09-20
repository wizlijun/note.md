use crate::integration;
use crate::model::*;
use crate::storage;
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

pub struct DictionaryService {
    vault: PathBuf,
}

impl DictionaryService {
    pub fn new(vault: PathBuf) -> Self {
        Self { vault }
    }

    pub fn vault(&self) -> &Path {
        &self.vault
    }

    pub fn status(&self) -> Value {
        let settings = match storage::load_settings(&self.vault) {
            Ok(settings) => settings,
            Err(error) => return json!({"status":"settings_invalid","error":error}),
        };
        match storage::verified_dictionary(&self.vault) {
            Ok((dictionary, baseline)) => match validate_dictionary_legacy(&dictionary) {
                Ok(()) => {
                    let migration = formal_name_migration(&dictionary, &baseline);
                    json!({
                        "schema": "notemd.conversation-dictionary-status.v1",
                        "status": if migration["required"] == true { "migration_required" } else { "ready" },
                        "dictionary_path": settings.dictionary_path,
                        "dictionary_id": dictionary.dictionary_id,
                        "subject_id": dictionary.subject_id,
                        "revision": dictionary.revision,
                        "domains": dictionary.domains,
                        "entries": dictionary.entries.len(),
                        "rules": dictionary.rules.len(),
                    })
                }
                Err(error) => json!({
                    "schema": "notemd.conversation-dictionary-status.v1",
                    "status": "needs_review",
                    "dictionary_path": settings.dictionary_path,
                    "error": error,
                }),
            },
            Err(error) => {
                let exists = storage::dictionary_path(&self.vault)
                    .map(|path| path.exists())
                    .unwrap_or(false);
                json!({
                    "schema": "notemd.conversation-dictionary-status.v1",
                    "status": if exists { "needs_review" } else { "not_created" },
                    "dictionary_path": settings.dictionary_path,
                    "error": error,
                })
            }
        }
    }

    pub fn bootstrap(&self) -> Result<Value, String> {
        self.recover_journal()?;
        let settings = storage::load_settings(&self.vault)?;
        let control = storage::load_control(&self.vault)?;
        let verified = storage::verified_dictionary(&self.vault).ok();
        let formal_name_migration = verified
            .as_ref()
            .map(|(dictionary, baseline)| formal_name_migration(dictionary, baseline))
            .unwrap_or_else(|| json!({"required":false,"entries":[]}));
        let dictionary = verified.map(|pair| pair.0);
        Ok(json!({
            "settings": settings,
            "status": self.status(),
            "dictionary": dictionary,
            "candidates": control.candidates,
            "batches": control.batches,
            "formal_name_migration": formal_name_migration,
            "agent_integration": integration::agent_integration_status(&self.vault),
            "example": integration::default_example(),
        }))
    }

    pub fn ensure_initialized(&self, subject_id: &str) -> Result<Value, String> {
        validate_subject(subject_id)?;
        let dictionary_created;
        let dictionary;
        {
            let _lock = storage::lock_file(&self.vault)?;
            self.recover_journal_locked()?;
            let path = storage::dictionary_path(&self.vault)?;
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err("dictionary path must not be a symbolic link".into());
                }
                Ok(_) => {
                    let (existing, baseline) = storage::verified_dictionary(&self.vault)?;
                    if existing.subject_id != subject_id {
                        return Err(
                            "dictionary subject does not match the current Vault author".into()
                        );
                    }
                    self.ensure_baseline_snapshot_locked(&baseline)?;
                    dictionary = existing;
                    dictionary_created = false;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if let Some(baseline) = storage::load_control(&self.vault)?.baseline {
                        dictionary =
                            self.restore_missing_dictionary_locked(&baseline, subject_id)?;
                        dictionary_created = false;
                    } else {
                        dictionary = new_dictionary(subject_id);
                        validate_dictionary(&dictionary)?;
                        let mut control = storage::load_control(&self.vault)?;
                        self.persist_new_dictionary(&dictionary, &mut control)?;
                        dictionary_created = true;
                    }
                }
                Err(error) => return Err(format!("{}: {error}", path.display())),
            }
        }
        let _integration_lock = storage::lock_file(&self.vault)?;
        let agent_integration = integration::ensure_agent_integration(&self.vault)?;
        Ok(json!({
            "status": if dictionary_created { "created" } else { "existing" },
            "dictionary_created": dictionary_created,
            "dictionary": dictionary,
            "agent_integration": agent_integration,
            "example": integration::default_example(),
        }))
    }

    pub fn create_dictionary(&self, subject_id: &str) -> Result<Value, String> {
        validate_subject(subject_id)?;
        let _lock = storage::lock_file(&self.vault)?;
        self.recover_journal_locked()?;
        let path = storage::dictionary_path(&self.vault)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                return Err("dictionary already exists; review it instead of overwriting".into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", path.display())),
        }
        let dictionary = new_dictionary(subject_id);
        validate_dictionary(&dictionary)?;
        let mut control = storage::load_control(&self.vault)?;
        self.persist_new_dictionary(&dictionary, &mut control)?;
        Ok(json!({"created":true,"dictionary":dictionary}))
    }

    pub fn check(&self) -> Result<Value, String> {
        self.recover_journal()?;
        let path = storage::dictionary_path(&self.vault)?;
        let (dictionary, bytes) = storage::read_dictionary(&path)?;
        validate_dictionary(&dictionary)?;
        let control = storage::load_control(&self.vault)?;
        let baseline = control
            .baseline
            .ok_or("dictionary has no locally reviewed baseline")?;
        let hash = storage::sha256(&bytes);
        if hash != baseline.sha256 {
            return Err("dictionary bytes differ from the reviewed baseline".into());
        }
        Ok(json!({
            "schema":"notemd.conversation-dictionary-check.v1",
            "status":"ok",
            "dictionary_id":dictionary.dictionary_id,
            "revision":dictionary.revision,
            "sha256":hash,
            "domains":dictionary.domains.len(),
            "entries":dictionary.entries.len(),
            "rules":dictionary.rules.len(),
        }))
    }

    pub fn list(&self, domain_id: &str) -> Result<Value, String> {
        let (dictionary, _) = storage::verified_dictionary(&self.vault)?;
        validate_dictionary(&dictionary)?;
        if !dictionary
            .domains
            .iter()
            .any(|domain| domain.id == domain_id)
        {
            return Err(format!("unknown domain '{domain_id}'"));
        }
        let entry_ids: HashSet<_> = dictionary
            .rules
            .iter()
            .filter(|rule| rule.enabled && rule.domain_id == domain_id)
            .filter_map(|rule| rule.target.as_ref().map(|target| target.entry_id.as_str()))
            .collect();
        let entries: Vec<_> = dictionary
            .entries
            .iter()
            .filter(|entry| entry_ids.contains(entry.id.as_str()))
            .cloned()
            .collect();
        let rules: Vec<_> = dictionary
            .rules
            .iter()
            .filter(|rule| rule.enabled && rule.domain_id == domain_id)
            .cloned()
            .collect();
        Ok(json!({
            "schema":"notemd.conversation-dictionary-list.v1",
            "dictionary_id":dictionary.dictionary_id,
            "revision":dictionary.revision,
            "domain_id":domain_id,
            "entries":entries,
            "rules":rules,
        }))
    }

    pub fn resolve(&self, request: ResolveRequest) -> Result<ResolveResult, String> {
        let (dictionary, _) = storage::verified_dictionary(&self.vault)?;
        validate_dictionary(&dictionary)?;
        validate_scope(&self.vault, &request.context, &dictionary.subject_id)?;
        if !dictionary
            .domains
            .iter()
            .any(|domain| domain.id == request.domain_id)
        {
            return Err(format!("unknown domain '{}'", request.domain_id));
        }
        let source = request
            .context
            .source
            .as_ref()
            .ok_or("source is required for communication ASR resolution")?;
        validate_resolve_source(&self.vault, source, &request.text)?;
        resolve_dictionary(&dictionary, &request.domain_id, &request.text)
    }

    pub fn propose(&self, proposal: ProposalInput) -> Result<Value, String> {
        let (dictionary, _) = storage::verified_dictionary(&self.vault)?;
        validate_proposal(&self.vault, &proposal)?;
        validate_scope_claim(&self.vault, &proposal.context, &dictionary.subject_id)?;
        if !dictionary
            .domains
            .iter()
            .any(|domain| domain.id == proposal.domain_id)
        {
            return Err(format!("unknown domain '{}'", proposal.domain_id));
        }
        let status = match proposal.context.communication.user_relation {
            UserRelation::Participant | UserRelation::DirectRecipient => CandidateStatus::Pending,
            UserRelation::Unknown => CandidateStatus::ScopePending,
            UserRelation::Consumer => return Ok(json!({"status":"out_of_scope","stored":false})),
        };
        let proposal_bytes = serde_json::to_vec(&proposal).map_err(|error| error.to_string())?;
        let hash = storage::sha256(&proposal_bytes);
        let _lock = storage::lock_file(&self.vault)?;
        let mut control = storage::load_control(&self.vault)?;
        if let Some(existing) = control
            .candidates
            .iter()
            .find(|candidate| candidate.hash == hash)
        {
            return Ok(json!({"status":"existing","candidate":existing}));
        }
        let candidate = CandidateRecord {
            id: Uuid::new_v4().to_string(),
            hash,
            status,
            received_at: now(),
            proposal,
        };
        control.candidates.push(candidate.clone());
        storage::save_control(&self.vault, &control)?;
        Ok(json!({"status":"stored","candidate":candidate}))
    }

    pub fn pending(&self, id: Option<&str>) -> Result<Value, String> {
        let control = storage::load_control(&self.vault)?;
        if let Some(id) = id {
            let candidate = control
                .candidates
                .iter()
                .find(|candidate| candidate.id == id)
                .ok_or_else(|| format!("unknown candidate '{id}'"))?;
            return Ok(json!({"candidate":candidate}));
        }
        let candidates: Vec<_> = control
            .candidates
            .iter()
            .filter(|candidate| {
                matches!(
                    candidate.status,
                    CandidateStatus::Pending | CandidateStatus::ScopePending
                )
            })
            .map(|candidate| {
                json!({
                    "id":candidate.id,
                    "status":candidate.status,
                    "observed":candidate.proposal.observed,
                    "domain_id":candidate.proposal.domain_id,
                    "received_at":candidate.received_at,
                    "candidate_count":candidate.proposal.candidates.len(),
                })
            })
            .collect();
        Ok(json!({"candidates":candidates}))
    }

    pub fn dataset_check_path(&self, input: &str) -> Result<Value, String> {
        let (_, dataset, hash, _) = self.read_dataset_input(input)?;
        let diagnostics = validate_dataset(&dataset)?;
        Ok(json!({
            "schema":"notemd.conversation-dictionary-dataset-check.v1",
            "status":"ok",
            "run_id":dataset.run_id,
            "sha256":hash,
            "proposals":dataset.proposals.len(),
            "diagnostics":diagnostics,
        }))
    }

    pub fn dataset_import_path(&self, input: &str) -> Result<Value, String> {
        let (bytes, mut dataset, hash, evidence_bytes) = self.read_dataset_input(input)?;
        validate_dataset(&dataset)?;
        let _lock = storage::lock_file(&self.vault)?;
        let mut control = storage::load_control(&self.vault)?;
        if let Some(existing) = control
            .batches
            .iter()
            .find(|batch| batch.run_id == dataset.run_id)
        {
            if existing.dataset_sha256 != hash {
                return Err("run_id already exists with different dataset bytes".into());
            }
            return Ok(json!({"status":"existing","run_id":dataset.run_id,"sha256":hash}));
        }
        if let Ok((dictionary, baseline)) = storage::verified_dictionary(&self.vault) {
            if dataset.subject_id != dictionary.subject_id {
                return Err("dataset subject does not match dictionary subject".into());
            }
            if dataset.base_dictionary.state == "present" {
                if dataset.base_dictionary.dictionary_id.as_deref()
                    != Some(dictionary.dictionary_id.as_str())
                {
                    return Err("dataset was generated for another dictionary".into());
                }
                if dataset.base_dictionary.sha256.as_deref() != Some(baseline.sha256.as_str()) {
                    return Err("dataset base is stale; regenerate or rebase before import".into());
                }
            } else if dictionary.revision != 1
                || !dictionary.domains.is_empty()
                || !dictionary.entries.is_empty()
                || !dictionary.rules.is_empty()
            {
                return Err(
                    "dataset without a base can only initialize an empty dictionary".into(),
                );
            }
            dataset.conflicts.extend(deterministic_dataset_conflicts(
                &dataset,
                Some(&dictionary),
            )?);
        } else if dataset.base_dictionary.state != "absent" {
            return Err("dataset expects an existing reviewed dictionary".into());
        } else {
            dataset
                .conflicts
                .extend(deterministic_dataset_conflicts(&dataset, None)?);
        }
        let snapshot_dir = self
            .vault
            .join(storage::CONTROL_DIR)
            .join("datasets")
            .join(&dataset.run_id);
        fs::create_dir_all(&snapshot_dir).map_err(|error| error.to_string())?;
        let snapshot = snapshot_dir.join("dataset.yml");
        storage::atomic_bytes(&snapshot, &bytes)?;
        storage::atomic_bytes(&snapshot_dir.join("evidence.jsonl"), &evidence_bytes)?;
        let proposal_states = dataset
            .proposals
            .iter()
            .map(|proposal| (proposal.id.clone(), ProposalReview::default()))
            .collect();
        control.batches.push(ReviewBatch {
            run_id: dataset.run_id.clone(),
            dataset_sha256: hash.clone(),
            imported_at: now(),
            dataset,
            proposal_states,
        });
        storage::save_control(&self.vault, &control)?;
        Ok(json!({"status":"imported","sha256":hash}))
    }

    pub fn batch_commit(&self, request: BatchCommitRequest) -> Result<Value, String> {
        if request.selected.is_empty() {
            return Err("select at least one proposal".into());
        }
        if request.transaction_id.trim().is_empty() {
            return Err("transaction_id is required".into());
        }
        let distinct_selected: HashSet<_> = request
            .selected
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        if distinct_selected.len() != request.selected.len() {
            return Err("selected proposal IDs must be unique".into());
        }
        let _lock = storage::lock_file(&self.vault)?;
        self.recover_journal_locked()?;
        let mut control = storage::load_control(&self.vault)?;
        let plan_hash =
            storage::sha256(&serde_json::to_vec(&request).map_err(|error| error.to_string())?);
        if let Some(existing) = control.transactions.get(&request.transaction_id) {
            if existing.plan_hash != plan_hash {
                return Err("transaction_id was already used for another plan".into());
            }
            let (dictionary, _) = storage::verified_dictionary(&self.vault)?;
            validate_dictionary(&dictionary)?;
            return Ok(existing.result.clone());
        }
        let (mut dictionary, baseline) = storage::verified_dictionary(&self.vault)?;
        validate_dictionary(&dictionary)?;
        if dictionary.revision != request.expected_dictionary_revision
            || baseline.sha256 != request.expected_dictionary_sha256
        {
            return Err("dictionary changed; refresh the review before saving".into());
        }
        let batch_index = control
            .batches
            .iter()
            .position(|batch| batch.run_id == request.run_id)
            .ok_or_else(|| format!("unknown dataset run '{}'", request.run_id))?;
        if control.batches[batch_index].dataset_sha256 != request.dataset_sha256 {
            return Err("dataset hash changed".into());
        }
        if !control.batches[batch_index].dataset.conflicts.is_empty() {
            return Err("dataset has unresolved conflicts; revise and import a new run".into());
        }
        validate_dataset(&control.batches[batch_index].dataset)?;
        let evidence_path = self
            .vault
            .join(storage::CONTROL_DIR)
            .join("datasets")
            .join(&request.run_id)
            .join("evidence.jsonl");
        let evidence_bytes = fs::read(&evidence_path)
            .map_err(|error| format!("{}: {error}", evidence_path.display()))?;
        if storage::sha256(&evidence_bytes)
            != control.batches[batch_index].dataset.evidence_file.sha256
        {
            return Err("stored evidence snapshot changed after import".into());
        }
        validate_evidence(
            &self.vault,
            &control.batches[batch_index].dataset,
            &evidence_bytes,
        )?;
        let proposal_lookup: HashMap<_, _> = control.batches[batch_index]
            .dataset
            .proposals
            .iter()
            .map(|proposal| (proposal.id.clone(), proposal.clone()))
            .collect();
        let selected_ids: HashSet<_> = request
            .selected
            .iter()
            .map(|selected| selected.id.as_str())
            .collect();
        for selected in &request.selected {
            let proposal = proposal_lookup
                .get(&selected.id)
                .ok_or_else(|| format!("unknown proposal '{}'", selected.id))?;
            let review = control.batches[batch_index]
                .proposal_states
                .get(&selected.id)
                .ok_or("proposal review state is missing")?;
            if review.revision != selected.review_revision {
                return Err(format!(
                    "proposal '{}' review revision is stale",
                    selected.id
                ));
            }
            if review.status != ProposalReviewStatus::Pending {
                return Err(format!("proposal '{}' is already finalized", selected.id));
            }
            for dependency in &proposal.depends_on {
                let dependency_state = control.batches[batch_index]
                    .proposal_states
                    .get(dependency)
                    .ok_or_else(|| format!("unknown dependency '{dependency}'"))?;
                if dependency_state.status != ProposalReviewStatus::Accepted
                    && !selected_ids.contains(dependency.as_str())
                {
                    return Err(format!(
                        "proposal '{}' requires '{}'",
                        selected.id, dependency
                    ));
                }
            }
        }
        let ordered = dependency_order(&request.selected, &proposal_lookup)?;
        let mut assigned: BTreeMap<String, String> = control.batches[batch_index]
            .proposal_states
            .iter()
            .filter_map(|(id, review)| {
                review
                    .permanent_id
                    .clone()
                    .map(|permanent| (id.clone(), permanent))
            })
            .collect();
        let original_dictionary = dictionary.clone();
        let actor = dictionary.subject_id.clone();
        let timestamp = now();
        for selected_id in ordered {
            let selected = request
                .selected
                .iter()
                .find(|item| item.id == selected_id)
                .unwrap();
            let proposal = proposal_lookup.get(&selected.id).unwrap();
            let value = selected
                .value
                .clone()
                .unwrap_or_else(|| proposal.value.clone());
            if value.get("confirmed_by").is_some() || value.get("confirmed_at").is_some() {
                return Err(format!(
                    "proposal '{}' attempts to inject approval metadata",
                    proposal.id
                ));
            }
            let edited_proposal = DatasetProposal {
                value: value.clone(),
                ..proposal.clone()
            };
            validate_proposal_value(&edited_proposal)?;
            let permanent = apply_proposal(
                &mut dictionary,
                proposal,
                &value,
                &assigned,
                &actor,
                &timestamp,
            )?;
            assigned.insert(selected.id.clone(), permanent.clone());
            let review = control.batches[batch_index]
                .proposal_states
                .get_mut(&selected.id)
                .unwrap();
            review.status = ProposalReviewStatus::Accepted;
            review.permanent_id = Some(permanent);
            review.edited_value = selected.value.clone();
            review.revision += 1;
        }
        let dictionary_changed = dictionary.domains != original_dictionary.domains
            || dictionary.entries != original_dictionary.entries
            || dictionary.rules != original_dictionary.rules;
        if dictionary_changed {
            dictionary.revision += 1;
            dictionary.updated_at = timestamp;
        }
        validate_dictionary(&dictionary)?;
        let introduced_conflicts =
            newly_introduced_rule_conflicts(&original_dictionary, &dictionary);
        if !introduced_conflicts.is_empty() {
            return Err(format!(
                "edited plan introduces rule conflicts for: {}",
                introduced_conflicts
                    .into_iter()
                    .map(|(domain, observed)| format!("{domain}/{observed}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let result = json!({
            "status": if dictionary_changed { "committed" } else { "no_change" },
            "transaction_id":request.transaction_id,
            "revision":dictionary.revision,
            "accepted":request.selected.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
        });
        control.transactions.insert(
            request.transaction_id.clone(),
            TransactionRecord {
                plan_hash,
                completed_at: now(),
                revision: dictionary.revision,
                result: result.clone(),
            },
        );
        self.persist_dictionary(
            &dictionary,
            &mut control,
            Some(&baseline.sha256),
            Some((&request.transaction_id, &result)),
        )?;
        Ok(result)
    }

    pub fn normalize_formal_names(
        &self,
        request: NormalizeFormalNamesRequest,
    ) -> Result<Value, String> {
        if request.transaction_id.trim().is_empty() {
            return Err("transaction_id is required".into());
        }
        let _lock = storage::lock_file(&self.vault)?;
        self.recover_journal_locked()?;
        let mut control = storage::load_control(&self.vault)?;
        let plan_hash =
            storage::sha256(&serde_json::to_vec(&request).map_err(|error| error.to_string())?);
        if let Some(existing) = control.transactions.get(&request.transaction_id) {
            if existing.plan_hash != plan_hash {
                return Err("transaction_id was already used for another plan".into());
            }
            let (dictionary, _) = storage::verified_dictionary(&self.vault)?;
            validate_dictionary_legacy(&dictionary)?;
            return Ok(existing.result.clone());
        }
        let (mut dictionary, baseline) = storage::verified_dictionary(&self.vault)?;
        validate_dictionary_legacy(&dictionary)?;
        if dictionary.revision != request.expected_revision
            || baseline.sha256 != request.expected_sha256
        {
            return Err("dictionary revision changed; refresh the migration preview".into());
        }
        let expected_ids: HashSet<_> = dictionary
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        let supplied_ids: HashSet<_> = request.formal_names.keys().map(String::as_str).collect();
        if expected_ids != supplied_ids {
            return Err("formal_names must include every dictionary entry exactly once".into());
        }
        let original = dictionary.clone();
        let confirmed_at = now();
        for entry in &mut dictionary.entries {
            let previous_formal_name = entry.label.clone();
            let formal_name = request
                .formal_names
                .get(&entry.id)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("entry '{}' requires a formal name", entry.id))?;
            entry.label = formal_name.to_string();
            if nfc(&previous_formal_name) != nfc(formal_name)
                && !entry
                    .forms
                    .iter()
                    .any(|form| nfc(form) == nfc(&previous_formal_name))
            {
                entry.forms.push(previous_formal_name);
            }
            if !entry.forms.iter().any(|form| nfc(form) == nfc(formal_name)) {
                entry.forms.insert(0, formal_name.to_string());
            }
        }
        let formal_names: HashMap<_, _> = dictionary
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.label.as_str()))
            .collect();
        let entry_domains: HashMap<String, HashSet<String>> = original
            .rules
            .iter()
            .filter_map(|rule| {
                rule.target
                    .as_ref()
                    .map(|target| (target.entry_id.clone(), rule.domain_id.clone()))
            })
            .fold(HashMap::new(), |mut result, (entry_id, domain_id)| {
                result.entry(entry_id).or_default().insert(domain_id);
                result
            });
        let mut normalized_rules: Vec<Rule> = Vec::with_capacity(dictionary.rules.len());
        let mut rule_groups: HashMap<(String, String, String), usize> = HashMap::new();
        let mut removed_noop_rule_ids = Vec::new();
        let mut consolidated_rules = Vec::new();
        let mut rules_updated = 0usize;
        for mut rule in std::mem::take(&mut dictionary.rules) {
            let Some(target) = &mut rule.target else {
                normalized_rules.push(rule);
                continue;
            };
            let formal_name = formal_names
                .get(target.entry_id.as_str())
                .ok_or_else(|| format!("rule '{}' has missing entry", rule.id))?
                .to_string();
            if target.text != formal_name {
                target.text = formal_name.clone();
                rule.confirmed_by = dictionary.subject_id.clone();
                rule.confirmed_at = confirmed_at.clone();
                rules_updated += 1;
            }
            if nfc(&rule.observed) == nfc(&formal_name) {
                removed_noop_rule_ids.push(rule.id);
                continue;
            }
            let key = (
                rule.domain_id.clone(),
                nfc(&rule.observed),
                target.entry_id.clone(),
            );
            if let Some(existing_index) = rule_groups.get(&key).copied() {
                let existing = &mut normalized_rules[existing_index];
                let conservative_application =
                    if matches!(existing.application, Some(RuleApplication::Suggest))
                        || matches!(rule.application, Some(RuleApplication::Suggest))
                    {
                        RuleApplication::Suggest
                    } else {
                        RuleApplication::Automatic
                    };
                existing.application = Some(conservative_application);
                existing.enabled &= rule.enabled;
                existing.confirmed_by = dictionary.subject_id.clone();
                existing.confirmed_at = confirmed_at.clone();
                consolidated_rules.push(json!({
                    "kept_rule_id": existing.id,
                    "removed_rule_id": rule.id,
                }));
                continue;
            }
            rule_groups.insert(key, normalized_rules.len());
            normalized_rules.push(rule);
        }
        let mut alias_rules_added = Vec::new();
        for entry in &dictionary.entries {
            let Some(domains) = entry_domains.get(&entry.id) else {
                continue;
            };
            for domain_id in domains {
                for alias in entry
                    .forms
                    .iter()
                    .filter(|form| nfc(form) != nfc(&entry.label))
                {
                    let key = (domain_id.clone(), nfc(alias), entry.id.clone());
                    if rule_groups.contains_key(&key) {
                        continue;
                    }
                    let rule = Rule {
                        id: format!("r_{}", Uuid::new_v4()),
                        domain_id: domain_id.clone(),
                        observed: alias.clone(),
                        action: RuleAction::Replace,
                        target: Some(RuleTarget {
                            entry_id: entry.id.clone(),
                            text: entry.label.clone(),
                        }),
                        application: Some(RuleApplication::Suggest),
                        enabled: true,
                        confirmed_by: dictionary.subject_id.clone(),
                        confirmed_at: confirmed_at.clone(),
                    };
                    rule_groups.insert(key, normalized_rules.len());
                    alias_rules_added.push(json!({
                        "rule_id": rule.id,
                        "entry_id": entry.id,
                        "domain_id": domain_id,
                        "observed": alias,
                    }));
                    normalized_rules.push(rule);
                }
            }
        }
        dictionary.rules = normalized_rules;
        validate_dictionary(&dictionary)?;
        let changed = dictionary.entries != original.entries || dictionary.rules != original.rules;
        if changed {
            dictionary.revision += 1;
            dictionary.updated_at = now();
        }
        let result = json!({
            "status": if changed { "committed" } else { "no_change" },
            "transaction_id": request.transaction_id,
            "revision": dictionary.revision,
            "entries": dictionary.entries.len(),
            "rules_updated": rules_updated,
            "rules_removed_as_noop": removed_noop_rule_ids,
            "rules_consolidated": consolidated_rules,
            "alias_rules_added": alias_rules_added,
        });
        control.transactions.insert(
            request.transaction_id.clone(),
            TransactionRecord {
                plan_hash,
                completed_at: now(),
                revision: dictionary.revision,
                result: result.clone(),
            },
        );
        self.persist_dictionary(
            &dictionary,
            &mut control,
            Some(&baseline.sha256),
            Some((&request.transaction_id, &result)),
        )?;
        Ok(result)
    }

    pub fn batch_evidence(&self, run_id: &str, proposal_id: &str) -> Result<Value, String> {
        let control = storage::load_control(&self.vault)?;
        let batch = control
            .batches
            .iter()
            .find(|batch| batch.run_id == run_id)
            .ok_or_else(|| format!("unknown dataset run '{run_id}'"))?;
        let proposal = batch
            .dataset
            .proposals
            .iter()
            .find(|proposal| proposal.id == proposal_id)
            .ok_or_else(|| format!("unknown proposal '{proposal_id}'"))?;
        let path = self
            .vault
            .join(storage::CONTROL_DIR)
            .join("datasets")
            .join(run_id)
            .join("evidence.jsonl");
        let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        if storage::sha256(&bytes) != batch.dataset.evidence_file.sha256 {
            return Err("stored evidence snapshot changed after import".into());
        }
        let wanted: HashSet<_> = proposal.evidence_ids.iter().map(String::as_str).collect();
        let sources: HashMap<_, _> = batch
            .dataset
            .sources
            .iter()
            .map(|source| (source.id.as_str(), source))
            .collect();
        let mut evidence = vec![];
        for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
            if line.iter().all(|byte| byte.is_ascii_whitespace()) {
                continue;
            }
            let value: Value = serde_json::from_slice(line)
                .map_err(|error| format!("stored evidence line {}: {error}", line_index + 1))?;
            let Some(id) = value.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !wanted.contains(id) {
                continue;
            }
            let source_id = value.get("source_id").and_then(Value::as_str).unwrap_or("");
            let source = sources.get(source_id);
            evidence.push(json!({
                "id": id,
                "source_id": source_id,
                "resource": source.map(|source| source.resource.as_str()),
                "observed": value.get("observed"),
                "excerpt": value.get("excerpt"),
                "locator": value.get("locator"),
                "communication": value.get("communication"),
            }));
        }
        if evidence.len() != wanted.len() {
            return Err("stored evidence snapshot is incomplete".into());
        }
        Ok(json!({"run_id":run_id,"proposal_id":proposal_id,"evidence":evidence}))
    }

    fn read_dataset_input(
        &self,
        input: &str,
    ) -> Result<(Vec<u8>, Dataset, String, Vec<u8>), String> {
        let path = resolve_input_path(&self.vault, input)?;
        let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        let dataset: Dataset = serde_yaml::from_slice(&bytes)
            .map_err(|error| format!("invalid dataset YAML: {error}"))?;
        let hash = storage::sha256(&bytes);
        let evidence_path = path
            .parent()
            .ok_or("dataset has no parent directory")?
            .join(&dataset.evidence_file.path);
        let canonical_evidence = evidence_path
            .canonicalize()
            .map_err(|error| format!("{}: {error}", evidence_path.display()))?;
        let vault = self
            .vault
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canonical_evidence.starts_with(&vault) {
            return Err("evidence file must be inside the current Vault".into());
        }
        let evidence_bytes = fs::read(&canonical_evidence).map_err(|error| error.to_string())?;
        if storage::sha256(&evidence_bytes) != dataset.evidence_file.sha256 {
            return Err("evidence file hash does not match dataset".into());
        }
        validate_evidence(&self.vault, &dataset, &evidence_bytes)?;
        Ok((bytes, dataset, hash, evidence_bytes))
    }

    fn ensure_baseline_snapshot_locked(&self, baseline: &Baseline) -> Result<(), String> {
        let dictionary_path = storage::dictionary_path(&self.vault)?;
        let bytes = fs::read(&dictionary_path)
            .map_err(|error| format!("{}: {error}", dictionary_path.display()))?;
        if storage::sha256(&bytes) != baseline.sha256 {
            return Err("dictionary changed before its recovery snapshot could be saved".into());
        }
        let snapshot = String::from_utf8(bytes)
            .map_err(|_| "dictionary recovery snapshot must be UTF-8".to_string())?;
        let mut control = storage::load_control(&self.vault)?;
        if control.baseline_dictionary.as_deref() == Some(snapshot.as_str()) {
            return Ok(());
        }
        control.baseline_dictionary = Some(snapshot);
        storage::save_control(&self.vault, &control)
    }

    fn restore_missing_dictionary_locked(
        &self,
        baseline: &Baseline,
        expected_subject_id: &str,
    ) -> Result<Dictionary, String> {
        let control = storage::load_control(&self.vault)?;
        let snapshot = control.baseline_dictionary.ok_or(
            "reviewed dictionary is missing and no verified recovery snapshot is available in the local control state",
        )?;
        let bytes = snapshot.as_bytes();
        if storage::sha256(bytes) != baseline.sha256 {
            return Err("reviewed dictionary is missing and its recovery snapshot does not match the reviewed baseline".into());
        }
        let dictionary: Dictionary = serde_yaml::from_slice(bytes)
            .map_err(|error| format!("invalid recovery dictionary snapshot: {error}"))?;
        if dictionary.dictionary_id != baseline.dictionary_id
            || dictionary.revision != baseline.revision
        {
            return Err("reviewed dictionary is missing and its recovery snapshot identity does not match the reviewed baseline".into());
        }
        if dictionary.subject_id != expected_subject_id {
            return Err("dictionary subject does not match the current Vault author".into());
        }
        validate_dictionary_legacy(&dictionary)?;
        let settings = storage::load_settings(&self.vault)?;
        let relative = storage::validate_relative_path(&settings.dictionary_path)?;
        let dictionary_path = storage::ensure_safe_parent(&self.vault, &relative)?;
        storage::atomic_bytes_create_new(&dictionary_path, bytes)?;
        Ok(dictionary)
    }

    fn persist_dictionary(
        &self,
        dictionary: &Dictionary,
        control: &mut ControlState,
        expected_preimage_sha256: Option<&str>,
        transaction: Option<(&str, &Value)>,
    ) -> Result<(), String> {
        let path = storage::dictionary_path(&self.vault)?;
        let bytes = storage::dictionary_bytes(dictionary)?;
        let hash = storage::sha256(&bytes);
        control.baseline = Some(Baseline {
            dictionary_id: dictionary.dictionary_id.clone(),
            revision: dictionary.revision,
            sha256: hash.clone(),
        });
        control.baseline_dictionary = Some(
            String::from_utf8(bytes.clone())
                .map_err(|_| "dictionary recovery snapshot must be UTF-8".to_string())?,
        );
        let journal = json!({
            "schema":"notemd.conversation-dictionary-journal.v1",
            "dictionary_path":path.strip_prefix(&self.vault).unwrap_or(&path),
            "dictionary":dictionary,
            "dictionary_sha256":hash,
            "previous_dictionary_sha256":expected_preimage_sha256,
            "control":control,
            "transaction_id":transaction.map(|pair| pair.0),
            "result":transaction.map(|pair| pair.1),
        });
        storage::atomic_json(&storage::journal_path(&self.vault), &journal)?;
        let write_result = match expected_preimage_sha256 {
            Some(expected) => storage::atomic_bytes_if_sha256(&path, &bytes, expected),
            None => storage::atomic_bytes(&path, &bytes),
        };
        if let Err(error) = write_result {
            let _ = fs::remove_file(storage::journal_path(&self.vault));
            return Err(error);
        }
        storage::save_control(&self.vault, control)?;
        fs::remove_file(storage::journal_path(&self.vault)).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn persist_new_dictionary(
        &self,
        dictionary: &Dictionary,
        control: &mut ControlState,
    ) -> Result<(), String> {
        let settings = storage::load_settings(&self.vault)?;
        let relative = storage::validate_relative_path(&settings.dictionary_path)?;
        let path = storage::ensure_safe_parent(&self.vault, &relative)?;
        let bytes = storage::dictionary_bytes(dictionary)?;
        let hash = storage::sha256(&bytes);
        control.baseline = Some(Baseline {
            dictionary_id: dictionary.dictionary_id.clone(),
            revision: dictionary.revision,
            sha256: hash.clone(),
        });
        control.baseline_dictionary = Some(
            String::from_utf8(bytes.clone())
                .map_err(|_| "dictionary recovery snapshot must be UTF-8".to_string())?,
        );
        let journal = json!({
            "schema":"notemd.conversation-dictionary-journal.v1",
            "dictionary_path":relative,
            "dictionary":dictionary,
            "dictionary_sha256":hash,
            "previous_dictionary_sha256":Value::Null,
            "control":control,
            "transaction_id":Value::Null,
            "result":Value::Null,
        });
        storage::atomic_json(&storage::journal_path(&self.vault), &journal)?;
        if let Err(error) = storage::atomic_bytes_create_new(&path, &bytes) {
            let _ = fs::remove_file(storage::journal_path(&self.vault));
            return Err(error);
        }
        storage::save_control(&self.vault, control)?;
        fs::remove_file(storage::journal_path(&self.vault)).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn recover_journal(&self) -> Result<(), String> {
        let _lock = storage::lock_file(&self.vault)?;
        self.recover_journal_locked()
    }

    fn recover_journal_locked(&self) -> Result<(), String> {
        let path = storage::journal_path(&self.vault);
        if !path.exists() {
            return Ok(());
        }
        let journal: Value = storage::read_json(&path)?;
        let dictionary: Dictionary = serde_json::from_value(journal["dictionary"].clone())
            .map_err(|error| format!("invalid recovery dictionary: {error}"))?;
        let mut control: ControlState = serde_json::from_value(journal["control"].clone())
            .map_err(|error| format!("invalid recovery control: {error}"))?;
        let expected = journal["dictionary_sha256"]
            .as_str()
            .ok_or("journal dictionary hash is missing")?;
        let dictionary_path = storage::dictionary_path(&self.vault)?;
        let current = fs::read(&dictionary_path)
            .ok()
            .map(|bytes| storage::sha256(&bytes));
        let previous = journal["previous_dictionary_sha256"]
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                storage::load_control(&self.vault)
                    .ok()
                    .and_then(|control| control.baseline.map(|baseline| baseline.sha256))
            });
        if current.as_deref() == Some(expected) {
            let bytes = storage::dictionary_bytes(&dictionary)?;
            control.baseline = Some(Baseline {
                dictionary_id: dictionary.dictionary_id,
                revision: dictionary.revision,
                sha256: expected.into(),
            });
            control.baseline_dictionary = Some(
                String::from_utf8(bytes)
                    .map_err(|_| "dictionary recovery snapshot must be UTF-8".to_string())?,
            );
            storage::save_control(&self.vault, &control)?;
            fs::remove_file(path).map_err(|error| error.to_string())?;
            return Ok(());
        }
        if current == previous || (current.is_none() && previous.is_none()) {
            let bytes = storage::dictionary_bytes(&dictionary)?;
            storage::atomic_bytes(&dictionary_path, &bytes)?;
            control.baseline = Some(Baseline {
                dictionary_id: dictionary.dictionary_id,
                revision: dictionary.revision,
                sha256: expected.into(),
            });
            control.baseline_dictionary = Some(
                String::from_utf8(bytes)
                    .map_err(|_| "dictionary recovery snapshot must be UTF-8".to_string())?,
            );
            storage::save_control(&self.vault, &control)?;
            fs::remove_file(path).map_err(|error| error.to_string())?;
            return Ok(());
        }
        Err("recovery journal conflicts with externally changed dictionary".into())
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn new_dictionary(subject_id: &str) -> Dictionary {
    Dictionary {
        schema: DICTIONARY_SCHEMA.into(),
        dictionary_id: format!("dict_{}", Uuid::new_v4()),
        revision: 1,
        updated_at: now(),
        subject_id: subject_id.into(),
        scope: "user_communications".into(),
        domains: vec![],
        entries: vec![],
        rules: vec![],
    }
}

fn validate_subject(subject: &str) -> Result<(), String> {
    if !subject.starts_with("human:") || subject.len() <= "human:".len() {
        return Err("subject_id must use human:<id>".into());
    }
    Ok(())
}

pub fn validate_dictionary(dictionary: &Dictionary) -> Result<(), String> {
    validate_dictionary_legacy(dictionary)?;
    let migration = formal_name_migration_issues(dictionary);
    if !migration.is_empty() {
        return Err("dictionary requires formal-name migration before rules can be applied".into());
    }
    Ok(())
}

fn validate_dictionary_legacy(dictionary: &Dictionary) -> Result<(), String> {
    if dictionary.schema != DICTIONARY_SCHEMA {
        return Err(format!(
            "unsupported dictionary schema '{}'",
            dictionary.schema
        ));
    }
    if dictionary.revision == 0 || dictionary.dictionary_id.trim().is_empty() {
        return Err("dictionary_id and positive revision are required".into());
    }
    validate_subject(&dictionary.subject_id)?;
    if dictionary.scope != "user_communications" {
        return Err("scope must be user_communications".into());
    }
    let mut domain_ids = HashSet::new();
    for domain in &dictionary.domains {
        if domain.id.trim().is_empty()
            || domain.name.trim().is_empty()
            || !domain_ids.insert(domain.id.as_str())
        {
            return Err(format!("invalid or duplicate domain id '{}'", domain.id));
        }
    }
    let mut entries = HashMap::new();
    for entry in &dictionary.entries {
        if entry.id.trim().is_empty()
            || entry.label.trim().is_empty()
            || entries.insert(entry.id.as_str(), entry).is_some()
        {
            return Err(format!("invalid or duplicate entry id '{}'", entry.id));
        }
        if entry.forms.is_empty() || entry.forms.iter().any(|form| form.trim().is_empty()) {
            return Err(format!("entry '{}' requires non-empty forms", entry.id));
        }
        let normalized: HashSet<_> = entry.forms.iter().map(|form| nfc(form)).collect();
        if normalized.len() != entry.forms.len() {
            return Err(format!(
                "entry '{}' has duplicate normalized forms",
                entry.id
            ));
        }
    }
    let mut rule_ids = HashSet::new();
    let mut exact_rules = HashSet::new();
    for rule in &dictionary.rules {
        if rule.id.trim().is_empty() || !rule_ids.insert(rule.id.as_str()) {
            return Err(format!("invalid or duplicate rule id '{}'", rule.id));
        }
        if !domain_ids.contains(rule.domain_id.as_str()) || rule.observed.trim().is_empty() {
            return Err(format!(
                "rule '{}' has invalid domain or observed text",
                rule.id
            ));
        }
        match rule.action {
            RuleAction::Replace => {
                let target = rule
                    .target
                    .as_ref()
                    .ok_or_else(|| format!("rule '{}' requires target", rule.id))?;
                if rule.application.is_none() {
                    return Err(format!("rule '{}' requires application", rule.id));
                }
                let entry = entries
                    .get(target.entry_id.as_str())
                    .ok_or_else(|| format!("rule '{}' has missing entry", rule.id))?;
                if !entry
                    .forms
                    .iter()
                    .any(|form| nfc(form) == nfc(&target.text))
                {
                    return Err(format!("rule '{}' output is not an entry form", rule.id));
                }
                if nfc(&rule.observed) == nfc(&target.text) {
                    return Err(format!("rule '{}' replacement is a no-op", rule.id));
                }
            }
            RuleAction::Preserve => {
                if rule.target.is_some() || rule.application.is_some() {
                    return Err(format!(
                        "preserve rule '{}' cannot have target/application",
                        rule.id
                    ));
                }
            }
        }
        let signature = format!(
            "{}\0{}\0{:?}\0{:?}\0{:?}",
            rule.domain_id,
            nfc(&rule.observed),
            rule.action,
            rule.target,
            rule.application
        );
        if !exact_rules.insert(signature) {
            return Err(format!(
                "duplicate rule definition '{}': {}",
                rule.domain_id, rule.observed
            ));
        }
    }
    Ok(())
}

fn formal_name_migration_issues(dictionary: &Dictionary) -> Vec<Value> {
    let entries: HashMap<_, _> = dictionary
        .entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let mut issues = Vec::new();
    let mut normalized_rules: HashSet<(String, String, String)> = HashSet::new();
    for entry in &dictionary.entries {
        if !entry
            .forms
            .iter()
            .any(|form| nfc(form) == nfc(&entry.label))
        {
            issues.push(json!({
                "kind": "formal_name_missing_from_forms",
                "entry_id": entry.id,
                "formal_name": entry.label,
            }));
        }
    }
    for rule in &dictionary.rules {
        if !matches!(rule.action, RuleAction::Replace) {
            continue;
        }
        if let Some(target) = &rule.target {
            if let Some(entry) = entries.get(target.entry_id.as_str()) {
                if target.text != entry.label {
                    issues.push(json!({
                        "kind": "rule_output_is_not_formal_name",
                        "entry_id": entry.id,
                        "rule_id": rule.id,
                        "current_output": target.text,
                        "formal_name": entry.label,
                    }));
                }
                if nfc(&rule.observed) == nfc(&entry.label) {
                    issues.push(json!({
                        "kind": "rule_becomes_noop_with_formal_name",
                        "entry_id": entry.id,
                        "rule_id": rule.id,
                    }));
                }
                let key = (
                    rule.domain_id.clone(),
                    nfc(&rule.observed),
                    entry.id.clone(),
                );
                if !normalized_rules.insert(key) {
                    issues.push(json!({
                        "kind": "rules_collapse_after_formal_name_normalization",
                        "entry_id": entry.id,
                        "rule_id": rule.id,
                    }));
                }
            }
        }
    }
    issues
}

fn formal_name_migration(dictionary: &Dictionary, baseline: &Baseline) -> Value {
    let issues = formal_name_migration_issues(dictionary);
    let entries: Vec<_> = dictionary
        .entries
        .iter()
        .map(|entry| {
            let aliases: Vec<_> = entry
                .forms
                .iter()
                .filter(|form| nfc(form) != nfc(&entry.label))
                .cloned()
                .collect();
            let affected: Vec<_> = dictionary
                .rules
                .iter()
                .filter_map(|rule| {
                    rule.target.as_ref().and_then(|target| {
                        (target.entry_id == entry.id).then(|| {
                            json!({
                                "rule_id": rule.id,
                                "domain_id": rule.domain_id,
                                "observed": rule.observed,
                                "current_output": target.text,
                                "application": rule.application,
                                "enabled": rule.enabled,
                            })
                        })
                    })
                })
                .collect();
            json!({
                "id": entry.id,
                "kind": entry.kind,
                "formal_name": entry.label,
                "aliases": aliases,
                "formal_name_missing": !entry.forms.iter().any(|form| nfc(form) == nfc(&entry.label)),
                "affected_rules": affected,
            })
        })
        .collect();
    json!({
        "required": !issues.is_empty(),
        "expected_revision": dictionary.revision,
        "expected_sha256": baseline.sha256,
        "entries": entries,
        "issues": issues,
    })
}

fn validate_scope_claim(
    vault: &Path,
    context: &SourceContext,
    subject: &str,
) -> Result<(), String> {
    if context.subject_id != subject {
        return Err("scope_unverified: context subject does not match dictionary subject".into());
    }
    if context.communication.basis.detail.trim().is_empty() {
        return Err("scope_unverified: scope basis detail is required".into());
    }
    if matches!(
        context.communication.basis.kind,
        ScopeBasisKind::SourceMetadata
    ) && (context
        .communication
        .basis
        .resource
        .as_deref()
        .unwrap_or("")
        .is_empty()
        || context
            .communication
            .basis
            .resource_sha256
            .as_deref()
            .unwrap_or("")
            .is_empty())
    {
        return Err("scope_unverified: source metadata basis requires resource and hash".into());
    }
    if matches!(
        context.communication.basis.kind,
        ScopeBasisKind::SourceMetadata
    ) {
        let resource = context.communication.basis.resource.as_deref().unwrap();
        let expected = context
            .communication
            .basis
            .resource_sha256
            .as_deref()
            .unwrap();
        if !is_sha256(expected) {
            return Err("scope_unverified: source metadata hash is invalid".into());
        }
        let path = resolve_input_path(vault, resource)?;
        let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        if storage::sha256(&bytes) != expected {
            return Err("scope_unverified: source metadata changed".into());
        }
    }
    Ok(())
}

fn validate_scope(vault: &Path, context: &SourceContext, subject: &str) -> Result<(), String> {
    validate_scope_claim(vault, context, subject)?;
    match context.communication.user_relation {
        UserRelation::Participant | UserRelation::DirectRecipient => Ok(()),
        UserRelation::Consumer => Err("out_of_scope: subject only consumes this content".into()),
        UserRelation::Unknown => Err("scope_unverified: participation is unknown".into()),
    }
}

fn validate_resolve_source(vault: &Path, source: &SourceRef, text: &str) -> Result<(), String> {
    if !is_sha256(&source.content_sha256) || source.span.start >= source.span.end {
        return Err("source hash/span is invalid".into());
    }
    if let Some(resource) = source.resource.as_deref() {
        let path = resolve_input_path(vault, resource)?;
        let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        if storage::sha256(&bytes) != source.content_sha256 {
            return Err("source changed after the request was prepared".into());
        }
        let source_text =
            std::str::from_utf8(&bytes).map_err(|_| "source text is not UTF-8".to_string())?;
        let selected: String = source_text
            .chars()
            .skip(source.span.start)
            .take(source.span.end.saturating_sub(source.span.start))
            .collect();
        if selected != text {
            return Err("source span does not locate request text".into());
        }
    } else {
        if source.span.start != 0 || source.span.end != text.chars().count() {
            return Err("inline source span must cover the complete request text".into());
        }
        if storage::sha256(text.as_bytes()) != source.content_sha256 {
            return Err("source content_sha256 does not match request text".into());
        }
    }
    Ok(())
}

fn validate_proposal(vault: &Path, proposal: &ProposalInput) -> Result<(), String> {
    if proposal.schema != "notemd.conversation-dictionary-proposal.v1" {
        return Err("unsupported proposal schema".into());
    }
    if proposal.observed.trim().is_empty() || proposal.observed.chars().count() > 128 {
        return Err("observed must contain 1-128 code points".into());
    }
    if proposal.candidates.len() > 3 {
        return Err("at most three candidates are allowed".into());
    }
    for candidate in &proposal.candidates {
        if candidate.output.trim().is_empty()
            || !(0.0..=1.0).contains(&candidate.confidence)
            || candidate.reason.chars().count() > 512
        {
            return Err("candidate output, confidence or reason is invalid".into());
        }
    }
    let source = proposal
        .source
        .as_ref()
        .ok_or("candidate source is required")?;
    if !matches!(source.content_kind, ContentKind::AsrTranscript) {
        return Err("new candidates require an ASR transcript source".into());
    }
    if source.excerpt.chars().count() > 2_000
        || !is_sha256(&source.content_sha256)
        || source.span.start >= source.span.end
        || source.excerpt_span.start >= source.excerpt_span.end
    {
        return Err("candidate source hash/span is invalid".into());
    }
    let source_text = if let Some(resource) = source.resource.as_deref() {
        let path = resolve_input_path(vault, resource)?;
        let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        if storage::sha256(&bytes) != source.content_sha256 {
            return Err("candidate source changed after the request was prepared".into());
        }
        std::str::from_utf8(&bytes)
            .map_err(|_| "candidate source is not UTF-8".to_string())?
            .to_string()
    } else {
        if storage::sha256(source.excerpt.as_bytes()) != source.content_sha256 {
            return Err("candidate inline source hash does not match excerpt".into());
        }
        source.excerpt.clone()
    };
    let selected: String = source_text
        .chars()
        .skip(source.span.start)
        .take(source.span.end.saturating_sub(source.span.start))
        .collect();
    if selected != proposal.observed {
        return Err("candidate source hash/span does not locate observed text".into());
    }
    let selected_excerpt: String = source_text
        .chars()
        .skip(source.excerpt_span.start)
        .take(
            source
                .excerpt_span
                .end
                .saturating_sub(source.excerpt_span.start),
        )
        .collect();
    if source.excerpt_span.start > source.span.start
        || source.span.end > source.excerpt_span.end
        || selected_excerpt != source.excerpt
    {
        return Err("candidate excerpt does not match its source span".into());
    }
    Ok(())
}

pub fn validate_dataset(dataset: &Dataset) -> Result<Vec<String>, String> {
    if dataset.schema != DATASET_SCHEMA {
        return Err(format!("unsupported dataset schema '{}'", dataset.schema));
    }
    Uuid::parse_str(&dataset.run_id).map_err(|_| "run_id must be a UUID")?;
    validate_subject(&dataset.subject_id)?;
    let coverage_total = dataset.coverage.processed
        + dataset.coverage.excluded
        + dataset.coverage.unknown_scope
        + dataset.coverage.failed
        + dataset.coverage.pending;
    if coverage_total != dataset.coverage.discovered
        || dataset.coverage.chunks_processed > dataset.coverage.chunks_planned
    {
        return Err("dataset coverage counters are inconsistent".into());
    }
    if dataset.sources.len() as u64 != dataset.coverage.discovered {
        return Err("sources count does not match coverage.discovered".into());
    }
    if validate_vault_relative_resource(&dataset.evidence_file.path).is_err()
        || !is_sha256(&dataset.evidence_file.sha256)
    {
        return Err("dataset evidence_file path/hash is invalid".into());
    }
    match dataset.base_dictionary.state.as_str() {
        "absent" => {
            if dataset.base_dictionary.dictionary_id.is_some()
                || dataset.base_dictionary.revision.is_some()
                || dataset.base_dictionary.sha256.is_some()
            {
                return Err("absent base_dictionary cannot include identity fields".into());
            }
        }
        "present" => {
            if dataset
                .base_dictionary
                .dictionary_id
                .as_deref()
                .unwrap_or("")
                .is_empty()
                || dataset.base_dictionary.revision.unwrap_or(0) == 0
                || !is_sha256(dataset.base_dictionary.sha256.as_deref().unwrap_or(""))
            {
                return Err("present base_dictionary requires id, revision and SHA-256".into());
            }
        }
        _ => return Err("base_dictionary.state must be absent or present".into()),
    }
    let mut source_ids = HashSet::new();
    let mut source_counts: HashMap<&str, u64> = HashMap::new();
    for source in &dataset.sources {
        if source.id.trim().is_empty()
            || !source_ids.insert(source.id.as_str())
            || source.canonical_source_id.trim().is_empty()
            || validate_vault_relative_resource(&source.resource).is_err()
            || !is_sha256(&source.content_sha256)
        {
            return Err(format!(
                "dataset source '{}' has invalid identity",
                source.id
            ));
        }
        if !matches!(
            source.status.as_str(),
            "processed" | "excluded" | "unknown_scope" | "failed" | "pending"
        ) {
            return Err(format!("dataset source '{}' has invalid status", source.id));
        }
        *source_counts.entry(source.status.as_str()).or_default() += 1;
        for range in source
            .eligible_ranges
            .iter()
            .chain(source.processed_ranges.iter())
        {
            if range[0] >= range[1] {
                return Err(format!(
                    "dataset source '{}' has an invalid range",
                    source.id
                ));
            }
        }
        for processed in &source.processed_ranges {
            if !source
                .eligible_ranges
                .iter()
                .any(|eligible| eligible[0] <= processed[0] && processed[1] <= eligible[1])
            {
                return Err(format!(
                    "dataset source '{}' processed outside an eligible range",
                    source.id
                ));
            }
        }
    }
    for (status, expected) in [
        ("processed", dataset.coverage.processed),
        ("excluded", dataset.coverage.excluded),
        ("unknown_scope", dataset.coverage.unknown_scope),
        ("failed", dataset.coverage.failed),
        ("pending", dataset.coverage.pending),
    ] {
        if source_counts.get(status).copied().unwrap_or(0) != expected {
            return Err(format!(
                "source status count does not match coverage.{status}"
            ));
        }
    }
    let proposal_ids: HashSet<_> = dataset
        .proposals
        .iter()
        .map(|proposal| proposal.id.as_str())
        .collect();
    if proposal_ids.len() != dataset.proposals.len() || proposal_ids.contains("") {
        return Err("dataset proposal IDs must be unique and non-empty".into());
    }
    for proposal in &dataset.proposals {
        if !matches!(
            proposal.kind.as_str(),
            "create_domain" | "create_entry" | "add_forms" | "create_rule"
        ) {
            return Err(format!("unsupported proposal kind '{}'", proposal.kind));
        }
        if proposal.value.get("confirmed_by").is_some()
            || proposal.value.get("confirmed_at").is_some()
        {
            return Err(format!(
                "proposal '{}' attempts to inject approval metadata",
                proposal.id
            ));
        }
        if proposal.kind != "create_domain" && proposal.evidence_ids.is_empty() {
            return Err(format!(
                "proposal '{}' requires verified communication evidence",
                proposal.id
            ));
        }
        for dependency in &proposal.depends_on {
            if !proposal_ids.contains(dependency.as_str()) || dependency == &proposal.id {
                return Err(format!(
                    "proposal '{}' has invalid dependency '{}'",
                    proposal.id, dependency
                ));
            }
        }
        validate_proposal_value(proposal)?;
    }
    let lookup: HashMap<_, _> = dataset
        .proposals
        .iter()
        .map(|proposal| (proposal.id.as_str(), proposal))
        .collect();
    for proposal in &dataset.proposals {
        visit_dependency(&proposal.id, &lookup, &mut vec![], &mut HashSet::new())?;
        if proposal.kind == "create_rule" {
            let rule: RuleDraft = serde_json::from_value(proposal.value.clone())
                .map_err(|error| format!("proposal '{}': {error}", proposal.id))?;
            if let Some(target) = rule.target {
                if let Some(entry_proposal_id) = target.entry_ref.proposal_id {
                    let entry_proposal =
                        lookup.get(entry_proposal_id.as_str()).ok_or_else(|| {
                            format!(
                                "proposal '{}' references missing entry proposal '{}'",
                                proposal.id, entry_proposal_id
                            )
                        })?;
                    if entry_proposal.kind != "create_entry" {
                        return Err(format!(
                            "proposal '{}' target '{}' is not an entry proposal",
                            proposal.id, entry_proposal_id
                        ));
                    }
                    let entry: EntryDraft = serde_json::from_value(entry_proposal.value.clone())
                        .map_err(|error| format!("proposal '{}': {error}", entry_proposal.id))?;
                    if target.text != entry.label {
                        return Err(format!(
                            "proposal '{}' output must equal the target entry formal name",
                            proposal.id
                        ));
                    }
                }
            }
        }
    }
    let mut diagnostics = vec![];
    if dataset.coverage.failed > 0
        || dataset.coverage.unknown_scope > 0
        || dataset.coverage.pending > 0
    {
        diagnostics.push("dataset coverage has failed, unknown or pending sources".into());
    }
    if !dataset.conflicts.is_empty() {
        diagnostics.push(format!(
            "dataset reports {} unresolved conflicts",
            dataset.conflicts.len()
        ));
    }
    Ok(diagnostics)
}

fn validate_evidence(vault: &Path, dataset: &Dataset, bytes: &[u8]) -> Result<(), String> {
    let sources: HashMap<_, _> = dataset
        .sources
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();
    let mut evidence_ids = HashSet::new();
    for (line_index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(|byte| byte.is_ascii_whitespace()) {
            continue;
        }
        let value: Value = serde_json::from_slice(line)
            .map_err(|error| format!("evidence line {}: {error}", line_index + 1))?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("evidence line {} has no id", line_index + 1))?;
        if !evidence_ids.insert(id.to_string()) {
            return Err(format!("duplicate evidence id '{id}'"));
        }
        if value.get("subject_id").and_then(Value::as_str) != Some(dataset.subject_id.as_str()) {
            return Err(format!("evidence '{id}' subject does not match dataset"));
        }
        let relation = value
            .pointer("/communication/user_relation")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("evidence '{id}' has no communication relation"))?;
        if !matches!(relation, "participant" | "direct_recipient") {
            return Err(format!(
                "evidence '{id}' is outside confirmed user communication scope"
            ));
        }
        let basis_detail = value
            .pointer("/communication/basis/detail")
            .and_then(Value::as_str)
            .unwrap_or("");
        if basis_detail.trim().is_empty() {
            return Err(format!("evidence '{id}' has no participation basis"));
        }
        let source_id = value
            .get("source_id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("evidence '{id}' has no source_id"))?;
        let source = sources
            .get(source_id)
            .ok_or_else(|| format!("evidence '{id}' references unknown source"))?;
        if value.get("content_sha256").and_then(Value::as_str)
            != Some(source.content_sha256.as_str())
        {
            return Err(format!(
                "evidence '{id}' source hash differs from inventory"
            ));
        }
        let resource = resolve_input_path(vault, &source.resource)?;
        let source_bytes = fs::read(&resource).map_err(|error| error.to_string())?;
        if storage::sha256(&source_bytes) != source.content_sha256 {
            return Err(format!("source '{}' changed after scan", source.resource));
        }
        let source_text = std::str::from_utf8(&source_bytes)
            .map_err(|_| format!("source '{}' is not UTF-8", source.resource))?;
        let start = value
            .pointer("/span/start")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("evidence '{id}' span.start missing"))?
            as usize;
        let end = value
            .pointer("/span/end")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("evidence '{id}' span.end missing"))? as usize;
        if source.status != "processed"
            || !source
                .processed_ranges
                .iter()
                .any(|range| range[0] <= start && end <= range[1])
        {
            return Err(format!(
                "evidence '{id}' is outside the source's processed communication ranges"
            ));
        }
        let observed = value
            .get("observed")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("evidence '{id}' observed missing"))?;
        let selected: String = source_text
            .chars()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect();
        if start >= end || selected != observed {
            return Err(format!(
                "evidence '{id}' span does not locate observed text"
            ));
        }
        let excerpt = value
            .get("excerpt")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("evidence '{id}' excerpt missing"))?;
        if excerpt.chars().count() > 2_000 {
            return Err(format!("evidence '{id}' excerpt is too long"));
        }
        let excerpt_start = value
            .pointer("/excerpt_span/start")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("evidence '{id}' excerpt_span.start missing"))?
            as usize;
        let excerpt_end = value
            .pointer("/excerpt_span/end")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("evidence '{id}' excerpt_span.end missing"))?
            as usize;
        let selected_excerpt: String = source_text
            .chars()
            .skip(excerpt_start)
            .take(excerpt_end.saturating_sub(excerpt_start))
            .collect();
        if excerpt_start >= excerpt_end
            || excerpt_start > start
            || end > excerpt_end
            || selected_excerpt != excerpt
        {
            return Err(format!(
                "evidence '{id}' excerpt does not match its source span"
            ));
        }
    }
    for proposal in &dataset.proposals {
        for evidence_id in &proposal.evidence_ids {
            if !evidence_ids.contains(evidence_id) {
                return Err(format!(
                    "proposal '{}' references missing evidence '{}'",
                    proposal.id, evidence_id
                ));
            }
        }
    }
    Ok(())
}

fn validate_proposal_value(proposal: &DatasetProposal) -> Result<(), String> {
    match proposal.kind.as_str() {
        "create_domain" => {
            let value: DomainDraft = serde_json::from_value(proposal.value.clone())
                .map_err(|error| format!("proposal '{}': {error}", proposal.id))?;
            if value.name.trim().is_empty() {
                return Err(format!("proposal '{}' has empty domain name", proposal.id));
            }
        }
        "create_entry" => {
            let value: EntryDraft = serde_json::from_value(proposal.value.clone())
                .map_err(|error| format!("proposal '{}': {error}", proposal.id))?;
            let normalized: HashSet<_> = value.forms.iter().map(|form| nfc(form)).collect();
            if value.label.trim().is_empty()
                || value.forms.is_empty()
                || value.forms.iter().any(|form| form.trim().is_empty())
                || normalized.len() != value.forms.len()
                || !value
                    .forms
                    .iter()
                    .any(|form| nfc(form) == nfc(&value.label))
            {
                return Err(format!("proposal '{}' has invalid entry", proposal.id));
            }
        }
        "add_forms" => {
            let value: AddFormsDraft = serde_json::from_value(proposal.value.clone())
                .map_err(|error| format!("proposal '{}': {error}", proposal.id))?;
            let normalized: HashSet<_> = value.forms.iter().map(|form| nfc(form)).collect();
            if value.entry_id.trim().is_empty()
                || value.forms.is_empty()
                || value.forms.iter().any(|form| form.trim().is_empty())
                || normalized.len() != value.forms.len()
            {
                return Err(format!("proposal '{}' has invalid add_forms", proposal.id));
            }
        }
        "create_rule" => {
            let value: RuleDraft = serde_json::from_value(proposal.value.clone())
                .map_err(|error| format!("proposal '{}': {error}", proposal.id))?;
            if value.observed.trim().is_empty() || value.observed.chars().count() > 128 {
                return Err(format!(
                    "proposal '{}' has invalid observed text",
                    proposal.id
                ));
            }
            validate_draft_ref(&value.domain_ref, proposal, "domain")?;
            if matches!(value.action, RuleAction::Replace)
                && (value.target.is_none() || value.application.is_none())
            {
                return Err(format!(
                    "proposal '{}' replacement requires target/application",
                    proposal.id
                ));
            }
            if matches!(value.action, RuleAction::Preserve)
                && (value.target.is_some() || value.application.is_some())
            {
                return Err(format!(
                    "proposal '{}' preserve cannot have target/application",
                    proposal.id
                ));
            }
            if let Some(target) = &value.target {
                validate_draft_ref(&target.entry_ref, proposal, "entry")?;
                if target.text.trim().is_empty() {
                    return Err(format!("proposal '{}' has an empty target", proposal.id));
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn deterministic_dataset_conflicts(
    dataset: &Dataset,
    dictionary: Option<&Dictionary>,
) -> Result<Vec<Value>, String> {
    type RuleKey = (String, String);
    type RuleMember = (String, String, bool);
    let mut rules: BTreeMap<RuleKey, Vec<RuleMember>> = BTreeMap::new();
    if let Some(dictionary) = dictionary {
        for rule in dictionary.rules.iter().filter(|rule| rule.enabled) {
            let behavior = match rule.action {
                RuleAction::Preserve => "preserve".to_string(),
                RuleAction::Replace => {
                    let target = rule
                        .target
                        .as_ref()
                        .ok_or("replacement rule has no target")?;
                    format!(
                        "replace\0existing:{}\0{}\0{:?}",
                        target.entry_id,
                        nfc(&target.text),
                        rule.application
                    )
                }
            };
            rules
                .entry((format!("existing:{}", rule.domain_id), nfc(&rule.observed)))
                .or_default()
                .push((format!("existing:{}", rule.id), behavior, false));
        }
    }
    for proposal in dataset
        .proposals
        .iter()
        .filter(|proposal| proposal.kind == "create_rule")
    {
        let draft: RuleDraft = serde_json::from_value(proposal.value.clone())
            .map_err(|error| format!("proposal '{}': {error}", proposal.id))?;
        let domain = canonical_ref(&draft.domain_ref)?;
        let behavior = match draft.action {
            RuleAction::Preserve => "preserve".to_string(),
            RuleAction::Replace => {
                let target = draft.target.ok_or("replacement proposal has no target")?;
                if let (Some(dictionary), Some(entry_id)) =
                    (dictionary, target.entry_ref.existing_id.as_deref())
                {
                    let formal_name = dictionary
                        .entries
                        .iter()
                        .find(|entry| entry.id == entry_id)
                        .map(|entry| entry.label.as_str())
                        .ok_or_else(|| {
                            format!("proposal '{}' references an unknown entry", proposal.id)
                        })?;
                    if target.text != formal_name {
                        return Err(format!(
                            "proposal '{}' output must equal the target entry formal name",
                            proposal.id
                        ));
                    }
                }
                format!(
                    "replace\0{}\0{}\0{:?}",
                    canonical_ref(&target.entry_ref)?,
                    nfc(&target.text),
                    draft.application
                )
            }
        };
        rules
            .entry((domain, nfc(&draft.observed)))
            .or_default()
            .push((proposal.id.clone(), behavior, true));
    }
    let mut conflicts = vec![];
    for ((domain_ref, observed), members) in rules {
        let behaviors: HashSet<_> = members.iter().map(|(_, behavior, _)| behavior).collect();
        let proposal_count = members.iter().filter(|(_, _, proposed)| *proposed).count();
        if proposal_count > 0 && (behaviors.len() > 1 || proposal_count > 1) {
            conflicts.push(json!({
                "id": format!("plugin-rule-conflict-{}", storage::sha256(format!("{domain_ref}\0{observed}").as_bytes())),
                "type": if behaviors.len() > 1 { "rule_target_conflict" } else { "duplicate_rule" },
                "domain_ref": domain_ref,
                "observed": observed,
                "rule_or_proposal_ids": members.into_iter().map(|(id, _, _)| id).collect::<Vec<_>>(),
                "reason": "the plugin independently detected incompatible or duplicate behavior for the same context and observed text"
            }));
        }
    }
    Ok(conflicts)
}

fn rule_behaviors(dictionary: &Dictionary) -> BTreeMap<(String, String), HashSet<String>> {
    let mut groups: BTreeMap<(String, String), HashSet<String>> = BTreeMap::new();
    for rule in dictionary.rules.iter().filter(|rule| rule.enabled) {
        let behavior = match rule.action {
            RuleAction::Preserve => "preserve".to_string(),
            RuleAction::Replace => {
                let target = rule.target.as_ref().expect("validated replacement target");
                format!(
                    "replace\0{}\0{}\0{:?}",
                    target.entry_id,
                    nfc(&target.text),
                    rule.application
                )
            }
        };
        groups
            .entry((rule.domain_id.clone(), nfc(&rule.observed)))
            .or_default()
            .insert(behavior);
    }
    groups
}

fn newly_introduced_rule_conflicts(
    before: &Dictionary,
    after: &Dictionary,
) -> Vec<(String, String)> {
    let before = rule_behaviors(before);
    rule_behaviors(after)
        .into_iter()
        .filter_map(|(key, behaviors)| {
            (behaviors.len() > 1 && before.get(&key) != Some(&behaviors)).then_some(key)
        })
        .collect()
}

fn canonical_ref(reference: &ObjectRef) -> Result<String, String> {
    match (&reference.existing_id, &reference.proposal_id) {
        (Some(id), None) if !id.trim().is_empty() => Ok(format!("existing:{id}")),
        (None, Some(id)) if !id.trim().is_empty() => Ok(format!("proposal:{id}")),
        _ => Err("object reference must contain exactly one ID".into()),
    }
}

fn validate_draft_ref(
    reference: &ObjectRef,
    proposal: &DatasetProposal,
    object: &str,
) -> Result<(), String> {
    match (&reference.existing_id, &reference.proposal_id) {
        (Some(id), None) if !id.trim().is_empty() => Ok(()),
        (None, Some(id)) if !id.trim().is_empty() && proposal.depends_on.contains(id) => Ok(()),
        (None, Some(id)) if !id.trim().is_empty() => Err(format!(
            "proposal '{}' must declare {object} dependency '{id}'",
            proposal.id
        )),
        _ => Err(format!(
            "proposal '{}' {object} reference must contain exactly one ID",
            proposal.id
        )),
    }
}

fn visit_dependency<'a>(
    id: &'a str,
    lookup: &HashMap<&'a str, &'a DatasetProposal>,
    stack: &mut Vec<&'a str>,
    done: &mut HashSet<&'a str>,
) -> Result<(), String> {
    if done.contains(id) {
        return Ok(());
    }
    if stack.contains(&id) {
        return Err(format!("dataset dependency cycle includes '{id}'"));
    }
    stack.push(id);
    for dependency in &lookup[id].depends_on {
        visit_dependency(dependency, lookup, stack, done)?;
    }
    stack.pop();
    done.insert(id);
    Ok(())
}

fn dependency_order(
    selected: &[SelectedProposal],
    lookup: &HashMap<String, DatasetProposal>,
) -> Result<Vec<String>, String> {
    fn add(
        id: &str,
        selected: &HashSet<&str>,
        lookup: &HashMap<String, DatasetProposal>,
        visiting: &mut HashSet<String>,
        done: &mut HashSet<String>,
        out: &mut Vec<String>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.into()) {
            return Err("selected proposal dependency cycle".into());
        }
        let proposal = lookup.get(id).ok_or("selected proposal is missing")?;
        for dependency in &proposal.depends_on {
            if selected.contains(dependency.as_str()) {
                add(dependency, selected, lookup, visiting, done, out)?;
            }
        }
        visiting.remove(id);
        done.insert(id.into());
        out.push(id.into());
        Ok(())
    }
    let selected_ids: HashSet<_> = selected.iter().map(|item| item.id.as_str()).collect();
    let mut out = vec![];
    let mut done = HashSet::new();
    let mut visiting = HashSet::new();
    for item in selected {
        add(
            &item.id,
            &selected_ids,
            lookup,
            &mut visiting,
            &mut done,
            &mut out,
        )?;
    }
    Ok(out)
}

#[derive(Deserialize)]
struct DomainDraft {
    name: String,
    #[serde(default)]
    description: String,
}
#[derive(Deserialize)]
struct EntryDraft {
    kind: EntryKind,
    label: String,
    forms: Vec<String>,
    #[serde(default)]
    description: String,
}
#[derive(Deserialize)]
struct AddFormsDraft {
    entry_id: String,
    forms: Vec<String>,
}
#[derive(Deserialize)]
struct RuleDraft {
    domain_ref: ObjectRef,
    observed: String,
    action: RuleAction,
    #[serde(default)]
    target: Option<TargetDraft>,
    #[serde(default)]
    application: Option<RuleApplication>,
}
#[derive(Deserialize)]
struct ObjectRef {
    #[serde(default)]
    existing_id: Option<String>,
    #[serde(default)]
    proposal_id: Option<String>,
}
#[derive(Deserialize)]
struct TargetDraft {
    entry_ref: ObjectRef,
    text: String,
}

fn resolve_ref(
    reference: &ObjectRef,
    assigned: &BTreeMap<String, String>,
    object: &str,
) -> Result<String, String> {
    match (&reference.existing_id, &reference.proposal_id) {
        (Some(id), None) if !id.is_empty() => Ok(id.clone()),
        (None, Some(id)) => assigned
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unresolved {object} proposal '{id}'")),
        _ => Err(format!(
            "{object} reference must contain exactly one existing_id or proposal_id"
        )),
    }
}

fn apply_proposal(
    dictionary: &mut Dictionary,
    proposal: &DatasetProposal,
    value: &Value,
    assigned: &BTreeMap<String, String>,
    actor: &str,
    timestamp: &str,
) -> Result<String, String> {
    match proposal.kind.as_str() {
        "create_domain" => {
            let v: DomainDraft =
                serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            let id = format!("d_{}", Uuid::new_v4());
            dictionary.domains.push(Domain {
                id: id.clone(),
                name: v.name,
                description: v.description,
            });
            Ok(id)
        }
        "create_entry" => {
            let v: EntryDraft = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            let id = format!("e_{}", Uuid::new_v4());
            dictionary.entries.push(Entry {
                id: id.clone(),
                kind: v.kind,
                label: v.label,
                forms: v.forms,
                description: v.description,
            });
            Ok(id)
        }
        "add_forms" => {
            let v: AddFormsDraft =
                serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            let entry = dictionary
                .entries
                .iter_mut()
                .find(|e| e.id == v.entry_id)
                .ok_or("add_forms entry not found")?;
            for form in v.forms {
                if !entry.forms.iter().any(|old| nfc(old) == nfc(&form)) {
                    entry.forms.push(form);
                }
            }
            Ok(entry.id.clone())
        }
        "create_rule" => {
            let v: RuleDraft = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            let domain_id = resolve_ref(&v.domain_ref, assigned, "domain")?;
            if !dictionary.domains.iter().any(|d| d.id == domain_id) {
                return Err("rule domain not found".into());
            }
            let target = if let Some(target) = v.target {
                let entry_id = resolve_ref(&target.entry_ref, assigned, "entry")?;
                let formal_name = dictionary
                    .entries
                    .iter()
                    .find(|entry| entry.id == entry_id)
                    .map(|entry| entry.label.clone())
                    .ok_or("rule entry not found")?;
                Some(RuleTarget {
                    entry_id,
                    text: formal_name,
                })
            } else {
                None
            };
            let id = format!("r_{}", Uuid::new_v4());
            dictionary.rules.push(Rule {
                id: id.clone(),
                domain_id,
                observed: v.observed,
                action: v.action,
                target,
                application: v.application,
                enabled: true,
                confirmed_by: actor.into(),
                confirmed_at: timestamp.into(),
            });
            Ok(id)
        }
        other => Err(format!("unsupported proposal kind '{other}'")),
    }
}

fn resolve_input_path(vault: &Path, input: &str) -> Result<PathBuf, String> {
    let path = Path::new(input);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        vault.join(path)
    };
    let canonical = joined
        .canonicalize()
        .map_err(|e| format!("{}: {e}", joined.display()))?;
    let root = vault.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("input must be inside the current Vault".into());
    }
    Ok(canonical)
}

fn nfc(value: &str) -> String {
    value.nfc().collect()
}
fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn validate_vault_relative_resource(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.starts_with('/')
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("resource must be a safe Vault-relative path".into());
    }
    Ok(())
}

fn resolve_dictionary(
    dictionary: &Dictionary,
    domain_id: &str,
    text: &str,
) -> Result<ResolveResult, String> {
    let chars: Vec<char> = text.chars().collect();
    let mut matches: Vec<(usize, usize, &Rule)> = vec![];
    let mut boundary_conflicts = vec![];
    for rule in dictionary
        .rules
        .iter()
        .filter(|r| r.enabled && r.domain_id == domain_id)
    {
        let needle: Vec<char> = rule.observed.nfc().collect::<String>().chars().collect();
        if needle.is_empty() || needle.len() > chars.len() {
            continue;
        }
        let normalized = nfc(text);
        let hay: Vec<char> = normalized.chars().collect();
        if hay.len() != chars.len() {
            return Err(
                "NFC normalization changes source positions; review this occurrence manually"
                    .into(),
            );
        }
        for start in 0..=hay.len().saturating_sub(needle.len()) {
            let end = start + needle.len();
            if hay[start..end] == needle[..] {
                if boundary_ok(&hay, start, end, &needle) {
                    matches.push((start, end, rule));
                } else if matches!(rule.action, RuleAction::Replace)
                    && needle.iter().any(|character| is_cjk_ideograph(*character))
                {
                    boundary_conflicts.push(ResolveConflict {
                        span: TextSpan { start, end },
                        observed: chars[start..end].iter().collect(),
                        rule_ids: vec![rule.id.clone()],
                        reason: "unproven CJK token boundary".into(),
                    });
                }
            }
        }
    }
    let mut by_span: BTreeMap<(usize, usize), Vec<&Rule>> = BTreeMap::new();
    for (s, e, r) in matches {
        by_span.entry((s, e)).or_default().push(r);
    }
    let preserve_spans: Vec<_> = by_span
        .iter()
        .flat_map(|((start, end), rules)| {
            rules
                .iter()
                .filter(|rule| matches!(rule.action, RuleAction::Preserve))
                .map(|_| (*start, *end))
        })
        .collect();
    let mut applied = vec![];
    let mut suggestions = vec![];
    let mut conflicts = boundary_conflicts;
    let mut edits: Vec<(usize, usize, String)> = vec![];
    for ((start, end), rules) in by_span {
        if preserve_spans
            .iter()
            .any(|(preserve_start, preserve_end)| start < *preserve_end && end > *preserve_start)
        {
            continue;
        }
        let mut targets: BTreeMap<(String, String), Vec<&Rule>> = BTreeMap::new();
        for rule in rules
            .iter()
            .filter(|r| matches!(r.action, RuleAction::Replace))
        {
            let t = rule.target.as_ref().unwrap();
            targets
                .entry((t.entry_id.clone(), t.text.clone()))
                .or_default()
                .push(rule);
        }
        if targets.len() > 1 {
            conflicts.push(ResolveConflict {
                span: TextSpan { start, end },
                observed: chars[start..end].iter().collect(),
                rule_ids: rules.iter().map(|r| r.id.clone()).collect(),
                reason: "multiple confirmed targets".into(),
            });
            continue;
        }
        if let Some(((_, output), group)) = targets.into_iter().next() {
            let rule = group[0];
            let item = ResolvedMatch {
                rule_id: rule.id.clone(),
                span: TextSpan { start, end },
                observed: chars[start..end].iter().collect(),
                output: output.clone(),
            };
            if matches!(rule.application, Some(RuleApplication::Automatic)) {
                edits.push((start, end, output));
                applied.push(item);
            } else {
                suggestions.push(item);
            }
        }
    }
    edits.sort_by_key(|(s, _, _)| *s);
    for pair in edits.windows(2) {
        if pair[0].1 > pair[1].0 {
            conflicts.push(ResolveConflict {
                span: TextSpan {
                    start: pair[1].0,
                    end: pair[0].1.max(pair[1].1),
                },
                observed: chars[pair[1].0..pair[0].1.max(pair[1].1)].iter().collect(),
                rule_ids: vec![],
                reason: "overlapping replacements".into(),
            });
        }
    }
    let conflict_spans: Vec<_> = conflicts
        .iter()
        .map(|c| (c.span.start, c.span.end))
        .collect();
    edits.retain(|(s, e, _)| !conflict_spans.iter().any(|(cs, ce)| s < ce && e > cs));
    applied.retain(|item| {
        !conflict_spans
            .iter()
            .any(|(start, end)| item.span.start < *end && item.span.end > *start)
    });
    let mut preview = String::new();
    let mut cursor = 0;
    for (s, e, out) in edits {
        preview.extend(chars[cursor..s].iter());
        preview.push_str(&out);
        cursor = e;
    }
    preview.extend(chars[cursor..].iter());
    Ok(ResolveResult {
        schema: "notemd.conversation-dictionary-resolve-result.v1".into(),
        status: if conflicts.is_empty() {
            "ok"
        } else {
            "ambiguous"
        }
        .into(),
        original: text.into(),
        preview,
        dictionary_revision: dictionary.revision,
        applied,
        suggestions,
        conflicts,
    })
}

fn boundary_ok(hay: &[char], start: usize, end: usize, needle: &[char]) -> bool {
    if !needle.iter().any(|character| character.is_alphanumeric()) {
        return true;
    }
    let left = start == 0 || !hay[start - 1].is_alphanumeric();
    let right = end == hay.len() || !hay[end].is_alphanumeric();
    left && right
}

fn is_cjk_ideograph(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2EBEF
            | 0x30000..=0x323AF
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn first_open_initialization_is_idempotent_and_keeps_dictionary_empty() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("AGENTS.md"), "# Vault\n").unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());

        let first = service.ensure_initialized("human:bruce").unwrap();
        let path = storage::dictionary_path(temp.path()).unwrap();
        let first_bytes = fs::read(&path).unwrap();
        let first_dictionary = storage::verified_dictionary(temp.path()).unwrap().0;
        let mut control = storage::load_control(temp.path()).unwrap();
        assert_eq!(
            control.baseline_dictionary.as_deref().unwrap().as_bytes(),
            first_bytes
        );
        control.baseline_dictionary = None;
        storage::save_control(temp.path(), &control).unwrap();
        let second = service.ensure_initialized("human:bruce").unwrap();

        assert_eq!(first["status"], "created");
        assert_eq!(second["status"], "existing");
        assert_eq!(fs::read(path).unwrap(), first_bytes);
        let reseeded_control = storage::load_control(temp.path()).unwrap();
        assert_eq!(
            reseeded_control
                .baseline_dictionary
                .as_deref()
                .unwrap()
                .as_bytes(),
            first_bytes
        );
        assert_eq!(first_dictionary.revision, 1);
        assert!(first_dictionary.domains.is_empty());
        assert!(first_dictionary.entries.is_empty());
        assert!(first_dictionary.rules.is_empty());
        assert_eq!(
            service.bootstrap().unwrap()["agent_integration"]["status"],
            "ready"
        );
        assert_eq!(
            service.bootstrap().unwrap()["example"]["example_only"],
            true
        );
    }

    #[test]
    fn initialization_restores_a_missing_dictionary_from_the_reviewed_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.ensure_initialized("human:bruce").unwrap();
        let dictionary_path = storage::dictionary_path(temp.path()).unwrap();
        let expected = fs::read(&dictionary_path).unwrap();
        let control_before = fs::read(storage::control_path(temp.path())).unwrap();
        fs::remove_file(&dictionary_path).unwrap();

        let result = service.ensure_initialized("human:bruce").unwrap();

        assert_eq!(result["status"], "existing");
        assert_eq!(result["dictionary_created"], false);
        assert_eq!(fs::read(dictionary_path).unwrap(), expected);
        assert_eq!(
            fs::read(storage::control_path(temp.path())).unwrap(),
            control_before
        );
    }

    #[test]
    fn initialization_refuses_a_corrupt_recovery_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.ensure_initialized("human:bruce").unwrap();
        let dictionary_path = storage::dictionary_path(temp.path()).unwrap();
        fs::remove_file(&dictionary_path).unwrap();
        let mut control = storage::load_control(temp.path()).unwrap();
        control.baseline_dictionary = Some("corrupt".into());
        storage::save_control(temp.path(), &control).unwrap();

        assert!(service
            .ensure_initialized("human:bruce")
            .unwrap_err()
            .contains("does not match the reviewed baseline"));
        assert!(!dictionary_path.exists());
    }

    #[test]
    fn initialization_keeps_failing_closed_for_an_old_baseline_without_a_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.ensure_initialized("human:bruce").unwrap();
        let dictionary_path = storage::dictionary_path(temp.path()).unwrap();
        fs::remove_file(&dictionary_path).unwrap();
        let mut control = storage::load_control(temp.path()).unwrap();
        control.baseline_dictionary = None;
        storage::save_control(temp.path(), &control).unwrap();

        assert!(service
            .ensure_initialized("human:bruce")
            .unwrap_err()
            .contains("no verified recovery snapshot"));
        assert!(!dictionary_path.exists());
    }

    #[test]
    fn initialization_rejects_a_different_vault_author() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.ensure_initialized("human:bruce").unwrap();
        assert!(service
            .ensure_initialized("human:someone-else")
            .unwrap_err()
            .contains("current Vault author"));
    }

    fn dictionary() -> Dictionary {
        Dictionary {
            schema: DICTIONARY_SCHEMA.into(),
            dictionary_id: "dict_test".into(),
            revision: 1,
            updated_at: now(),
            subject_id: "human:bruce".into(),
            scope: "user_communications".into(),
            domains: vec![Domain {
                id: "d_work".into(),
                name: "工作".into(),
                description: "".into(),
            }],
            entries: vec![Entry {
                id: "e_wei".into(),
                kind: EntryKind::Person,
                label: "伟滔".into(),
                forms: vec!["伟滔".into()],
                description: "".into(),
            }],
            rules: vec![Rule {
                id: "r_wei".into(),
                domain_id: "d_work".into(),
                observed: "伟涛".into(),
                action: RuleAction::Replace,
                target: Some(RuleTarget {
                    entry_id: "e_wei".into(),
                    text: "伟滔".into(),
                }),
                application: Some(RuleApplication::Automatic),
                enabled: true,
                confirmed_by: "human:bruce".into(),
                confirmed_at: now(),
            }],
        }
    }
    #[test]
    fn continuous_chinese_requires_a_proven_boundary() {
        let d = dictionary();
        validate_dictionary(&d).unwrap();
        let r = resolve_dictionary(&d, "d_work", "请伟涛负责").unwrap();
        assert_eq!(r.preview, "请伟涛负责");
        assert!(r.applied.is_empty());
        assert_eq!(r.status, "ambiguous");
        assert_eq!(r.conflicts[0].reason, "unproven CJK token boundary");
    }
    #[test]
    fn resolves_chinese_when_punctuation_proves_the_boundary() {
        let d = dictionary();
        let r = resolve_dictionary(&d, "d_work", "请，伟涛，负责").unwrap();
        assert_eq!(r.preview, "请，伟滔，负责");
        assert_eq!(r.applied[0].span, TextSpan { start: 2, end: 4 });
    }
    #[test]
    fn latin_rule_does_not_match_inside_word() {
        let mut d = dictionary();
        d.entries[0].forms = vec!["ROC".into()];
        d.rules[0].observed = "OC".into();
        d.rules[0].target.as_mut().unwrap().text = "ROC".into();
        assert_eq!(
            resolve_dictionary(&d, "d_work", "ROCKET").unwrap().preview,
            "ROCKET"
        );
    }
    #[test]
    fn observed_longer_than_input_returns_original_without_panicking() {
        let dictionary = dictionary();
        let result = resolve_dictionary(&dictionary, "d_work", "伟").unwrap();
        assert_eq!(result.preview, "伟");
        assert!(result.applied.is_empty());
    }
    #[test]
    fn single_cjk_character_is_not_a_reusable_automatic_boundary() {
        let mut dictionary = dictionary();
        dictionary.entries[0].forms = vec!["维".into()];
        dictionary.rules[0].observed = "伟".into();
        dictionary.rules[0].target.as_mut().unwrap().text = "维".into();
        let result = resolve_dictionary(&dictionary, "d_work", "请伟负责").unwrap();
        assert_eq!(result.preview, "请伟负责");
        assert!(result.applied.is_empty());
    }
    #[test]
    fn preserve_wins() {
        let mut d = dictionary();
        d.rules.push(Rule {
            id: "r_keep".into(),
            domain_id: "d_work".into(),
            observed: "伟涛".into(),
            action: RuleAction::Preserve,
            target: None,
            application: None,
            enabled: true,
            confirmed_by: "human:bruce".into(),
            confirmed_at: now(),
        });
        assert_eq!(
            resolve_dictionary(&d, "d_work", "伟涛").unwrap().preview,
            "伟涛"
        );
    }
    #[test]
    fn overlapping_preserve_blocks_a_replacement() {
        let mut d = dictionary();
        d.entries[0].forms = vec!["beta gamma fixed".into()];
        d.rules[0].observed = "beta gamma".into();
        d.rules[0].target.as_mut().unwrap().text = "beta gamma fixed".into();
        d.rules.push(Rule {
            id: "r_keep".into(),
            domain_id: "d_work".into(),
            observed: "alpha beta".into(),
            action: RuleAction::Preserve,
            target: None,
            application: None,
            enabled: true,
            confirmed_by: "human:bruce".into(),
            confirmed_at: now(),
        });
        let result = resolve_dictionary(&d, "d_work", "alpha beta gamma").unwrap();
        assert_eq!(result.preview, "alpha beta gamma");
        assert!(result.applied.is_empty());
    }
    #[test]
    fn overlapping_replacements_are_not_reported_as_applied() {
        let mut d = dictionary();
        d.entries.push(Entry {
            id: "e_other".into(),
            kind: EntryKind::TechnicalTerm,
            label: "other".into(),
            forms: vec!["other".into()],
            description: "".into(),
        });
        d.entries[0].forms = vec!["first".into()];
        d.rules[0].observed = "alpha beta".into();
        d.rules[0].target.as_mut().unwrap().text = "first".into();
        d.rules.push(Rule {
            id: "r_other".into(),
            domain_id: "d_work".into(),
            observed: "beta gamma".into(),
            action: RuleAction::Replace,
            target: Some(RuleTarget {
                entry_id: "e_other".into(),
                text: "other".into(),
            }),
            application: Some(RuleApplication::Automatic),
            enabled: true,
            confirmed_by: "human:bruce".into(),
            confirmed_at: now(),
        });
        let result = resolve_dictionary(&d, "d_work", "alpha beta gamma").unwrap();
        assert_eq!(result.preview, "alpha beta gamma");
        assert!(result.applied.is_empty());
        assert_eq!(result.conflicts[0].reason, "overlapping replacements");
    }
    #[test]
    fn dictionary_rejects_missing_form_target() {
        let mut d = dictionary();
        d.rules[0].target.as_mut().unwrap().text = "不存在".into();
        assert!(validate_dictionary(&d)
            .unwrap_err()
            .contains("not an entry form"));
    }

    #[test]
    fn formal_name_migration_is_explicit_atomic_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.create_dictionary("human:bruce").unwrap();
        let mut legacy = dictionary();
        legacy.entries[0].label = "Bruce".into();
        legacy.entries[0].forms = vec!["伟滔".into(), "Bruce".into(), "滔哥".into()];
        legacy.rules[0].target.as_mut().unwrap().text = "伟滔".into();
        let mut control = storage::load_control(temp.path()).unwrap();
        service
            .persist_dictionary(&legacy, &mut control, None, None)
            .unwrap();

        let snapshot = service.bootstrap().unwrap();
        assert_eq!(snapshot["status"]["status"], "migration_required");
        assert_eq!(snapshot["formal_name_migration"]["required"], true);
        assert_eq!(
            snapshot["formal_name_migration"]["entries"][0]["aliases"],
            json!(["伟滔", "滔哥"])
        );
        assert!(service.list("d_work").unwrap_err().contains("formal-name"));

        let request = NormalizeFormalNamesRequest {
            transaction_id: "txn_formal_names".into(),
            expected_revision: 1,
            expected_sha256: snapshot["formal_name_migration"]["expected_sha256"]
                .as_str()
                .unwrap()
                .into(),
            formal_names: BTreeMap::from([("e_wei".into(), "伟滔".into())]),
        };
        let result = service.normalize_formal_names(request.clone()).unwrap();
        assert_eq!(result["status"], "committed");
        assert_eq!(result["revision"], 2);
        assert_eq!(result["rules_updated"], 0);
        assert_eq!(result["alias_rules_added"].as_array().unwrap().len(), 2);
        assert_eq!(
            service.normalize_formal_names(request.clone()).unwrap(),
            result
        );
        let (migrated, _) = storage::verified_dictionary(temp.path()).unwrap();
        assert_eq!(migrated.entries[0].label, "伟滔");
        assert_eq!(migrated.rules[0].target.as_ref().unwrap().text, "伟滔");
        assert!(migrated.rules.iter().any(|rule| rule.observed == "Bruce"
            && matches!(rule.application, Some(RuleApplication::Suggest))));
        assert!(migrated.rules.iter().any(|rule| rule.observed == "滔哥"
            && matches!(rule.application, Some(RuleApplication::Suggest))));
        assert!(migrated.entries[0].forms.contains(&"Bruce".to_string()));
        validate_dictionary(&migrated).unwrap();
        let dictionary_path = storage::dictionary_path(temp.path()).unwrap();
        let migrated_bytes = fs::read(&dictionary_path).unwrap();
        fs::write(
            &dictionary_path,
            [migrated_bytes.as_slice(), b"\n# external"].concat(),
        )
        .unwrap();
        assert!(service
            .normalize_formal_names(request)
            .unwrap_err()
            .contains("outside the reviewed plugin transaction"));
        fs::write(dictionary_path, migrated_bytes).unwrap();
    }

    #[test]
    fn formal_name_migration_removes_noop_rules() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.create_dictionary("human:bruce").unwrap();
        let mut legacy = dictionary();
        legacy.entries[0].label = "Bruce".into();
        legacy.entries[0].forms = vec!["Bruce".into(), "伟滔".into()];
        legacy.rules[0].observed = "Bruce".into();
        legacy.rules[0].target.as_mut().unwrap().text = "伟滔".into();
        let mut control = storage::load_control(temp.path()).unwrap();
        service
            .persist_dictionary(&legacy, &mut control, None, None)
            .unwrap();
        let snapshot = service.bootstrap().unwrap();

        let result = service
            .normalize_formal_names(NormalizeFormalNamesRequest {
                transaction_id: "txn_remove_noop".into(),
                expected_revision: 1,
                expected_sha256: snapshot["formal_name_migration"]["expected_sha256"]
                    .as_str()
                    .unwrap()
                    .into(),
                formal_names: BTreeMap::from([("e_wei".into(), "Bruce".into())]),
            })
            .unwrap();

        assert_eq!(result["rules_removed_as_noop"], json!(["r_wei"]));
        let (migrated, _) = storage::verified_dictionary(temp.path()).unwrap();
        assert!(!migrated.rules.iter().any(|rule| rule.observed == "Bruce"));
        assert!(migrated
            .rules
            .iter()
            .any(|rule| rule.observed == "伟滔" && rule.target.as_ref().unwrap().text == "Bruce"));
        validate_dictionary(&migrated).unwrap();
    }

    #[test]
    fn formal_name_migration_consolidates_rules_conservatively() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.create_dictionary("human:bruce").unwrap();
        let mut legacy = dictionary();
        legacy.entries[0].label = "Bruce".into();
        legacy.entries[0].forms = vec!["Bruce".into(), "伟滔".into(), "滔哥".into()];
        legacy.rules[0].observed = "伟涛".into();
        legacy.rules[0].target.as_mut().unwrap().text = "伟滔".into();
        legacy.rules[0].application = Some(RuleApplication::Automatic);
        legacy.rules.push(Rule {
            id: "r_duplicate".into(),
            domain_id: "d_work".into(),
            observed: "伟涛".into(),
            action: RuleAction::Replace,
            target: Some(RuleTarget {
                entry_id: "e_wei".into(),
                text: "滔哥".into(),
            }),
            application: Some(RuleApplication::Suggest),
            enabled: false,
            confirmed_by: "human:bruce".into(),
            confirmed_at: now(),
        });
        let mut control = storage::load_control(temp.path()).unwrap();
        service
            .persist_dictionary(&legacy, &mut control, None, None)
            .unwrap();
        let snapshot = service.bootstrap().unwrap();

        let result = service
            .normalize_formal_names(NormalizeFormalNamesRequest {
                transaction_id: "txn_consolidate".into(),
                expected_revision: 1,
                expected_sha256: snapshot["formal_name_migration"]["expected_sha256"]
                    .as_str()
                    .unwrap()
                    .into(),
                formal_names: BTreeMap::from([("e_wei".into(), "Bruce".into())]),
            })
            .unwrap();

        assert_eq!(result["rules_consolidated"].as_array().unwrap().len(), 1);
        let (migrated, _) = storage::verified_dictionary(temp.path()).unwrap();
        let rule = migrated
            .rules
            .iter()
            .find(|rule| rule.observed == "伟涛")
            .unwrap();
        assert_eq!(rule.id, "r_duplicate");
        assert_eq!(rule.application, Some(RuleApplication::Suggest));
        assert!(!rule.enabled);
        assert_eq!(rule.target.as_ref().unwrap().text, "Bruce");
        validate_dictionary(&migrated).unwrap();
    }

    #[test]
    fn an_existing_formal_name_can_be_changed_with_the_same_reviewed_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.create_dictionary("human:bruce").unwrap();
        let current = dictionary();
        let mut control = storage::load_control(temp.path()).unwrap();
        service
            .persist_dictionary(&current, &mut control, None, None)
            .unwrap();
        let snapshot = service.bootstrap().unwrap();
        assert_eq!(snapshot["formal_name_migration"]["required"], false);

        service
            .normalize_formal_names(NormalizeFormalNamesRequest {
                transaction_id: "txn_rename_formal".into(),
                expected_revision: 1,
                expected_sha256: snapshot["formal_name_migration"]["expected_sha256"]
                    .as_str()
                    .unwrap()
                    .into(),
                formal_names: BTreeMap::from([("e_wei".into(), "Bruce".into())]),
            })
            .unwrap();

        let (renamed, _) = storage::verified_dictionary(temp.path()).unwrap();
        assert_eq!(renamed.entries[0].label, "Bruce");
        assert!(renamed.entries[0].forms.contains(&"伟滔".to_string()));
        assert!(renamed.entries[0].forms.contains(&"Bruce".to_string()));
        assert!(renamed.rules.iter().all(|rule| rule
            .target
            .as_ref()
            .is_none_or(|target| target.text == "Bruce")));
        assert!(renamed.rules.iter().any(|rule| rule.observed == "伟滔"));
        validate_dictionary(&renamed).unwrap();
        let control = storage::load_control(temp.path()).unwrap();
        assert_eq!(
            control.baseline_dictionary.as_deref().unwrap().as_bytes(),
            fs::read(storage::dictionary_path(temp.path()).unwrap()).unwrap()
        );
    }

    #[test]
    fn new_rules_always_use_the_target_entry_formal_name() {
        let mut dictionary = dictionary();
        dictionary.entries[0].forms.push("Bruce".into());
        let proposal = DatasetProposal {
            id: "p_alias_rule".into(),
            kind: "create_rule".into(),
            depends_on: vec![],
            value: json!({
                "domain_ref":{"existing_id":"d_work"},
                "observed":"Bruce",
                "action":"replace",
                "target":{"entry_ref":{"existing_id":"e_wei"},"text":"Bruce"},
                "application":"suggest"
            }),
            evidence_ids: vec!["ev_1".into()],
            reason: String::new(),
        };
        let value = proposal.value.clone();
        apply_proposal(
            &mut dictionary,
            &proposal,
            &value,
            &BTreeMap::new(),
            "human:bruce",
            &now(),
        )
        .unwrap();
        assert_eq!(
            dictionary
                .rules
                .last()
                .unwrap()
                .target
                .as_ref()
                .unwrap()
                .text,
            "伟滔"
        );
    }

    fn dataset(subject: &str) -> Dataset {
        let run_id = Uuid::new_v4().to_string();
        Dataset {
            schema: DATASET_SCHEMA.into(),
            run_id,
            subject_id: subject.into(),
            state: DatasetState::Completed,
            base_dictionary: DatasetBase {
                state: "absent".into(),
                dictionary_id: None,
                revision: None,
                sha256: None,
            },
            coverage: Coverage {
                discovered: 1,
                processed: 1,
                excluded: 0,
                unknown_scope: 0,
                failed: 0,
                pending: 0,
                chunks_planned: 1,
                chunks_processed: 1,
            },
            evidence_file: EvidenceFile {
                path: "evidence.jsonl".into(),
                sha256: "b".repeat(64),
            },
            sources: vec![DatasetSource {
                id: "src_1".into(),
                canonical_source_id: "comm_1".into(),
                resource: "ssot/meetings/a/transcript.srt".into(),
                content_sha256: "a".repeat(64),
                status: "processed".into(),
                eligible_ranges: vec![[0, 2]],
                processed_ranges: vec![[0, 2]],
            }],
            proposals: vec![
                DatasetProposal {
                    id: "p_domain".into(),
                    kind: "create_domain".into(),
                    depends_on: vec![],
                    value: json!({"name":"产品团队","description":"产品沟通"}),
                    evidence_ids: vec![],
                    reason: "".into(),
                },
                DatasetProposal {
                    id: "p_entry".into(),
                    kind: "create_entry".into(),
                    depends_on: vec![],
                    value: json!({"kind":"person","label":"伟滔","forms":["伟滔"],"description":"团队成员"}),
                    evidence_ids: vec!["ev_1".into()],
                    reason: "".into(),
                },
                DatasetProposal {
                    id: "p_rule".into(),
                    kind: "create_rule".into(),
                    depends_on: vec!["p_domain".into(), "p_entry".into()],
                    value: json!({"domain_ref":{"proposal_id":"p_domain"},"observed":"伟涛","action":"replace","target":{"entry_ref":{"proposal_id":"p_entry"},"text":"伟滔"},"application":"automatic"}),
                    evidence_ids: vec!["ev_1".into()],
                    reason: "".into(),
                },
            ],
            conflicts: vec![],
            unresolved: vec![],
            extra: BTreeMap::new(),
        }
    }

    #[test]
    fn dataset_import_commit_restart_and_resolve_form_one_verified_slice() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.create_dictionary("human:bruce").unwrap();
        let (_, baseline) = storage::verified_dictionary(temp.path()).unwrap();
        let mut data = dataset("human:bruce");
        data.base_dictionary.state = "present".into();
        data.base_dictionary.dictionary_id = Some(baseline.dictionary_id.clone());
        data.base_dictionary.revision = Some(baseline.revision);
        data.base_dictionary.sha256 = Some(baseline.sha256.clone());
        let transcript = "伟涛负责发布。";
        let transcript_path = temp.path().join("ssot/meetings/a/transcript.srt");
        fs::create_dir_all(transcript_path.parent().unwrap()).unwrap();
        fs::write(&transcript_path, transcript).unwrap();
        data.sources[0].content_sha256 = storage::sha256(transcript.as_bytes());
        data.sources[0].eligible_ranges = vec![[0, transcript.chars().count()]];
        data.sources[0].processed_ranges = vec![[0, transcript.chars().count()]];
        let drafts = temp.path().join("ssot/meetings/drafts");
        fs::create_dir_all(&drafts).unwrap();
        let evidence = serde_json::to_string(&json!({
            "id":"ev_1","source_id":"src_1","content_sha256":data.sources[0].content_sha256,
            "subject_id":"human:bruce",
            "communication":{"user_relation":"participant","basis":{"type":"user_statement","detail":"用户确认参与"}},
            "span":{"start":0,"end":2},"observed":"伟涛","excerpt":transcript,
            "excerpt_span":{"start":0,"end":transcript.chars().count()}
        })).unwrap() + "\n";
        fs::write(drafts.join("evidence.jsonl"), &evidence).unwrap();
        data.evidence_file.sha256 = storage::sha256(evidence.as_bytes());
        let data_path = drafts.join("dataset.yml");
        fs::write(&data_path, serde_yaml::to_string(&data).unwrap()).unwrap();
        let fabricated = evidence.replace(transcript, "编造的上下文");
        fs::write(drafts.join("evidence.jsonl"), &fabricated).unwrap();
        data.evidence_file.sha256 = storage::sha256(fabricated.as_bytes());
        fs::write(&data_path, serde_yaml::to_string(&data).unwrap()).unwrap();
        assert!(service
            .dataset_check_path("ssot/meetings/drafts/dataset.yml")
            .unwrap_err()
            .contains("excerpt does not match"));
        fs::write(drafts.join("evidence.jsonl"), &evidence).unwrap();
        data.evidence_file.sha256 = storage::sha256(evidence.as_bytes());
        fs::write(&data_path, serde_yaml::to_string(&data).unwrap()).unwrap();
        let imported = service
            .dataset_import_path("ssot/meetings/drafts/dataset.yml")
            .unwrap();
        assert_eq!(imported["status"], "imported");
        assert_eq!(
            service
                .dataset_import_path("ssot/meetings/drafts/dataset.yml")
                .unwrap()["status"],
            "existing"
        );
        let evidence_view = service.batch_evidence(&data.run_id, "p_rule").unwrap();
        assert_eq!(evidence_view["evidence"][0]["excerpt"], transcript);
        assert_eq!(
            evidence_view["evidence"][0]["resource"],
            "ssot/meetings/a/transcript.srt"
        );
        fs::write(&transcript_path, "来源在分析后变化").unwrap();
        assert!(service
            .dataset_check_path("ssot/meetings/drafts/dataset.yml")
            .unwrap_err()
            .contains("changed after scan"));
        fs::write(&transcript_path, transcript).unwrap();
        let snapshot = service.bootstrap().unwrap();
        let batch = &snapshot["batches"][0];
        let dataset_hash = batch["dataset_sha256"].as_str().unwrap().to_string();
        let selected = data
            .proposals
            .iter()
            .map(|proposal| SelectedProposal {
                id: proposal.id.clone(),
                review_revision: 1,
                value: None,
            })
            .collect();
        let request = BatchCommitRequest {
            run_id: data.run_id.clone(),
            dataset_sha256: dataset_hash,
            transaction_id: "txn_1".into(),
            expected_dictionary_revision: snapshot["dictionary"]["revision"].as_u64().unwrap(),
            expected_dictionary_sha256: snapshot["formal_name_migration"]["expected_sha256"]
                .as_str()
                .unwrap()
                .into(),
            selected,
        };
        let (mut changed_dictionary, _) = storage::verified_dictionary(temp.path()).unwrap();
        changed_dictionary.revision += 1;
        let mut changed_control = storage::load_control(temp.path()).unwrap();
        service
            .persist_dictionary(&changed_dictionary, &mut changed_control, None, None)
            .unwrap();
        assert!(service
            .batch_commit(request.clone())
            .unwrap_err()
            .contains("refresh the review"));
        changed_dictionary.revision -= 1;
        service
            .persist_dictionary(&changed_dictionary, &mut changed_control, None, None)
            .unwrap();
        let mut control = storage::load_control(temp.path()).unwrap();
        control.batches[0]
            .dataset
            .conflicts
            .push(json!({"id":"conflict_1"}));
        storage::save_control(temp.path(), &control).unwrap();
        assert!(service
            .batch_commit(request.clone())
            .unwrap_err()
            .contains("unresolved conflicts"));
        control.batches[0].dataset.conflicts.clear();
        storage::save_control(temp.path(), &control).unwrap();
        fs::write(&transcript_path, "来源在批准前变化").unwrap();
        assert!(service
            .batch_commit(request.clone())
            .unwrap_err()
            .contains("changed after scan"));
        fs::write(&transcript_path, transcript).unwrap();
        let commit = service.batch_commit(request.clone()).unwrap();
        assert_eq!(commit["revision"], 2);
        assert_eq!(service.batch_commit(request.clone()).unwrap(), commit);
        let dictionary_path = storage::dictionary_path(temp.path()).unwrap();
        let committed_bytes = fs::read(&dictionary_path).unwrap();
        let committed_control = storage::load_control(temp.path()).unwrap();
        assert_eq!(
            committed_control
                .baseline_dictionary
                .as_deref()
                .unwrap()
                .as_bytes(),
            committed_bytes
        );
        fs::write(
            &dictionary_path,
            [committed_bytes.as_slice(), b"\n# external"].concat(),
        )
        .unwrap();
        assert!(service
            .batch_commit(request.clone())
            .unwrap_err()
            .contains("outside the reviewed plugin transaction"));
        fs::write(&dictionary_path, committed_bytes).unwrap();
        let reuse = service.batch_commit(BatchCommitRequest {
            run_id: data.run_id,
            dataset_sha256: batch["dataset_sha256"].as_str().unwrap().into(),
            transaction_id: "txn_1".into(),
            expected_dictionary_revision: 1,
            expected_dictionary_sha256: snapshot["formal_name_migration"]["expected_sha256"]
                .as_str()
                .unwrap()
                .into(),
            selected: vec![SelectedProposal {
                id: "p_entry".into(),
                review_revision: 1,
                value: None,
            }],
        });
        assert!(reuse.unwrap_err().contains("another plan"));
        let restarted = DictionaryService::new(temp.path().to_path_buf());
        let (dictionary, _) = storage::verified_dictionary(temp.path()).unwrap();
        let domain_id = dictionary.domains[0].id.clone();
        let text = "请，伟涛，负责";
        let resolved = restarted
            .resolve(ResolveRequest {
                context: SourceContext {
                    subject_id: "human:bruce".into(),
                    communication: CommunicationContext {
                        kind: CommunicationKind::Meeting,
                        user_relation: UserRelation::Participant,
                        basis: ScopeBasis {
                            kind: ScopeBasisKind::UserStatement,
                            detail: "用户说明自己参加".into(),
                            resource: None,
                            resource_sha256: None,
                        },
                        id: Some("comm_1".into()),
                    },
                    source: Some(SourceRef {
                        resource: None,
                        content_kind: ContentKind::AsrTranscript,
                        content_sha256: storage::sha256(text.as_bytes()),
                        span: TextSpan {
                            start: 0,
                            end: text.chars().count(),
                        },
                        distribution: None,
                    }),
                },
                domain_id,
                text: text.into(),
            })
            .unwrap();
        assert_eq!(resolved.preview, "请，伟滔，负责");
        assert_eq!(resolved.dictionary_revision, 2);
    }

    #[test]
    fn external_dictionary_edit_fails_closed_and_consumer_never_resolves() {
        let temp = tempfile::tempdir().unwrap();
        let service = DictionaryService::new(temp.path().to_path_buf());
        service.create_dictionary("human:bruce").unwrap();
        let path = storage::dictionary_path(temp.path()).unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "# external edit").unwrap();
        assert!(storage::verified_dictionary(temp.path())
            .unwrap_err()
            .contains("changed outside"));
        let context = SourceContext {
            subject_id: "human:bruce".into(),
            communication: CommunicationContext {
                kind: CommunicationKind::Conversation,
                user_relation: UserRelation::Consumer,
                basis: ScopeBasis {
                    kind: ScopeBasisKind::UserStatement,
                    detail: "只收听节目".into(),
                    resource: None,
                    resource_sha256: None,
                },
                id: None,
            },
            source: None,
        };
        assert!(validate_scope(temp.path(), &context, "human:bruce")
            .unwrap_err()
            .starts_with("out_of_scope"));
    }

    #[test]
    fn dataset_rejects_unknown_proposals_and_approval_injection() {
        let mut data = dataset("human:bruce");
        data.proposals[0].kind = "merge_entries".into();
        assert!(validate_dataset(&data)
            .unwrap_err()
            .contains("unsupported proposal kind"));
        let mut data = dataset("human:bruce");
        data.proposals[0].value["confirmed_by"] = json!("human:agent");
        assert!(validate_dataset(&data)
            .unwrap_err()
            .contains("inject approval"));
        let mut data = dataset("human:bruce");
        data.proposals[2].evidence_ids.clear();
        assert!(validate_dataset(&data)
            .unwrap_err()
            .contains("requires verified communication evidence"));
        let mut data = dataset("human:bruce");
        data.proposals[1].value["forms"] = json!(["伟滔", "Bruce"]);
        data.proposals[2].value["target"]["text"] = json!("Bruce");
        assert!(validate_dataset(&data).unwrap_err().contains("formal name"));
    }

    #[test]
    fn plugin_recomputes_deterministic_rule_conflicts() {
        let mut data = dataset("human:bruce");
        let mut conflicting = data.proposals[2].clone();
        conflicting.id = "p_rule_other".into();
        conflicting.value["target"]["text"] = json!("另一写法");
        data.proposals.push(conflicting);
        let conflicts = deterministic_dataset_conflicts(&data, None).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0]["type"], "rule_target_conflict");
    }

    #[test]
    fn final_edited_plan_rechecks_rule_conflicts() {
        let before = dictionary();
        let mut after = before.clone();
        after.entries.push(Entry {
            id: "e_other".into(),
            kind: EntryKind::Person,
            label: "另一人".into(),
            forms: vec!["另一人".into()],
            description: "".into(),
        });
        after.rules.push(Rule {
            id: "r_other".into(),
            domain_id: "d_work".into(),
            observed: "伟涛".into(),
            action: RuleAction::Replace,
            target: Some(RuleTarget {
                entry_id: "e_other".into(),
                text: "另一人".into(),
            }),
            application: Some(RuleApplication::Suggest),
            enabled: true,
            confirmed_by: "human:bruce".into(),
            confirmed_at: now(),
        });
        assert_eq!(
            newly_introduced_rule_conflicts(&before, &after),
            vec![("d_work".into(), "伟涛".into())]
        );
    }

    #[test]
    fn candidate_source_is_bound_to_the_current_asr_file() {
        let temp = tempfile::tempdir().unwrap();
        let resource = temp.path().join("transcript.txt");
        let content = "说伟涛";
        fs::write(&resource, content).unwrap();
        let proposal = ProposalInput {
            schema: "notemd.conversation-dictionary-proposal.v1".into(),
            observed: "伟涛".into(),
            domain_id: "d_work".into(),
            context: SourceContext {
                subject_id: "human:bruce".into(),
                communication: CommunicationContext {
                    kind: CommunicationKind::Meeting,
                    user_relation: UserRelation::Participant,
                    basis: ScopeBasis {
                        kind: ScopeBasisKind::UserStatement,
                        detail: "用户确认参加会议".into(),
                        resource: None,
                        resource_sha256: None,
                    },
                    id: Some("comm_1".into()),
                },
                source: None,
            },
            source: Some(CandidateSource {
                resource: Some("transcript.txt".into()),
                content_kind: ContentKind::AsrTranscript,
                content_sha256: storage::sha256(content.as_bytes()),
                span: TextSpan { start: 1, end: 3 },
                excerpt: content.into(),
                excerpt_span: TextSpan {
                    start: 0,
                    end: content.chars().count(),
                },
                distribution: None,
                locator: None,
            }),
            candidates: vec![],
            proposed_by: "agent:test".into(),
        };
        validate_proposal(temp.path(), &proposal).unwrap();
        fs::write(&resource, "来源变化").unwrap();
        assert!(validate_proposal(temp.path(), &proposal)
            .unwrap_err()
            .contains("changed"));
        let mut missing = proposal;
        missing.source = None;
        assert!(validate_proposal(temp.path(), &missing)
            .unwrap_err()
            .contains("required"));
    }
}
