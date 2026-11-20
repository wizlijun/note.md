//! Compact Markdown projection of the reviewed dictionary for agent context.
//!
//! The YAML dictionary stays the only source of truth. This file is a one-way
//! projection of it: plain Markdown with no front matter or metadata, rewritten
//! after every reviewed write and never read back, so agents can load the confirmed
//! corrections without parsing UUID-heavy YAML. Rendering follows the
//! dictionary schema directly: contexts are `domains`, kinds are the
//! `EntryKind` serde values, `application: automatic` becomes `*`, and
//! `action: preserve` becomes `keep:`. Disabled rules never appear.

use crate::model::{Dictionary, EntryKind, RuleAction, RuleApplication, PUBLIC_DOMAIN_ID};
use crate::storage;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const INTRO: &str = "\
Confirmed ASR corrections for transcripts of the user's own conversations. \
Pick the one context that matches the conversation and apply only its lines.
";
const OUTRO: &str = "Read-only. Propose changes with `notemd conversation-dictionary propose`.\n";

/// Which notations the body uses; the legend explains only those.
#[derive(Default)]
struct Notation {
    replace: bool,
    automatic: bool,
    keep: bool,
    bare: bool,
    quoted: bool,
}

impl Notation {
    fn legend(&self) -> String {
        let mut out = String::from(INTRO);
        if self.replace {
            out.push_str(
                "- `A ← x, y`: x or y means A; replace when the surrounding text agrees.\n",
            );
        }
        if self.automatic {
            out.push_str("- `x*`: always replace x.\n");
        }
        if self.keep {
            out.push_str("- `keep: x`: never change x.\n");
        }
        if self.bare {
            out.push_str("- Bare `A`: known correct spelling.\n");
        }
        if self.quoted {
            out.push_str("- `\"…\"` is one JSON string.\n");
        }
        out.push_str(OUTRO);
        out
    }
}

pub const FILE_NAME: &str = "vocabulary.md";

/// `ssot/meetings/conversation-dictionary.yml` → `ssot/meetings/vocabulary.md`.
pub fn relative_path(dictionary_relative: &Path) -> PathBuf {
    dictionary_relative.with_file_name(FILE_NAME)
}

pub fn vault_relative_path(vault: &Path) -> Result<PathBuf, String> {
    let settings = storage::load_settings(vault)?;
    let dictionary = storage::validate_relative_path(&settings.dictionary_path)?;
    Ok(relative_path(&dictionary))
}

/// Renders the whole dictionary, or a single context when `domain_id` is set.
pub fn render(dictionary: &Dictionary, domain_id: Option<&str>) -> Result<String, String> {
    let sections = sections(dictionary);
    let mut out = String::from("# Transcript corrections\n\n");

    let selected: Vec<&Section> = match domain_id {
        Some(id) => {
            let known = id == PUBLIC_DOMAIN_ID || dictionary.domains.iter().any(|d| d.id == id);
            if !known {
                return Err(format!("unknown domain '{id}'"));
            }
            sections.iter().filter(|section| section.id == id).collect()
        }
        None => sections.iter().collect(),
    };
    let mut notation = Notation::default();
    let mut body = String::new();
    for section in selected {
        body.push('\n');
        section.write(&mut body, &mut notation);
    }
    out.push_str(&notation.legend());
    if body.is_empty() {
        out.push_str("\nNo confirmed corrections yet.\n");
    } else {
        out.push_str(&body);
    }
    Ok(out)
}

