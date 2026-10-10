use super::model::*;
use super::reducer::{reduce, ReducerError};
use super::repository::{RepositoryError, RepositorySnapshot, V2Repository};
use super::writer::RepositoryWriter;
use chrono::{DateTime, SecondsFormat, SubsecRound, Utc};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tempfile::NamedTempFile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionBundle {
    pub user: String,
    pub memory: String,
}

pub fn project(
    repository: &RepositorySnapshot,
    snapshot: &MemorySnapshotV2,
) -> Result<ProjectionBundle, ReducerError> {
    if snapshot.protocol.conflict || snapshot.protocol.heads.len() != 1 {
        return Err(ReducerError {
            code: "MEMORY_AUTHORITY_CONFLICT",
            message: "protocol projection is not uniquely reducible".into(),
        });
    }
    let protocol = repository
        .protocols
        .iter()
        .find(|revision| {
            revision.value.revision_id == snapshot.protocol.heads[0].revision_id
                && revision.value.payload_sha256 == snapshot.protocol.heads[0].payload_sha256
        })
        .ok_or_else(|| ReducerError {
            code: "MEMORY_PROTOCOL_UNSUPPORTED",
            message: "current protocol payload is missing".into(),
        })?;
    let mut views = snapshot
        .claims
        .iter()
        .filter(|claim| claim.projection_eligible)
        .collect::<Vec<_>>();
    views.sort_by(|left, right| {
        salience_rank(left.salience)
            .cmp(&salience_rank(right.salience))
            .then_with(|| kind_rank(left.claim_kind).cmp(&kind_rank(right.claim_kind)))
            .then_with(|| left.claim_id.cmp(&right.claim_id))
    });
    let action_sensitive_conflict = snapshot.claims.iter().any(|claim| {
        claim
            .conflict
            .as_ref()
            .is_some_and(|conflict| conflict.risk_class == RiskClass::ActionSensitive)
    });
    let revisions = repository
        .claims
        .iter()
        .map(|item| (item.value.revision_id.as_str(), &item.value))
        .collect::<HashMap<_, _>>();
    let mut entries = Vec::with_capacity(views.len());
    for view in views {
        if view.current_heads.len() != 1 {
            continue;
        }
        let revision = revisions
            .get(view.current_heads[0].revision_id.as_str())
            .copied()
            .ok_or_else(|| ReducerError {
                code: "MEMORY_INVALID_DAG",
                message: format!("missing projection head for {}", view.claim_id),
            })?;
        entries.push((view, revision));
    }
    let registry = super::reducer::context_registry_head(repository)?
        .and_then(|head| {
            repository.context_registries.iter().find(|item| {
                item.value.revision_id == head.revision_id
                    && item.value.payload_sha256 == head.payload_sha256
            })
        })
        .map(|item| &item.value);
    let user_categories = protocol
        .value
        .category_registry
        .get("user")
        .cloned()
        .unwrap_or_default();
    let memory_categories = protocol
        .value
        .category_registry
        .get("memory")
        .cloned()
        .unwrap_or_default();
    Ok(ProjectionBundle {
        user: render_projection(
            "USER",
            ProjectionTarget::User,
            user_categories,
            &entries,
            registry,
            action_sensitive_conflict,
        ),
        memory: render_projection(
            "MEMORY",
            ProjectionTarget::Memory,
            memory_categories,
            &entries,
            registry,
            action_sensitive_conflict,
        ),
    })
}

