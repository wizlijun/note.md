//! Deterministic local extraction. Attention event text is retained only during
//! the build; snapshots persist evidence locators, not source text.
mod attention;
mod knowledge;
mod markdown;

use crate::{hash, model::*, stable_id};
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone)]
struct PendingLink {
    source: String,
    from: String,
    target: String,
    wiki: bool,
    evidence: String,
}
#[derive(Default)]
struct Document {
    node: String,
    aliases: Vec<String>,
    empty: bool,
    sources: Vec<String>,
}

pub struct Extractor {
    vault_id: String,
    inputs: BTreeMap<String, SourceInput>,
    sources: BTreeMap<String, Source>,
    nodes: BTreeMap<String, Node>,
    evidence: BTreeMap<String, Evidence>,
    edges: BTreeMap<String, Edge>,
    documents: BTreeMap<String, Document>,
    normalized_paths: BTreeMap<String, Vec<String>>,
    features: BTreeMap<String, Vec<String>>,
    contexts: BTreeMap<String, Vec<String>>,
    pending: Vec<PendingLink>,
    seen: BTreeSet<String>,
    coverage: Coverage,
    wiki_root: String,
    daily_root: String,
    blocked: BTreeSet<String>,
    fatal: Option<String>,
    focus: Option<FocusContext>,
    focus_events: Vec<crate::focus::UserEvent>,
    previous_keywords: BTreeMap<String, String>,
    attention: Vec<Attention>,
    attention_observations: Vec<AttentionObservation>,
    retained_keywords: BTreeSet<String>,
    statistical_weights: BTreeMap<String, f64>,
}