/// One-way write: the file always mirrors the dictionary and is rewritten
/// whenever its content differs; its current content is never interpreted.
pub fn sync(vault: &Path, dictionary: &Dictionary) -> Result<Value, String> {
    let settings = storage::load_settings(vault)?;
    let dictionary_relative = storage::validate_relative_path(&settings.dictionary_path)?;
    let relative = relative_path(&dictionary_relative);
    let text = render(dictionary, None)?;
    let path = storage::ensure_safe_parent(vault, &relative)?;
    let updated = match fs::read(&path) {
        Ok(existing) if existing == text.as_bytes() => false,
        Ok(_) => {
            storage::atomic_bytes(&path, text.as_bytes())?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            storage::atomic_bytes(&path, text.as_bytes())?;
            true
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    Ok(json!({
        "path": relative.to_string_lossy(),
        "updated": updated,
        "revision": dictionary.revision,
    }))
}

struct Section {
    id: String,
    name: String,
    description: String,
    /// kind → formal name → observed forms (automatic ones flagged).
    kinds: BTreeMap<usize, BTreeMap<String, BTreeSet<(String, bool)>>>,
    keep: BTreeSet<String>,
}

impl Section {
    fn is_empty(&self) -> bool {
        self.kinds.is_empty() && self.keep.is_empty()
    }

    fn write(&self, out: &mut String, notation: &mut Notation) {
        let name = one_line(&self.name);
        if name == self.id {
            out.push_str(&format!("## {name}\n"));
        } else {
            out.push_str(&format!("## {name} (id: {})\n", self.id));
        }
        let description = one_line(&self.description);
        if !description.is_empty() {
            out.push_str(&description);
            out.push('\n');
        }
        for (kind, entries) in &self.kinds {
            let items: Vec<String> = entries
                .iter()
                .map(|(formal, observed)| {
                    let formal = token(formal, notation);
                    if observed.is_empty() {
                        notation.bare = true;
                        return formal;
                    }
                    notation.replace = true;
                    let forms: Vec<String> = observed
                        .iter()
                        .map(|(form, automatic)| {
                            let form = token(form, notation);
                            if *automatic {
                                notation.automatic = true;
                                format!("{form}*")
                            } else {
                                form
                            }
                        })
                        .collect();
                    format!("{formal} ← {}", forms.join(", "))
                })
                .collect();
            out.push_str(&format!("- {}: {}\n", KIND_NAMES[*kind], items.join("; ")));
        }
        if !self.keep.is_empty() {
            notation.keep = true;
            let keep: Vec<String> = self.keep.iter().map(|form| token(form, notation)).collect();
            out.push_str(&format!("- keep: {}\n", keep.join(", ")));
        }
    }
}

const KIND_NAMES: [&str; 7] = [
    "person",
    "product",
    "organization",
    "project",
    "acronym",
    "technical_term",
    "other",
];

fn kind_index(kind: &EntryKind) -> usize {
    match kind {
        EntryKind::Person => 0,
        EntryKind::Product => 1,
        EntryKind::Organization => 2,
        EntryKind::Project => 3,
        EntryKind::Acronym => 4,
        EntryKind::TechnicalTerm => 5,
        EntryKind::Other => 6,
    }
}

/// Public first, then contexts by name; empty contexts are omitted.
fn sections(dictionary: &Dictionary) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    if !dictionary.domains.iter().any(|d| d.id == PUBLIC_DOMAIN_ID) {
        sections.push(Section::new(PUBLIC_DOMAIN_ID, PUBLIC_DOMAIN_ID, ""));
    }
    let mut domains: Vec<_> = dictionary.domains.iter().collect();
    domains.sort_by(|a, b| {
        (a.id != PUBLIC_DOMAIN_ID, &a.name, &a.id).cmp(&(b.id != PUBLIC_DOMAIN_ID, &b.name, &b.id))
    });
    for domain in domains {
        sections.push(Section::new(&domain.id, &domain.name, &domain.description));
    }
    let index: BTreeMap<String, usize> = sections
        .iter()
        .enumerate()
        .map(|(i, section)| (section.id.clone(), i))
        .collect();
    let entries: BTreeMap<&str, &crate::model::Entry> = dictionary
        .entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();

    let mut ruled: BTreeSet<(String, String)> = BTreeSet::new();
    for rule in dictionary.rules.iter().filter(|rule| rule.enabled) {
        let Some(&at) = index.get(&rule.domain_id) else {
            continue;
        };
        let section = &mut sections[at];
        match rule.action {
            RuleAction::Preserve => {
                section.keep.insert(rule.observed.clone());
            }
            RuleAction::Replace => {
                let Some(target) = &rule.target else { continue };
                if rule.observed == target.text {
                    continue;
                }
                let kind = entries
                    .get(target.entry_id.as_str())
                    .map(|entry| kind_index(&entry.kind))
                    .unwrap_or(kind_index(&EntryKind::Other));
                let automatic = rule.application == Some(RuleApplication::Automatic);
                section
                    .kinds
                    .entry(kind)
                    .or_default()
                    .entry(target.text.clone())
                    .or_default()
                    .insert((rule.observed.clone(), automatic));
                ruled.insert((rule.domain_id.clone(), target.entry_id.clone()));
            }
        }
    }
    // Entries that belong to a context but have no active rule there are
    // listed as known spellings; entries with no context fall back to public.
    for entry in &dictionary.entries {
        let mut domains: BTreeSet<&str> = dictionary
            .entry_domains
            .get(&entry.id)
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect();
        let has_rule_anywhere = dictionary.rules.iter().any(|rule| {
            rule.action == RuleAction::Replace
                && rule.target.as_ref().is_some_and(|t| t.entry_id == entry.id)
        });
        if domains.is_empty() && !has_rule_anywhere {
            domains.insert(PUBLIC_DOMAIN_ID);
        }
        for domain in domains {
            if ruled.contains(&(domain.to_string(), entry.id.clone())) {
                continue;
            }
            let Some(&at) = index.get(domain) else {
                continue;
            };
            sections[at]
                .kinds
                .entry(kind_index(&entry.kind))
                .or_default()
                .entry(entry.label.clone())
                .or_default();
        }
    }
    sections.retain(|section| !section.is_empty());
    sections
}

impl Section {
    fn new(id: &str, name: &str, description: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            kinds: BTreeMap::new(),
            keep: BTreeSet::new(),
        }
    }
}