pub fn select_context(
    repository: &RepositorySnapshot,
    request: ContextRequest,
) -> Result<MemoryContextV2, ReducerError> {
    let snapshot = reduce(
        repository,
        &SnapshotRequest {
            as_of_valid_time: request.as_of_valid_time.clone(),
            role: request.role.clone(),
            space: Some(request.space.clone()),
            purpose: Some(request.purpose.clone()),
        },
    )?;
    let revisions = repository
        .claims
        .iter()
        .map(|revision| (revision.value.revision_id.as_str(), &revision.value))
        .collect::<HashMap<_, _>>();
    let mut claims = Vec::new();
    for view in &snapshot.claims {
        if !view.context_eligible || view.current_heads.len() != 1 {
            continue;
        }
        let revision = revisions
            .get(view.current_heads[0].revision_id.as_str())
            .ok_or_else(|| ReducerError {
                code: "MEMORY_INVALID_DAG",
                message: format!("missing context head for {}", view.claim_id),
            })?;
        if revision.projection.visibility == Visibility::UiOnly
            || revision.consent.scope != "personal-assistant-only"
        {
            continue;
        }
        if request.external_transfer
            && revision.consent.external_provider_policy != ExternalProviderPolicy::Allow
        {
            continue;
        }
        claims.push(ContextClaim {
            claim_id: revision.claim_id.clone(),
            revision_id: revision.revision_id.clone(),
            payload_sha256: revision.payload_sha256.clone(),
            text: revision.text.clone(),
            claim_kind: revision.claim_kind,
            risk_class: revision.risk_class,
            do_not_rely: view.do_not_rely,
            guidance: revision.agent_use.guidance.clone(),
            avoid_error: revision.agent_use.avoid_error.clone(),
        });
    }
    claims.sort_by(|left, right| left.claim_id.cmp(&right.claim_id));
    let conflicts = snapshot
        .claims
        .iter()
        .filter_map(|claim| claim.conflict.as_ref())
        .filter(|conflict| {
            conflict.heads.iter().any(|head| {
                revisions
                    .get(head.revision_id.as_str())
                    .is_some_and(|revision| context_scope_matches(revision, &request))
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    let action_sensitive_conflict = conflicts
        .iter()
        .any(|conflict| conflict.risk_class == RiskClass::ActionSensitive);
    Ok(MemoryContextV2 {
        request,
        action_allowed: snapshot.protocol.writable
            && snapshot.authority.action_allowed
            && !action_sensitive_conflict,
        claims,
        conflicts,
    })
}

fn context_scope_matches(revision: &MemoryClaimRevision, request: &ContextRequest) -> bool {
    revision.projection.visibility != Visibility::UiOnly
        && revision.consent.scope == "personal-assistant-only"
        && match &request.role {
            Some(role) => revision.context.roles.contains(role),
            None => revision.context.roles.is_empty(),
        }
        && revision.context.spaces.contains(&request.space)
        && revision.consent.allowed_purposes.contains(&request.purpose)
}

pub fn rebuild_projections(root: &Path) -> Result<ProjectionBundle, String> {
    let writer = RepositoryWriter::new(root);
    let _transaction = writer.begin().map_err(|error| error.to_string())?;
    rebuild_projections_unlocked(root)
}

pub(crate) fn rebuild_projections_unlocked(root: &Path) -> Result<ProjectionBundle, String> {
    let repository = V2Repository::new(root).load().map_err(repository_error)?;
    let bundle = projection_bundle(&repository, Utc::now())?;
    write_bundle(root, &bundle)?;
    Ok(bundle)
}

// One active Vault is enough for the sync loop; temporary remote-validation
// worktrees can evict it without retaining their paths or personal data forever.
static SYNC_PROJECTION: OnceLock<Mutex<Option<CachedProjection>>> = OnceLock::new();

struct CachedProjection {
    root: PathBuf,
    fingerprint: String,
    valid_from: Option<DateTime<Utc>>,
    valid_until: Option<DateTime<Utc>>,
    bundle: ProjectionBundle,
}

impl CachedProjection {
    fn matches(&self, root: &Path, fingerprint: &str, at: DateTime<Utc>) -> bool {
        self.root == root
            && self.fingerprint == fingerprint
            && self.valid_from.is_none_or(|from| from <= at)
            && self.valid_until.is_none_or(|until| at < until)
    }
}

pub(crate) fn reconcile_projections_unlocked(
    root: &Path,
    repository: &RepositorySnapshot,
) -> Result<ProjectionBundle, String> {
    let mut cache = SYNC_PROJECTION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "MEMORY_CACHE_LOCK: sync projection cache poisoned".to_string())?;
    reconcile_with_cache(root, repository, Utc::now(), &mut cache)
}

fn reconcile_with_cache(
    root: &Path,
    repository: &RepositorySnapshot,
    at: DateTime<Utc>,
    cache: &mut Option<CachedProjection>,
) -> Result<ProjectionBundle, String> {
    // Match the reducer's existing whole-second request precision.
    let at = at.trunc_subsecs(0);
    // load() has already checked the immutable records on every sync. Hash
    // their exact bytes, not Git HEAD/status, so uncommitted edits invalidate.
    let hashes = repository
        .protocols
        .iter()
        .map(|item| &item.raw_sha256)
        .chain(repository.authorities.iter().map(|item| &item.raw_sha256))
        .chain(
            repository
                .context_registries
                .iter()
                .map(|item| &item.raw_sha256),
        )
        .chain(repository.claims.iter().map(|item| &item.raw_sha256))
        .chain(repository.operations.iter().map(|item| &item.raw_sha256))
        .chain(
            repository
                .context_manifests
                .iter()
                .map(|item| &item.raw_sha256),
        )
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&(&repository.bootstrap, hashes))
        .map_err(|error| format!("MEMORY_SERIALIZATION: {error}"))?;
    let fingerprint = super::canonical::raw_sha256(&bytes);
    if let Some(cached) = cache
        .as_ref()
        .filter(|cached| cached.matches(root, &fingerprint, at))
    {
        // Restore missing/drifted projections without recalculating unchanged
        // claims. Identical files do not generate any filesystem events.
        write_bundle(root, &cached.bundle)?;
        return Ok(cached.bundle.clone());
    }

    let bundle = projection_bundle(repository, at)?;
    let mut valid_from = None;
    let mut valid_until = None;
    // Include every revision, including future ones, and both bounds so clock
    // rollback also invalidates the cache. The reducer validates these dates.
    for claim in &repository.claims {
        for boundary in [
            &claim.value.temporal.valid_from,
            &claim.value.temporal.valid_until,
            &claim.value.temporal.review_after,
        ]
        .into_iter()
        .flatten()
        {
            let boundary = DateTime::parse_from_rfc3339(boundary)
                .map_err(|error| format!("MEMORY_INVALID_TIME: {error}"))?
                .with_timezone(&Utc);
            if boundary <= at {
                valid_from =
                    Some(valid_from.map_or(boundary, |from: DateTime<Utc>| from.max(boundary)));
            } else {
                valid_until =
                    Some(valid_until.map_or(boundary, |until: DateTime<Utc>| until.min(boundary)));
            }
        }
    }
    write_bundle(root, &bundle)?;
    *cache = Some(CachedProjection {
        root: root.to_path_buf(),
        fingerprint,
        valid_from,
        valid_until,
        bundle: bundle.clone(),
    });
    Ok(bundle)
}

fn projection_bundle(
    repository: &RepositorySnapshot,
    at: DateTime<Utc>,
) -> Result<ProjectionBundle, String> {
    if repository.mode != RepositoryMode::V2Active {
        return Err(format!("MEMORY_PROTOCOL_NOT_ACTIVE: {:?}", repository.mode));
    }
    let as_of = at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let snapshot = reduce(
        repository,
        &SnapshotRequest {
            as_of_valid_time: as_of,
            role: None,
            space: None,
            purpose: None,
        },
    )
    .map_err(|error| error.to_string())?;
    project(repository, &snapshot).map_err(|error| error.to_string())
}

fn write_bundle(root: &Path, bundle: &ProjectionBundle) -> Result<(), String> {
    atomic_replace(root, &root.join("USER.md"), &bundle.user)?;
    atomic_replace(root, &root.join("MEMORY.md"), &bundle.memory)?;
    Ok(())
}

fn repository_error(error: RepositoryError) -> String {
    error.to_string()
}

fn render_projection(
    title: &str,
    target: ProjectionTarget,
    registry: Vec<String>,
    claims: &[(&ClaimView, &MemoryClaimRevision)],
    context_registry: Option<&ContextRegistryRevision>,
    action_sensitive_conflict: bool,
) -> String {
    let mut grouped = BTreeMap::<(String, String, String), Vec<&ClaimView>>::new();
    for (claim, revision) in claims {
        let Some(projection) = &claim.projection else {
            continue;
        };
        if projection.target != target {
            continue;
        }
        let roles = if revision.context.roles.is_empty() {
            vec!["role:unclassified".to_string()]
        } else {
            revision.context.roles.clone()
        };
        for scope in &revision.context.spaces {
            for role in &roles {
                grouped
                    .entry((scope.clone(), role.clone(), projection.category.clone()))
                    .or_default()
                    .push(*claim);
            }
        }
    }
    let role_map = context_registry
        .map(|value| {
            value
                .roles
                .iter()
                .map(|role| (role.role_id.as_str(), role))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let scope_map = context_registry
        .map(|value| {
            value
                .scopes
                .iter()
                .map(|scope| (scope.scope_id.as_str(), scope))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let mut out = format!(
        "# {title}\n\n> Agent 使用规则：这是由结构化 Claim 生成的人类可读投影，不代表所有分组都可用于当前任务。\n> 必须先通过 Memory context broker 确认当前 Role、Scope 与用途，只加载匹配切片；不要跨分组推断或混用事实。\n"
    );
    if action_sensitive_conflict {
        out.push_str("\n> 存在未解决的权限或边界冲突，相关行动已暂停。\n");
    }
    let mut scopes = grouped
        .keys()
        .map(|(scope, _, _)| scope.clone())
        .collect::<Vec<_>>();
    scopes.sort_by_key(|id| {
        scope_map
            .get(id.as_str())
            .map(|scope| scope.display_name.to_lowercase())
            .unwrap_or_else(|| id.to_lowercase())
    });
    scopes.dedup();
    for scope_id in scopes {
        let scope = scope_map.get(scope_id.as_str()).copied();
        let scope_label = scope
            .map(|value| value.display_name.as_str())
            .unwrap_or(scope_id.as_str());
        out.push_str(&format!(
            "\n## Scope · {}\n\n<!-- memory:scope {} -->\n",
            escape_heading(scope_label),
            escape_comment(&scope_id)
        ));
        if let Some(scope) = scope {
            append_guidance(&mut out, "Scope", &scope.agent_use);
        }
        let mut roles = grouped
            .keys()
            .filter(|(scope, _, _)| scope == &scope_id)
            .map(|(_, role, _)| role.clone())
            .collect::<Vec<_>>();
        roles.sort_by_key(|id| {
            role_map
                .get(id.as_str())
                .map(|role| role.display_name.to_lowercase())
                .unwrap_or_else(|| id.to_lowercase())
        });
        roles.dedup();
        for role_id in roles {
            let role = role_map.get(role_id.as_str()).copied();
            let role_label = role
                .map(|value| value.display_name.as_str())
                .unwrap_or(role_id.as_str());
            out.push_str(&format!(
                "\n### Role · {}\n\n<!-- memory:role {} -->\n",
                escape_heading(role_label),
                escape_comment(&role_id)
            ));
            if let Some(role) = role {
                append_guidance(&mut out, "Role", &role.agent_use);
            }
            let mut categories = registry
                .iter()
                .filter(|category| {
                    grouped.contains_key(&(scope_id.clone(), role_id.clone(), (*category).clone()))
                })
                .cloned()
                .collect::<Vec<_>>();
            for (scope, role, category) in grouped.keys() {
                if scope == &scope_id && role == &role_id && !categories.contains(category) {
                    categories.push(category.clone());
                }
            }
            for category in categories {
                let Some(entries) =
                    grouped.get(&(scope_id.clone(), role_id.clone(), category.clone()))
                else {
                    continue;
                };
                out.push_str(&format!("\n#### {}\n", escape_heading(&category)));
                for entry in entries {
                    let Some(text) = &entry.text else {
                        continue;
                    };
                    out.push('\n');
                    for (index, line) in text.lines().enumerate() {
                        let line = escape_continuation(line);
                        if index == 0 {
                            out.push_str("- ");
                        } else {
                            out.push_str("  ");
                        }
                        out.push_str(&line);
                        out.push('\n');
                    }
                }
            }
        }
    }
    out
}

fn append_guidance(out: &mut String, label: &str, use_policy: &AgentUse) {
    if !use_policy.guidance.trim().is_empty() {
        out.push_str(&format!(
            "\n> {label} 指引：{}\n",
            use_policy.guidance.trim().replace('\n', " ")
        ));
    }
    if !use_policy.avoid_error.trim().is_empty() {
        out.push_str(&format!(
            "> 避免：{}\n",
            use_policy.avoid_error.trim().replace('\n', " ")
        ));
    }
}

fn escape_heading(value: &str) -> String {
    value.trim().replace(['\r', '\n'], " ").replace('#', "\\#")
}

fn escape_comment(value: &str) -> String {
    value.replace("--", "—").replace(['<', '>'], "")
}

fn escape_continuation(line: &str) -> String {
    let trimmed = line.trim_start();
    let structural = ["#", "- ", "+ ", "* ", ">", "`", "---"]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix));
    if structural {
        format!("\\{line}")
    } else {
        line.to_string()
    }
}

fn salience_rank(value: Option<Salience>) -> u8 {
    match value {
        Some(Salience::Pinned) => 0,
        _ => 1,
    }
}

fn kind_rank(value: Option<ClaimKind>) -> u8 {
    match value {
        Some(ClaimKind::Identity) => 0,
        Some(ClaimKind::Preference) => 1,
        Some(ClaimKind::Boundary) => 2,
        Some(ClaimKind::Decision) => 3,
        Some(ClaimKind::Belief) => 4,
        Some(ClaimKind::Observation) => 5,
        Some(ClaimKind::Commitment) => 6,
        Some(ClaimKind::Practice) => 7,
        Some(ClaimKind::MaterialFact) => 8,
        Some(ClaimKind::Quotation) => 9,
        _ => 10,
    }
}

fn atomic_replace(root: &Path, path: &Path, content: &str) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
        && fs::read(path).is_ok_and(|existing| existing == content.as_bytes())
    {
        return Ok(());
    }
    let tmp_dir = root.join(".notemd/memory/.local/tmp");
    fs::create_dir_all(&tmp_dir).map_err(|error| format!("MEMORY_IO: {error}"))?;
    let mut temp = NamedTempFile::new_in(tmp_dir).map_err(|error| format!("MEMORY_IO: {error}"))?;
    temp.write_all(content.as_bytes())
        .map_err(|error| format!("MEMORY_IO: {error}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| format!("MEMORY_IO: {error}"))?;
    temp.persist(path)
        .map_err(|error| format!("MEMORY_IO: {}", error.error))?;
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialized_repository() -> (tempfile::TempDir, RepositorySnapshot) {
        let dir = tempfile::tempdir().unwrap();
        super::super::service::dispatch(
            dir.path(),
            "host.memory.v2.initialize",
            &serde_json::json!({}),
        )
        .unwrap();
        let repository = V2Repository::new(dir.path()).load().unwrap();
        (dir, repository)
    }

    fn add_claim(root: &Path, repository: &RepositorySnapshot) {
        let protocol = &repository.protocols[0].value;
        let owner = &repository.authorities[0].value.owner.owner_id;
        super::super::service::dispatch(
            root,
            "host.memory.v2.add",
            &serde_json::json!({
                "request_id": "projection-cache/add", "expected_protocol": {
                    "revision_id": protocol.revision_id, "payload_sha256": protocol.payload_sha256,
                },
                "target": "user", "category": "preferences", "text": "缓存测试偏好。",
                "claim_kind": "preference", "subject": {
                    "kind": "vault-owner", "id": owner, "relation_to_owner": "self",
                },
                "approval_kind": "self-representation", "trust_tier": "stable-preference",
                "risk_class": "informational", "salience": "normal", "polarity": "positive",
                "sensitivity": "normal", "context": {
                    "spaces": ["global"], "applies_when": [], "excludes_when": [],
                },
                "consent": {"scope": "personal-assistant-only", "allowed_purposes": ["planning"],
                    "external_provider_policy": "deny"},
                "agent_use": {"guidance": "", "avoid_error": ""},
            }),
        )
        .unwrap();
    }

    #[test]
    fn unchanged_sync_reuses_projection_and_repairs_missing_or_drifted_files() {
        let (dir, repository) = initialized_repository();
        let at = Utc::now();
        let mut cache = None;
        let expected = reconcile_with_cache(dir.path(), &repository, at, &mut cache).unwrap();
        let rendered = cache.as_ref().unwrap().bundle.user.as_ptr();
        let before = fs::metadata(dir.path().join("USER.md"))
            .unwrap()
            .modified()
            .unwrap();
        for seconds in [1, 30, 300] {
            reconcile_with_cache(
                dir.path(),
                &repository,
                at + chrono::Duration::seconds(seconds),
                &mut cache,
            )
            .unwrap();
            assert_eq!(rendered, cache.as_ref().unwrap().bundle.user.as_ptr());
            assert_eq!(
                before,
                fs::metadata(dir.path().join("USER.md"))
                    .unwrap()
                    .modified()
                    .unwrap()
            );
        }
        fs::write(dir.path().join("USER.md"), "external drift").unwrap();
        fs::remove_file(dir.path().join("MEMORY.md")).unwrap();
        let restored = reconcile_with_cache(dir.path(), &repository, at, &mut cache).unwrap();
        assert_eq!(rendered, cache.as_ref().unwrap().bundle.user.as_ptr());
        assert_eq!(restored, expected);
        assert_eq!(
            fs::read_to_string(dir.path().join("USER.md")).unwrap(),
            expected.user
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("MEMORY.md")).unwrap(),
            expected.memory
        );
    }

    #[test]
    fn source_changes_invalidate_sync_projection() {
        let (dir, repository) = initialized_repository();
        let at = Utc::now();
        let mut cache = None;
        reconcile_with_cache(dir.path(), &repository, at, &mut cache).unwrap();
        let fingerprint = cache.as_ref().unwrap().fingerprint.clone();
        add_claim(dir.path(), &repository);
        let updated = V2Repository::new(dir.path()).load().unwrap();
        let projected = reconcile_with_cache(dir.path(), &updated, at, &mut cache).unwrap();
        assert_ne!(fingerprint, cache.as_ref().unwrap().fingerprint);
        assert!(projected.user.contains("缓存测试偏好。"));

        // Control-plane bytes and bootstrap also invalidate, even if their
        // rendered text happens to stay the same.
        for collection in ["protocol", "authority", "registry", "bootstrap"] {
            let previous = cache.as_ref().unwrap().fingerprint.clone();
            let mut changed = updated.clone();
            match collection {
                "protocol" => changed.protocols[0].raw_sha256.push('x'),
                "authority" => changed.authorities[0].raw_sha256.push('x'),
                "registry" => changed.context_registries[0].raw_sha256.push('x'),
                _ => changed.bootstrap.as_mut().unwrap().vault_id.push('x'),
            }
            let result = reconcile_with_cache(dir.path(), &changed, at, &mut cache);
            match result {
                Ok(_) => assert_ne!(previous, cache.as_ref().unwrap().fingerprint),
                // A referenced causal parent's changed hash must reach DAG
                // validation rather than reuse the previously valid cache.
                Err(error) => assert!(error.contains("MEMORY_INVALID_DAG"), "{error}"),
            }
        }
    }

    #[test]
    fn temporal_boundaries_and_clock_rollback_invalidate_sync_projection() {
        let (dir, repository) = initialized_repository();
        add_claim(dir.path(), &repository);
        let repository = V2Repository::new(dir.path()).load().unwrap();
        let boundary = Utc::now().trunc_subsecs(0) + chrono::Duration::days(1);
        for field in ["valid_from", "valid_until", "review_after"] {
            let mut repository = repository.clone();
            let temporal = &mut repository.claims[0].value.temporal;
            let date = Some(boundary.to_rfc3339());
            match field {
                "valid_from" => temporal.valid_from = date,
                "valid_until" => temporal.valid_until = date,
                _ => temporal.review_after = date,
            }
            let mut cache = None;
            let before = reconcile_with_cache(
                dir.path(),
                &repository,
                boundary - chrono::Duration::seconds(1),
                &mut cache,
            )
            .unwrap();
            let rendered = cache.as_ref().unwrap().bundle.user.as_ptr();
            let after =
                reconcile_with_cache(dir.path(), &repository, boundary, &mut cache).unwrap();
            assert_ne!(
                rendered,
                cache.as_ref().unwrap().bundle.user.as_ptr(),
                "{field}"
            );
            assert_ne!(before.user, after.user, "{field}");
            let rolled_back = reconcile_with_cache(
                dir.path(),
                &repository,
                boundary - chrono::Duration::seconds(1),
                &mut cache,
            )
            .unwrap();
            assert_eq!(rolled_back, before, "{field}");
        }
    }

    #[test]
    fn fractional_boundary_keeps_the_reducers_whole_second_precision() {
        let (dir, repository) = initialized_repository();
        add_claim(dir.path(), &repository);
        let mut repository = V2Repository::new(dir.path()).load().unwrap();
        let second = Utc::now().trunc_subsecs(0) + chrono::Duration::days(1);
        repository.claims[0].value.temporal.review_after =
            Some((second + chrono::Duration::milliseconds(500)).to_rfc3339());
        let mut cache = None;
        let before = reconcile_with_cache(dir.path(), &repository, second, &mut cache).unwrap();
        let within_second = reconcile_with_cache(
            dir.path(),
            &repository,
            second + chrono::Duration::milliseconds(750),
            &mut cache,
        )
        .unwrap();
        assert_eq!(before, within_second);
        let after = reconcile_with_cache(
            dir.path(),
            &repository,
            second + chrono::Duration::seconds(1),
            &mut cache,
        )
        .unwrap();
        assert!(before.user.contains("缓存测试偏好。"));
        assert!(!after.user.contains("缓存测试偏好。"));
    }

    #[test]
    fn identical_projection_keeps_file_and_creates_no_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["USER.md", "MEMORY.md"] {
            let path = dir.path().join(name);
            fs::write(&path, "same projection\n").unwrap();
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(
                    std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000),
                ))
                .unwrap();
            let before = fs::metadata(&path).unwrap();

            atomic_replace(dir.path(), &path, "same projection\n").unwrap();

            let after = fs::metadata(&path).unwrap();
            assert_eq!(before.modified().unwrap(), after.modified().unwrap());
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(before.ino(), after.ino());
            }
        }
        assert!(!dir.path().join(".notemd").exists());
    }

    #[test]
    fn changed_and_missing_projections_are_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("MEMORY.md");
        atomic_replace(dir.path(), &path, "initial\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "initial\n");
        atomic_replace(dir.path(), &path, "updated\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "updated\n");
        fs::remove_file(&path).unwrap();
        atomic_replace(dir.path(), &path, "restored\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "restored\n");
    }

    #[cfg(unix)]
    #[test]
    fn identical_symlink_is_still_replaced_with_a_regular_projection() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.md");
        let path = dir.path().join("USER.md");
        fs::write(&target, "same\n").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        atomic_replace(dir.path(), &path, "same\n").unwrap();
        assert!(fs::symlink_metadata(&path).unwrap().is_file());
        assert_eq!(fs::read_to_string(&target).unwrap(), "same\n");
    }

    #[test]
    fn continuation_lines_cannot_escape_the_fact_bullet() {
        assert_eq!(escape_continuation("第一行"), "第一行");
        assert_eq!(escape_continuation("## 伪标题"), "\\## 伪标题");
        assert_eq!(escape_continuation("- 伪条目"), "\\- 伪条目");
    }

    #[test]
    fn action_sensitive_conflict_emits_only_a_generic_safety_notice() {
        let rendered =
            render_projection("MEMORY", ProjectionTarget::Memory, vec![], &[], None, true);
        assert!(rendered.contains("存在未解决的权限或边界冲突，相关行动已暂停"));
        assert!(!rendered.contains("允许发送"));
        assert!(!rendered.contains("禁止发送"));
    }
}