pub(super) fn normalize(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

impl Extractor {
    pub fn new(vault_id: &str, inputs: &[SourceInput], previous: Option<&Snapshot>) -> Self {
        let mut out = Self {
            vault_id: vault_id.into(),
            inputs: BTreeMap::new(),
            sources: BTreeMap::new(),
            nodes: BTreeMap::new(),
            evidence: BTreeMap::new(),
            edges: BTreeMap::new(),
            documents: BTreeMap::new(),
            normalized_paths: BTreeMap::new(),
            features: BTreeMap::new(),
            contexts: BTreeMap::new(),
            pending: Vec::new(),
            seen: BTreeSet::new(),
            coverage: Coverage::default(),
            wiki_root: "wikipage".into(),
            daily_root: "dailynote".into(),
            blocked: ["wikilink", "链接", "双链"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            fatal: None,
            focus: None,
            focus_events: Vec::new(),
            previous_keywords: previous
                .filter(|s| s.meta.vault_id == vault_id)
                .into_iter()
                .flat_map(|s| &s.nodes)
                .filter(|n| {
                    matches!(
                        n.node_type.as_str(),
                        "keyword"
                            | "project"
                            | "person"
                            | "tool"
                            | "resource"
                            | "entity"
                            | "term_candidate"
                    )
                })
                .map(|n| (normalize(&n.label), n.label.clone()))
                .collect(),
            attention: Vec::new(),
            attention_observations: Vec::new(),
            retained_keywords: BTreeSet::new(),
            statistical_weights: BTreeMap::new(),
        };
        let old = previous.filter(|s| s.meta.vault_id == vault_id);
        let old_by_path: BTreeMap<_, _> = old
            .into_iter()
            .flat_map(|s| s.sources.iter())
            .map(|s| (s.path.as_str(), s))
            .collect();
        let current_paths: BTreeSet<_> = inputs.iter().map(|i| i.path.as_str()).collect();
        let mut old_hashes: BTreeMap<&str, Vec<&Source>> = BTreeMap::new();
        if let Some(snapshot) = old {
            for source in &snapshot.sources {
                if !current_paths.contains(source.path.as_str()) && source.status == "available" {
                    old_hashes.entry(&source.hash).or_default().push(source);
                }
            }
        }
        let mut input_hashes: BTreeMap<&str, usize> = BTreeMap::new();
        for input in inputs {
            *input_hashes.entry(&input.hash).or_default() += 1;
        }
        for input in inputs {
            if !safe_path(&input.path)
                || input.hash.len() != 64
                || !input.hash.bytes().all(|b| b.is_ascii_hexdigit())
            {
                out.fatal = Some("提取输入包含无效路径或内容摘要".into());
                continue;
            }
            if out
                .inputs
                .insert(input.path.clone(), input.clone())
                .is_some()
            {
                out.fatal = Some("提取输入包含重复路径".into());
                continue;
            }
            let existing = old_by_path.get(input.path.as_str()).copied();
            let renamed = old_hashes
                .get(input.hash.as_str())
                .filter(|v| v.len() == 1 && input_hashes[input.hash.as_str()] == 1)
                .map(|v| v[0]);
            let id = existing
                .or(renamed)
                .map(|s| s.id.clone())
                .unwrap_or_else(|| stable_id("source", &format!("{vault_id}\0{}", input.path)));
            let role = if is_config(&input.path) {
                "config"
            } else if input.path.ends_with("/knowledge.json") {
                "knowledge"
            } else {
                "document"
            };
            out.sources.insert(
                input.path.clone(),
                Source {
                    id: id.clone(),
                    path: input.path.clone(),
                    hash: input.hash.clone(),
                    role: role.into(),
                    status: "unavailable".into(),
                    family: stable_id("family", &id),
                    family_status: "unresolved".into(),
                },
            );
        }
        out.coverage.indexed = out.inputs.len();
        out
    }

    pub fn add_document(&mut self, path: &str, content: &str) -> Result<(), String> {
        if let Some(error) = &self.fatal {
            return Err(error.clone());
        }
        let expected = self.inputs.get(path).ok_or("文档未包含在授权输入清单")?;
        if self.seen.contains(path) {
            return Err("同一文档不能重复提交".into());
        }
        if hash(content.as_bytes()) != expected.hash {
            self.mark_unavailable(path, "内容已变化，与冻结清单摘要不一致");
            return Err("SOURCE_STALE: 内容与冻结摘要不一致".into());
        }
        self.seen.insert(path.into());
        self.sources.get_mut(path).unwrap().status = "available".into();
        if let Some(focus) = &self.focus {
            self.focus_events.extend(crate::focus::events_from_markdown(
                path,
                content,
                focus.utc_offset_minutes,
            ));
        }
        if is_config(path) {
            self.read_config(path, content);
        } else if path.ends_with("/knowledge.json") {
            self.read_knowledge(path, content);
        } else if [".md", ".txt", ".srt", ".vtt"]
            .iter()
            .any(|ext| path.to_lowercase().ends_with(ext))
        {
            self.read_markdown(path, content);
        } else {
            self.coverage.excluded += 1;
            self.diagnostic(
                "unsupported.input",
                path,
                "未支持的输入类型，未构造知识对象",
            );
            return Ok(());
        }
        self.coverage.parsed += 1;
        Ok(())
    }

    pub fn mark_unavailable(&mut self, path: &str, reason: &str) {
        if self.sources.contains_key(path) && self.seen.insert(path.into()) {
            self.coverage.unavailable += 1;
            self.diagnostic("source.unavailable", path, reason);
        }
    }

    fn read_config(&mut self, path: &str, content: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(content) else {
            self.diagnostic(
                "config.invalid",
                path,
                "配置不是有效 JSON；使用缺省命名空间",
            );
            return;
        };
        if path == ".notemd/settings.json" {
            for (field, target) in [
                ("wikipageDir", &mut self.wiki_root),
                ("dailynoteDir", &mut self.daily_root),
            ] {
                if let Some(value) = value[field].as_str().filter(|v| safe_path(v)) {
                    *target = value.trim_matches('/').into();
                }
            }
        }
    }

    fn diagnostic(&mut self, code: &str, path: &str, message: &str) {
        self.coverage.diagnostic_count += 1;
        if self.coverage.diagnostics.len() < 256 {
            self.coverage.diagnostics.push(Diagnostic {
                code: code.into(),
                path: path.into(),
                message: message.chars().take(400).collect(),
            });
        }
    }

    fn evidence(
        &mut self,
        path: &str,
        locator: Locator,
        role: &str,
        authorship: &str,
        granularity: &str,
        verification: &str,
    ) -> String {
        let source = &self.sources[path].id;
        let key = format!(
            "{source}\0{}\0{role}\0{authorship}\0{granularity}\0{verification}",
            serde_json::to_string(&locator).unwrap()
        );
        let id = stable_id("evidence", &key);
        self.evidence.entry(id.clone()).or_insert_with(|| Evidence {
            id: id.clone(),
            source: source.clone(),
            locator,
            role: role.into(),
            authorship: authorship.into(),
            granularity: granularity.into(),
            verification: verification.into(),
        });
        id
    }

    fn add_node(
        &mut self,
        key: String,
        label: String,
        kind: &str,
        status: &str,
        evidence: Vec<String>,
        aliases: Vec<String>,
    ) -> String {
        // Long imported names remain intact as labels. Identity is losslessly
        // digested, rather than truncating unrelated scoped names to one key.
        let key = if key.len() > 240 {
            format!(
                "{}:sha256:{}",
                key.split(':').next().unwrap_or("scoped"),
                hash(&key)
            )
        } else {
            key
        };
        let id = stable_id("node", &format!("{}\0{key}", self.vault_id));
        let candidate_label = label.clone();
        let node = self.nodes.entry(id.clone()).or_insert_with(|| Node {
            id: id.clone(),
            key,
            node_type: kind.into(),
            label,
            status: status.into(),
            aliases: Vec::new(),
            evidence: Vec::new(),
            intent_status: None,
        });
        if candidate_label < node.label {
            node.label = candidate_label;
        }
        node.evidence.extend(evidence);
        node.evidence.sort();
        node.evidence.dedup();
        node.aliases.extend(aliases);
        node.aliases.sort();
        node.aliases.dedup();
        id
    }

    fn add_edge(
        &mut self,
        edge_type: &str,
        status: &str,
        mut participants: Vec<Participant>,
        evidence: Vec<String>,
    ) -> Option<String> {
        participants.sort_by(|a, b| (&a.role, &a.node).cmp(&(&b.role, &b.node)));
        participants.dedup_by(|a, b| a.role == b.role && a.node == b.node);
        if participants.len() < 2 {
            return None;
        }
        let id = stable_id(
            "edge",
            &format!(
                "{edge_type}\0{status}\0{}",
                serde_json::to_string(&participants).unwrap()
            ),
        );
        let edge = self.edges.entry(id.clone()).or_insert_with(|| Edge {
            id: id.clone(),
            edge_type: edge_type.into(),
            status: status.into(),
            participants,
            ..Edge::default()
        });
        edge.evidence.extend(evidence);
        edge.evidence.sort();
        edge.evidence.dedup();
        Some(id)
    }

    pub fn finish(mut self) -> Result<Extraction, String> {
        if let Some(error) = self.fatal.take() {
            return Err(error);
        }
        let unseen: Vec<_> = self
            .inputs
            .keys()
            .filter(|p| !self.seen.contains(*p))
            .cloned()
            .collect();
        for path in unseen {
            self.mark_unavailable(&path, "授权输入未交付给提取器");
        }
        self.resolve_families();
        let mut names: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (path, document) in &self.documents {
            if document.node.is_empty() {
                continue;
            }
            self.normalized_paths
                .entry(path.nfc().collect())
                .or_default()
                .push(document.node.clone());
            if in_dir(path, &self.wiki_root) || in_dir(path, &self.daily_root) {
                // The host resolves filename names. Explicit aliases add scoped names;
                // a display title alone does not rewrite the filename namespace.
                let name = file_stem(path);
                let companion = path.ends_with(".note.md")
                    && self
                        .documents
                        .contains_key(&format!("{}.md", path.trim_end_matches(".note.md")));
                if !companion && !path.ends_with(".index.md") {
                    for name in std::iter::once(&name).chain(document.aliases.iter()) {
                        names
                            .entry(normalize(name))
                            .or_default()
                            .insert(document.node.clone());
                    }
                }
            }
            if in_dir(path, &self.wiki_root) && !path.ends_with("/blocklist.md") {
                if let Some(node) = self.nodes.get_mut(&document.node) {
                    node.node_type = "concept".into();
                    node.status = if document.empty { "anchor" } else { "observed" }.into();
                }
            }
        }
        let mut unit_mentions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut context_scores: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
        for link in std::mem::take(&mut self.pending) {
            let target = if link.wiki {
                let logical = link.target.split('#').next().unwrap_or("").trim();
                if self.blocked.contains(&normalize(logical)) || logical.is_empty() {
                    continue;
                }
                if logical.contains('/') {
                    self.resolve_wiki_document(&link.source, logical)
                } else {
                    match names.get(&normalize(logical)) {
                        Some(ids) if ids.len() == 1 => ids.first().cloned(),
                        Some(_) => {
                            self.coverage.unresolved_links += 1;
                            self.diagnostic(
                                "wiki.ambiguous",
                                &link.source,
                                "同名页面或别名有多个目标，未猜测身份",
                            );
                            None
                        }
                        None => self
                            .resolve_wiki_document(&link.source, logical)
                            .or_else(|| {
                                Some(self.add_node(
                                    format!(
                                        "wiki:{}:{}",
                                        normalize(&self.wiki_root),
                                        normalize(logical)
                                    ),
                                    logical.into(),
                                    "concept",
                                    "anchor",
                                    vec![link.evidence.clone()],
                                    Vec::new(),
                                ))
                            }),
                    }
                }
            } else {
                if link.target.starts_with('#')
                    || has_scheme(&link.target)
                    || link.target.starts_with("//")
                {
                    continue;
                }
                self.resolve_document(&link.source, &link.target)
            };
            if let Some(target) = target {
                if let Some(node) = self
                    .nodes
                    .get_mut(&target)
                    .filter(|n| n.node_type != "document")
                {
                    node.evidence.push(link.evidence.clone());
                }
                if target != link.from {
                    if link.wiki {
                        unit_mentions
                            .entry(link.evidence.clone())
                            .or_default()
                            .insert(target.clone());
                        if let Some(context) = self.contexts.get(&link.evidence) {
                            for term in context {
                                *context_scores
                                    .entry(target.clone())
                                    .or_default()
                                    .entry(term.clone())
                                    .or_default() += 1;
                            }
                        }
                    }
                    self.add_edge(
                        if link.wiki {
                            "wikilink"
                        } else {
                            "explicit_reference"
                        },
                        "observed",
                        vec![
                            Participant {
                                node: link.from,
                                role: "source".into(),
                            },
                            Participant {
                                node: target,
                                role: "target".into(),
                            },
                        ],
                        vec![link.evidence],
                    );
                }
            } else if !(link.wiki
                && names
                    .get(&normalize(link.target.split('#').next().unwrap_or("")))
                    .is_some_and(|v| v.len() > 1))
            {
                self.coverage.unresolved_links += 1;
                self.diagnostic(
                    "link.unresolved",
                    &link.source,
                    "本地链接缺失、越界或目标未包含在本次有效输入",
                );
            }
        }
        for (evidence, targets) in unit_mentions {
            if targets.len() > 1 {
                self.add_edge(
                    "co_mentioned_in",
                    "candidate",
                    targets
                        .into_iter()
                        .map(|node| Participant {
                            node,
                            role: "mentioned".into(),
                        })
                        .collect(),
                    vec![evidence],
                );
            }
        }
        for node in self.nodes.values_mut() {
            node.evidence.sort();
            node.evidence.dedup();
        }
        for (node, scores) in context_scores {
            let mut terms: Vec<_> = scores.into_iter().collect();
            terms.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            let features = self.features.entry(node.clone()).or_insert_with(|| {
                let label = normalize(&self.nodes[&node].label);
                if label.chars().count() <= 96 {
                    vec![label]
                } else {
                    Vec::new()
                }
            });
            let mut existing: BTreeSet<_> = features.iter().cloned().collect();
            for (term, _) in terms {
                if features.len() >= 32 {
                    break;
                }
                if existing.insert(term.clone()) {
                    features.push(term);
                }
            }
            features.sort();
        }
        self.extract_attention()?;
        let used_evidence: BTreeSet<_> = self
            .nodes
            .values()
            .flat_map(|n| n.evidence.iter().cloned())
            .chain(self.edges.values().flat_map(|e| e.evidence.iter().cloned()))
            .collect();
        self.evidence.retain(|id, _| used_evidence.contains(id));
        let source_by_id: BTreeMap<_, _> =
            self.sources.values().map(|s| (s.id.clone(), s)).collect();
        for edge in self.edges.values_mut() {
            let mut verified = BTreeSet::new();
            let mut provisional = BTreeSet::new();
            let mut unresolved = BTreeSet::new();
            for id in &edge.evidence {
                if let Some(source) = self
                    .evidence
                    .get(id)
                    .and_then(|ev| source_by_id.get(&ev.source))
                {
                    match source.family_status.as_str() {
                        "verified" => {
                            verified.insert(&source.family);
                        }
                        "unresolved" => {
                            unresolved.insert(&source.family);
                        }
                        _ => {
                            provisional.insert(&source.family);
                        }
                    }
                }
            }
            edge.verified_families = verified.len();
            edge.provisional_families = provisional.difference(&verified).count();
            edge.unresolved_lineage = unresolved.len();
        }
        let assigned: BTreeSet<_> = self
            .nodes
            .values()
            .filter(|n| n.node_type != "document")
            .flat_map(|n| &n.evidence)
            .filter_map(|id| self.evidence.get(id))
            .map(|e| e.source.as_str())
            .collect();
        self.coverage.unassigned_sources = self
            .sources
            .values()
            .filter(|s| s.role != "config" && !assigned.contains(s.id.as_str()))
            .count();
        self.coverage
            .diagnostics
            .sort_by(|a, b| (&a.path, &a.code, &a.message).cmp(&(&b.path, &b.code, &b.message)));
        self.coverage.diagnostics.dedup();
        Ok(Extraction {
            sources: self.sources.into_values().collect(),
            nodes: self.nodes.into_values().collect(),
            evidence: self.evidence.into_values().collect(),
            edges: self.edges.into_values().collect(),
            coverage: self.coverage,
            features: self.features,
            focus: self.focus,
            attention_observations: self.attention_observations,
            attention: self.attention,
            retained_keywords: self.retained_keywords,
            statistical_weights: self.statistical_weights,
        })
    }

    fn resolve_document(&self, from: &str, raw: &str) -> Option<String> {
        let target = resolve_path(from, raw)?;
        self.lookup_document(&target)
    }

    fn resolve_wiki_document(&self, from: &str, raw: &str) -> Option<String> {
        if has_scheme(raw) || raw.starts_with("//") {
            return None;
        }
        // Same explicit path rule as link-open.ts: Wiki names are literal,
        // not URL-encoded; only names without an ASCII extension gain .md.
        let has_extension =
            raw.rsplit('/')
                .next()?
                .rsplit_once('.')
                .is_some_and(|(_, extension)| {
                    !extension.is_empty() && extension.bytes().all(|b| b.is_ascii_alphanumeric())
                });
        let target = if has_extension {
            raw.to_owned()
        } else {
            format!("{raw}.md")
        };
        let target = resolve_literal_path(from, &target)?;
        self.lookup_document(&target)
    }

    fn lookup_document(&self, target: &str) -> Option<String> {
        self.documents
            .get(target)
            .filter(|d| !d.node.is_empty())
            .map(|d| d.node.clone())
            .or_else(|| {
                let normalized = target.nfc().collect::<String>();
                self.normalized_paths
                    .get(&normalized)
                    .filter(|hits| hits.len() == 1)
                    .map(|hits| hits[0].clone())
            })
    }

    fn resolve_families(&mut self) {
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for source in self
            .sources
            .values()
            .filter(|s| s.status == "available" && s.role != "config")
        {
            groups
                .entry(source.hash.clone())
                .or_default()
                .push(source.path.clone());
        }
        for (digest, paths) in groups {
            if paths.len() > 1 {
                let family = stable_id("family", &format!("{}\0exact:{digest}", self.vault_id));
                for path in paths {
                    let source = self.sources.get_mut(&path).unwrap();
                    source.family = family.clone();
                    source.family_status = "verified".into();
                }
            }
        }
        let mut parents: BTreeMap<String, String> = BTreeMap::new();
        for (path, document) in &self.documents {
            if document.sources.is_empty() {
                continue;
            }
            let resolved: BTreeSet<_> = document
                .sources
                .iter()
                .filter_map(|raw| resolve_path(path, raw))
                .filter(|p| self.sources.get(p).is_some_and(|s| s.status == "available"))
                .collect();
            if document.sources.len() == 1 && resolved.len() == 1 && !resolved.contains(path) {
                parents.insert(path.clone(), resolved.first().unwrap().clone());
            } else {
                self.sources.get_mut(path).unwrap().family_status = "unresolved".into();
            }
        }
        for path in parents.keys() {
            let mut chain = BTreeSet::new();
            let mut cursor = path;
            while let Some(next) = parents.get(cursor) {
                if !chain.insert(cursor.clone()) {
                    break;
                }
                cursor = next;
            }
            if chain.contains(cursor) {
                self.sources.get_mut(path).unwrap().family_status = "unresolved".into();
            } else if self
                .documents
                .get(cursor)
                .is_some_and(|d| !d.sources.is_empty())
                && self.sources[cursor].family_status == "unresolved"
            {
                self.sources.get_mut(path).unwrap().family_status = "unresolved".into();
            } else {
                let family = self.sources[cursor].family.clone();
                let source = self.sources.get_mut(path).unwrap();
                source.family = family;
                source.family_status = "verified".into();
                self.sources.get_mut(cursor).unwrap().family_status = "verified".into();
            }
        }
    }
}

fn is_config(path: &str) -> bool {
    matches!(path, ".notemd/settings.json" | ".notemd/meetings.json")
}
fn in_dir(path: &str, directory: &str) -> bool {
    path.strip_prefix(directory)
        .is_some_and(|tail| tail.starts_with('/'))
}
fn safe_path(path: &str) -> bool {
    crate::codec::safe_source_path(path) && !path.split('/').any(|p| p == ".credentials")
}
fn file_stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".note.md")
        .or_else(|| name.strip_suffix(".md"))
        .unwrap_or(name)
        .to_owned()
}
fn has_scheme(raw: &str) -> bool {
    raw.split_once(':').is_some_and(|(prefix, _)| {
        !prefix.is_empty()
            && prefix.chars().next().unwrap().is_ascii_alphabetic()
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    })
}
fn resolve_path(from: &str, raw: &str) -> Option<String> {
    if has_scheme(raw) || raw.starts_with("//") {
        return None;
    }
    let raw = raw
        .split(['#', '?'])
        .next()?
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    if raw.is_empty() {
        return None;
    }
    let mut decoded = Vec::new();
    let bytes = raw.as_bytes();
    let mut n = 0;
    while n < bytes.len() {
        if bytes[n] == b'%' {
            let hi = (*bytes.get(n + 1)? as char).to_digit(16)?;
            let lo = (*bytes.get(n + 2)? as char).to_digit(16)?;
            decoded.push((hi * 16 + lo) as u8);
            n += 3;
        } else {
            decoded.push(bytes[n]);
            n += 1;
        }
    }
    let decoded = String::from_utf8(decoded).ok()?;
    resolve_literal_path(from, &decoded)
}

fn resolve_literal_path(from: &str, raw: &str) -> Option<String> {
    let mut parts: Vec<_> = if raw.starts_with('/') {
        Vec::new()
    } else {
        from.rsplit_once('/')
            .map(|(p, _)| p.split('/').collect())
            .unwrap_or_default()
    };
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    let path = parts.join("/");
    safe_path(&path).then_some(path)
}