/// Plain text unless the value could be confused with the list syntax
/// (including full-width separators an agent would also read as a list).
fn token(value: &str, notation: &mut Notation) -> String {
    let ambiguous = value.is_empty()
        || value.trim() != value
        || value.chars().any(|c| {
            matches!(c, ',' | ';' | '←' | '*' | '"' | '`' | '、' | '，' | '；') || c.is_control()
        });
    if ambiguous {
        notation.quoted = true;
        serde_json::to_string(value).unwrap_or_default()
    } else {
        value.to_string()
    }
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Domain, Entry, Rule, RuleTarget};

    fn rule(id: &str, domain: &str, observed: &str, entry: &str, text: &str) -> Rule {
        Rule {
            id: id.into(),
            domain_id: domain.into(),
            observed: observed.into(),
            action: RuleAction::Replace,
            target: Some(RuleTarget {
                entry_id: entry.into(),
                text: text.into(),
            }),
            application: Some(RuleApplication::Suggest),
            enabled: true,
            confirmed_by: "human:me".into(),
            confirmed_at: "2026-11-01T00:00:00Z".into(),
        }
    }

    fn entry(id: &str, kind: EntryKind, label: &str, forms: &[&str]) -> Entry {
        Entry {
            id: id.into(),
            kind,
            label: label.into(),
            forms: forms.iter().map(|form| form.to_string()).collect(),
            description: "noise that agents do not need".into(),
        }
    }

    fn fixture() -> Dictionary {
        let mut automatic = rule("r3", "d_team", "伟涛", "e_wei", "伟滔");
        automatic.application = Some(RuleApplication::Automatic);
        let mut disabled = rule("r4", "d_team", "伟韬", "e_wei", "伟滔");
        disabled.enabled = false;
        let mut preserve = rule("r5", "d_team", "ONES", "e_wei", "伟滔");
        preserve.action = RuleAction::Preserve;
        preserve.target = None;
        Dictionary {
            schema: crate::model::DICTIONARY_SCHEMA.into(),
            dictionary_id: "dict_test".into(),
            revision: 7,
            updated_at: "2026-11-01T00:00:00Z".into(),
            subject_id: "human:me".into(),
            scope: "user_communications".into(),
            domains: vec![
                Domain {
                    id: "d_team".into(),
                    name: "team".into(),
                    description: "核心团队\n沟通".into(),
                },
                Domain {
                    id: "d_empty".into(),
                    name: "empty".into(),
                    description: String::new(),
                },
            ],
            entries: vec![
                entry(
                    "e_cp",
                    EntryKind::Product,
                    "Hemory SaaS控制面板",
                    &["Hemory SaaS控制面板"],
                ),
                entry("e_wei", EntryKind::Person, "伟滔", &["伟滔"]),
                entry("e_li", EntryKind::Person, "丽君", &["丽君"]),
                entry("e_loose", EntryKind::Acronym, "OKF", &["OKF"]),
            ],
            entry_domains: BTreeMap::from([("e_li".to_string(), vec!["d_team".to_string()])]),
            rules: vec![
                rule("r1", "d_team", "CP", "e_cp", "Hemory SaaS控制面板"),
                rule("r2", "d_team", "控制面板", "e_cp", "Hemory SaaS控制面板"),
                automatic,
                disabled,
                preserve,
                rule("r6", "public", "a, b", "e_wei", "伟滔"),
                rule("r7", "public", "校长、二宇", "e_wei", "伟滔"),
            ],
        }
    }

    #[test]
    fn renders_contexts_kinds_and_markers_compactly() {
        let text = render(&fixture(), None).unwrap();
        let body = text.split("# Transcript corrections").nth(1).unwrap();
        let sections: String = body
            .lines()
            .skip_while(|l| !l.starts_with("## "))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            sections,
            "## public\n\
             - person: 伟滔 ← \"a, b\", \"校长、二宇\"\n\
             - acronym: OKF\n\
             \n\
             ## team (id: d_team)\n\
             核心团队 沟通\n\
             - person: 丽君; 伟滔 ← 伟涛*\n\
             - product: Hemory SaaS控制面板 ← CP, 控制面板\n\
             - keep: ONES"
        );
        assert!(!text.contains("伟韬"), "disabled rules are omitted");
        assert!(!text.contains("noise"), "entry descriptions are omitted");
        assert!(!text.contains("empty"), "empty contexts are omitted");
        for marker in ["`A ← x, y`", "`x*`", "`keep: x`", "Bare `A`", "JSON string"] {
            assert!(text.contains(marker), "legend explains {marker}");
        }
    }

    #[test]
    fn legend_only_explains_notations_in_use() {
        let mut dictionary = fixture();
        dictionary.rules.retain(|rule| rule.id == "r1");
        dictionary.entries.retain(|entry| entry.id == "e_cp");
        dictionary.entry_domains.clear();
        let text = render(&dictionary, None).unwrap();
        assert!(text.contains("`A ← x, y`"));
        for marker in ["`x*`", "`keep: x`", "Bare `A`", "JSON string"] {
            assert!(!text.contains(marker), "legend omits unused {marker}");
        }
    }

    #[test]
    fn output_is_plain_markdown_without_metadata_and_deterministic() {
        let text = render(&fixture(), None).unwrap();
        assert!(text.starts_with("# Transcript corrections\n\n"));
        for metadata in [
            "---",
            "type:",
            "generated",
            "sources",
            "revision",
            "2026-11-01",
        ] {
            assert!(!text.contains(metadata), "no metadata: {metadata}");
        }
        assert_eq!(text, render(&fixture(), None).unwrap());
    }

    #[test]
    fn domain_filter_renders_one_context_and_rejects_unknown_ids() {
        let text = render(&fixture(), Some("d_team")).unwrap();
        assert!(text.contains("## team"));
        assert!(!text.contains("## public"));
        let empty = render(&fixture(), Some("d_empty")).unwrap();
        assert!(empty.contains("No confirmed corrections yet."));
        assert!(render(&fixture(), Some("d_missing")).is_err());
    }

    #[test]
    fn path_sits_next_to_the_dictionary() {
        assert_eq!(
            relative_path(Path::new("ssot/meetings/conversation-dictionary.yml")),
            PathBuf::from("ssot/meetings/vocabulary.md")
        );
        assert_eq!(
            relative_path(Path::new("dict.yaml")),
            PathBuf::from("vocabulary.md")
        );
    }

    #[test]
    fn sync_writes_one_way_and_only_when_content_changes() {
        let vault = tempfile::tempdir().unwrap();
        let dictionary = fixture();
        let first = sync(vault.path(), &dictionary).unwrap();
        assert_eq!(first["path"], "ssot/meetings/vocabulary.md");
        assert_eq!(first["updated"], true);
        assert_eq!(sync(vault.path(), &dictionary).unwrap()["updated"], false);

        let mut bumped = dictionary.clone();
        bumped.revision += 1;
        assert_eq!(
            sync(vault.path(), &bumped).unwrap()["updated"],
            false,
            "metadata-only changes do not rewrite the file"
        );

        let path = vault.path().join("ssot/meetings/vocabulary.md");
        fs::write(&path, "hand edit\n").unwrap();
        assert_eq!(sync(vault.path(), &dictionary).unwrap()["updated"], true);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            render(&dictionary, None).unwrap()
        );
    }
}
