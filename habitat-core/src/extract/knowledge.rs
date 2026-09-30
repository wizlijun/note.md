//! Import already-extracted meeting records without upgrading their authority.
use super::*;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

const COLLECTIONS: [(&str, char); 6] = [
    ("entities", 'e'),
    ("concepts", 'c'),
    ("claims", 'q'),
    ("events", 'v'),
    ("narratives", 'n'),
    ("relations", 'r'),
];
fn local_id(value: &str, prefixes: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| prefixes.contains(c))
        && chars.next().is_some_and(|c| ('1'..='9').contains(&c))
        && chars.all(|c| c.is_ascii_digit())
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty())
}
fn role_name(value: &str) -> bool {
    let mut first = true;
    value.split('_').all(|word| {
        let valid = !word.is_empty()
            && word
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            && (!first || word.chars().next().is_some_and(|c| c.is_ascii_lowercase()));
        first = false;
        valid
    })
}
fn string_array(value: &Value) -> Option<Vec<&str>> {
    value.as_array()?.iter().map(Value::as_str).collect()
}
fn role_refs(value: &Value) -> Option<Vec<(&str, &str)>> {
    let map = value.as_object()?;
    let mut out = Vec::new();
    for (role, refs) in map {
        if !role_name(role) {
            return None;
        }
        if let Some(value) = refs.as_str() {
            out.push((role.as_str(), value));
        } else {
            let refs = string_array(refs)?;
            if refs.is_empty() {
                return None;
            }
            out.extend(refs.into_iter().map(|value| (role.as_str(), value)));
        }
    }
    Some(out)
}
fn refs(record: &Value) -> Vec<&str> {
    let mut out = Vec::new();
    for key in ["about", "claim", "place"] {
        if let Some(values) = string_array(&record[key]) {
            out.extend(values);
        }
    }
    if let Some(values) = string_array(&record["by"]) {
        out.extend(values.into_iter().filter(|v| local_id(v, "secqvnr")));
    }
    if let Some(values) = role_refs(&record["args"]) {
        out.extend(values.into_iter().map(|(_, value)| value));
    }
    for member in record["members"].as_array().into_iter().flatten() {
        if let Some(value) = member["ref"].as_str() {
            out.push(value);
        }
    }
    out
}

// serde_json::Value normally silently accepts duplicate map keys. A duplicate
// must not replace an identity, reference, or authority field during import.
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
                Ok(Strict(Value::Number(v.into())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
                Ok(Strict(Value::Number(v.into())))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strict, E> {
                serde_json::Number::from_f64(v)
                    .map(|v| Strict(Value::Number(v)))
                    .ok_or_else(|| E::custom("invalid number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(Value::String(v.into())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Strict, E> {
                Ok(Strict(Value::String(v)))
            }
            fn visit_none<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut values = Vec::new();
                while let Some(v) = a.next_element::<Strict>()? {
                    values.push(v.0);
                }
                Ok(Strict(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut values = Map::new();
                while let Some(key) = a.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate JSON key"));
                    }
                    values.insert(key, a.next_value::<Strict>()?.0);
                }
                Ok(Strict(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

impl Extractor {
    pub(super) fn read_knowledge(&mut self, path: &str, content: &str) {
        self.coverage.knowledge_datasets += 1;
        let dataset = match serde_json::from_str::<Strict>(content) {
            Ok(value) => value.0,
            Err(_) => {
                self.coverage.excluded += 1;
                self.diagnostic(
                    "knowledge.json",
                    path,
                    "会议知识 JSON 无效或含重复字段，整份未导入",
                );
                return;
            }
        };
        let current = dataset["schema"] == "knowledge-representation-dataset/3.1.0";
        if !current && dataset["schema"] != "knowledge-representation-dataset/3.0.0" {
            self.coverage.excluded += 1;
            self.diagnostic("knowledge.schema", path, "会议知识 schema 不受支持");
            return;
        }
        let supported_rule = if current {
            matches!(
                dataset["generated"]["rule"].as_str(),
                Some("relation-schema-extractor/3.1.0" | "relation-schema-extractor/3.1.1")
            )
        } else {
            dataset["generated"]["rule"] == "relation-schema-extractor/3.0.0"
        };
        if !supported_rule
            || dataset["generated"]["types"] != "1.0.0"
            || !nonempty(&dataset["id"])
            || !nonempty(&dataset["generated"]["by"])
            || !nonempty(&dataset["generated"]["at"])
            || !nonempty(&dataset["scope"]["purpose"])
            || string_array(&dataset["scope"]["questions"]).is_none()
            || ![
                "sources",
                "evidence",
                "entities",
                "concepts",
                "claims",
                "events",
                "narratives",
                "relations",
            ]
            .iter()
            .all(|k| dataset[*k].is_array())
        {
            self.coverage.excluded += 1;
            self.diagnostic(
                "knowledge.schema",
                path,
                "会议知识缺少必要字段或规则版本不兼容，整份未导入",
            );
            return;
        }
        let total: usize = COLLECTIONS
            .iter()
            .map(|(name, _)| dataset[*name].as_array().unwrap().len())
            .sum();
        self.coverage.knowledge_records += total;
        let mut sources: BTreeMap<String, &Value> = BTreeMap::new();
        let mut duplicates = BTreeSet::new();
        for source in dataset["sources"].as_array().unwrap() {
            if let Some(id) = source["id"].as_str().filter(|id| local_id(id, "s")) {
                if sources.insert(id.into(), source).is_some() {
                    duplicates.insert(id.to_owned());
                }
            }
        }
        sources.retain(|id, value| {
            !duplicates.contains(id)
                && nonempty(&value["uri"])
                && (value["v"].is_null() || nonempty(&value["v"]))
        });
        if sources.len() != dataset["sources"].as_array().unwrap().len() {
            self.diagnostic(
                "knowledge.sources",
                path,
                "来源对象包含重复 ID 或无效字段，其引用记录将被隔离",
            );
        }
        let mut evidence: BTreeMap<String, (usize, &Value)> = BTreeMap::new();
        duplicates.clear();
        for (index, ev) in dataset["evidence"].as_array().unwrap().iter().enumerate() {
            if let Some(id) = ev["id"].as_str().filter(|id| local_id(id, "x")) {
                if evidence.insert(id.into(), (index, ev)).is_some() {
                    duplicates.insert(id.to_owned());
                }
            }
        }
        evidence.retain(|id, (_, ev)| {
            !duplicates.contains(id)
                && ev["s"].as_str().is_some_and(|id| sources.contains_key(id))
                && nonempty(&ev["loc"])
                && ev.get("quote").is_none_or(nonempty)
                && ev
                    .get("speaker")
                    .is_none_or(|v| v.as_str().is_some_and(|id| local_id(id, "e")))
                && ev.get("role").is_none_or(|v| {
                    matches!(
                        v.as_str(),
                        Some(
                            "mentions"
                                | "defines"
                                | "reports"
                                | "supports"
                                | "contradicts"
                                | "describes"
                                | "sequences"
                                | "context"
                                | "identity"
                        )
                    )
                })
        });
        if evidence.len() != dataset["evidence"].as_array().unwrap().len() {
            self.diagnostic(
                "knowledge.evidence",
                path,
                "证据对象包含重复 ID、断开的来源或无效字段，其引用记录将被隔离",
            );
        }
        let registry: Value = serde_json::from_str(include_str!(
            "../../../plugins-src/knowledge-browser/references/relation-types.json"
        ))
        .unwrap();
        let mut types = registry["types"].as_object().unwrap().clone();
        for definition in dataset["type_defs"].as_array().into_iter().flatten() {
            if let Some(id) = definition["id"].as_str().filter(|id| role_name(id)) {
                if !types.contains_key(id)
                    && definition["p"].as_u64().is_some_and(|p| p <= 3)
                    && string_array(&definition["roles"])
                        .is_some_and(|v| v.len() >= 2 && v.iter().all(|r| role_name(r)))
                    && nonempty(&definition["definition"])
                    && nonempty(&definition["not"])
                {
                    types.insert(id.into(), definition.clone());
                } else {
                    self.diagnostic(
                        "knowledge.type_definition",
                        path,
                        "自定义关系类型无效或尝试覆盖内置类型",
                    );
                }
            }
        }
        let mut records: BTreeMap<String, (&str, usize, &Value)> = BTreeMap::new();
        duplicates.clear();
        let mut invalid = BTreeSet::new();
        let mut malformed_ids = 0;
        for (kind, prefix) in COLLECTIONS {
            for (index, record) in dataset[kind].as_array().unwrap().iter().enumerate() {
                let Some(id) = record["id"]
                    .as_str()
                    .filter(|s| local_id(s, &prefix.to_string()))
                else {
                    malformed_ids += 1;
                    continue;
                };
                if records.insert(id.into(), (kind, index, record)).is_some() {
                    duplicates.insert(id.to_owned());
                }
                let common = matches!(record["i"].as_u64(), Some(0 | 1))
                    && nonempty(&record["why"])
                    && string_array(&record["ev"]).is_some_and(|ids| {
                        !ids.is_empty() && ids.iter().all(|id| evidence.contains_key(*id))
                    })
                    && record.get("status").is_none_or(|v| {
                        matches!(
                            v.as_str(),
                            Some(
                                "contested"
                                    | "supported"
                                    | "confirmed"
                                    | "superseded"
                                    | "retracted"
                            )
                        )
                    })
                    && ["aliases", "limits", "if", "unless"].iter().all(|k| {
                        record.get(*k).is_none_or(|v| {
                            string_array(v).is_some_and(|v| v.iter().all(|s| !s.trim().is_empty()))
                        })
                    });
                let epistemic = !current
                    || (matches!(
                        record["epistemic"]["strength"].as_str(),
                        Some("strong" | "medium" | "weak")
                    ) && string_array(&record["epistemic"]["basis"]).is_some_and(|v| {
                        !v.is_empty()
                            && v.iter().all(|b| {
                                matches!(
                                    *b,
                                    "explicit_statement"
                                        | "explicit_speech_act"
                                        | "direct_observation"
                                        | "source_defined"
                                        | "independent_corroboration"
                                        | "self_report"
                                        | "agent_inference"
                                        | "ambiguous"
                                )
                            })
                    }) && (dataset["selection"]["profile"] != "strong_only"
                        || record["epistemic"]["strength"] == "strong"));
                let shape = match kind {
                    "entities" => {
                        nonempty(&record["name"])
                            && matches!(
                                record["type"].as_str(),
                                Some(
                                    "person"
                                        | "organization"
                                        | "team"
                                        | "project"
                                        | "document"
                                        | "place"
                                        | "system"
                                        | "artifact"
                                        | "other"
                                )
                            )
                    }
                    "concepts" => nonempty(&record["term"]) && nonempty(&record["definition"]),
                    "claims" => {
                        nonempty(&record["text"])
                            && string_array(&record["about"]).is_some()
                            && string_array(&record["by"]).is_some()
                            && matches!(
                                record["kind"].as_str(),
                                Some(
                                    "fact"
                                        | "definition"
                                        | "decision"
                                        | "commitment"
                                        | "rule"
                                        | "evaluation"
                                        | "prediction"
                                        | "hypothesis"
                                        | "question"
                                        | "other"
                                )
                            )
                    }
                    "events" => {
                        nonempty(&record["title"])
                            && role_refs(&record["args"]).is_some()
                            && matches!(
                                record["state"].as_str(),
                                Some("planned" | "ongoing" | "completed" | "cancelled" | "unknown")
                            )
                    }
                    "narratives" => {
                        nonempty(&record["title"])
                            && nonempty(&record["thesis"])
                            && record["members"].as_array().is_some_and(|m| {
                                !m.is_empty()
                                    && m.iter()
                                        .all(|m| nonempty(&m["ref"]) && nonempty(&m["role"]))
                            })
                    }
                    "relations" => {
                        nonempty(&record["type"])
                            && record["p"].as_u64().is_some_and(|p| p <= 3)
                            && role_refs(&record["args"]).is_some_and(|args| args.len() >= 2)
                            && (nonempty(&record["text"])
                                || string_array(&record["claim"]).is_some_and(|v| !v.is_empty()))
                            && record["type"]
                                .as_str()
                                .and_then(|name| types.get(name))
                                .is_some_and(|definition| {
                                    definition["p"] == record["p"]
                                        && string_array(&definition["roles"]).is_some_and(|roles| {
                                            roles
                                                .iter()
                                                .all(|role| record["args"].get(*role).is_some())
                                        })
                                })
                    }
                    _ => false,
                };
                if !common || !epistemic || !shape {
                    invalid.insert(id.to_owned());
                }
            }
        }
        invalid.extend(duplicates);
        // Closure: a remaining relation/narrative cannot reach an isolated node.
        loop {
            let before = invalid.len();
            for (id, (_, _, record)) in &records {
                if refs(record).iter().any(|reference| {
                    !(sources.contains_key(*reference) || records.contains_key(*reference))
                        || invalid.contains(*reference)
                }) {
                    invalid.insert(id.clone());
                }
                if record["ev"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter_map(|id| evidence.get(id))
                    .any(|(_, ev)| {
                        ev["speaker"].as_str().is_some_and(|speaker| {
                            !records.contains_key(speaker) || invalid.contains(speaker)
                        })
                    })
                {
                    invalid.insert(id.clone());
                }
            }
            if before == invalid.len() {
                break;
            }
        }
        let mut evidence_ids = BTreeMap::new();
        let producer = dataset["generated"]["by"].as_str().unwrap();
        // Import only evidence used by an eligible projected node/relation.
        let mut used = BTreeSet::new();
        for (id, (kind, _, record)) in &records {
            if !invalid.contains(id) && matches!(*kind, "entities" | "concepts" | "relations") {
                used.extend(
                    string_array(&record["ev"])
                        .unwrap_or_default()
                        .into_iter()
                        .map(str::to_owned),
                );
            }
        }
        for id in used {
            if let Some((index, ev)) = evidence.get(&id) {
                let ev_id = self.evidence(
                    path,
                    Locator {
                        start: 1,
                        end: 1,
                        json_pointer: Some(format!("/evidence/{index}")),
                        ..Locator::default()
                    },
                    ev["role"].as_str().unwrap_or("context"),
                    producer,
                    "imported_evidence",
                    "imported",
                );
                evidence_ids.insert(id, ev_id);
            }
        }
        let source_id = self.sources[path].id.clone();
        let mut projected = BTreeMap::new();
        let mut projected_records = 0;
        let mut not_projected: BTreeMap<&str, usize> = BTreeMap::new();
        for (id, (kind, index, record)) in &records {
            if invalid.contains(id) {
                continue;
            }
            if !matches!(*kind, "entities" | "concepts") {
                if *kind != "relations" {
                    *not_projected.entry(kind).or_default() += 1;
                }
                continue;
            }
            let label = record[if *kind == "entities" { "name" } else { "term" }]
                .as_str()
                .unwrap();
            let aliases = string_array(&record["aliases"])
                .unwrap_or_default()
                .into_iter()
                .map(str::to_owned)
                .collect();
            let mut ev: Vec<_> = string_array(&record["ev"])
                .unwrap()
                .into_iter()
                .filter_map(|id| evidence_ids.get(id).cloned())
                .collect();
            // This pointer preserves access to scope, epistemic basis, status,
            // conditions and limits without duplicating their original text.
            ev.push(self.evidence(
                path,
                Locator {
                    start: 1,
                    end: 1,
                    json_pointer: Some(format!("/{kind}/{index}")),
                    ..Locator::default()
                },
                "record",
                producer,
                "imported_record",
                "imported",
            ));
            let project = *kind == "entities" && record["type"] == "project";
            let node = self.add_node(
                format!("knowledge:{source_id}:{id}"),
                label.into(),
                if project {
                    "project"
                } else if *kind == "entities" {
                    "entity"
                } else {
                    "concept"
                },
                "imported",
                ev,
                aliases,
            );
            if project {
                self.nodes.get_mut(&node).unwrap().intent_status =
                    Some("imported_project_mention".into());
            }
            let mut features = vec![normalize(label)];
            features.extend(
                string_array(&record["aliases"])
                    .unwrap_or_default()
                    .into_iter()
                    .map(normalize),
            );
            features.retain(|s| !s.is_empty() && s.chars().count() <= 96);
            features.sort();
            features.dedup();
            features.truncate(24);
            self.features.insert(node.clone(), features);
            projected.insert(id.clone(), node);
            projected_records += 1;
        }
        for (id, (kind, index, record)) in &records {
            if *kind != "relations" || invalid.contains(id) {
                continue;
            }
            let roles = role_refs(&record["args"]).unwrap();
            if roles.iter().any(|(_, id)| !projected.contains_key(*id)) {
                *not_projected.entry("relations").or_default() += 1;
                continue;
            }
            let participants: Vec<_> = roles
                .iter()
                .map(|(role, id)| Participant {
                    node: projected[*id].clone(),
                    role: (*role).into(),
                })
                .collect();
            if participants
                .iter()
                .map(|p| &p.node)
                .collect::<BTreeSet<_>>()
                .len()
                < 2
            {
                *not_projected.entry("relations").or_default() += 1;
                continue;
            }
            let mut ev: Vec<_> = string_array(&record["ev"])
                .unwrap()
                .into_iter()
                .filter_map(|id| evidence_ids.get(id).cloned())
                .collect();
            ev.push(self.evidence(
                path,
                Locator {
                    start: 1,
                    end: 1,
                    json_pointer: Some(format!("/relations/{index}")),
                    ..Locator::default()
                },
                "record",
                producer,
                "imported_record",
                "imported",
            ));
            self.add_edge(
                record["type"].as_str().unwrap(),
                "imported",
                participants,
                ev,
            );
            projected_records += 1;
        }
        self.coverage.imported_records += projected_records;
        let unprojected: usize = not_projected.values().sum();
        self.coverage.unprojected_records += unprojected;
        self.coverage.isolated_records += total.saturating_sub(projected_records + unprojected);
        if !invalid.is_empty() || malformed_ids > 0 {
            self.diagnostic(
                "knowledge.isolated",
                path,
                &format!(
                    "{} 条记录及引用闭包无效，未投影",
                    invalid.len() + malformed_ids
                ),
            );
        }
        for (kind, count) in not_projected {
            self.diagnostic(
                "knowledge.unprojected",
                path,
                &format!("{count} 条 {kind} 保留在原知识文件；本版不投影该类型或参与者未完整投影"),
            );
        }
        let source_uris: Vec<_> = sources
            .values()
            .filter_map(|s| s["uri"].as_str())
            .map(str::to_owned)
            .collect();
        for uri in &source_uris {
            if resolve_path(path, uri).is_none_or(|p| !self.inputs.contains_key(&p)) {
                self.diagnostic(
                    "knowledge.source_unavailable",
                    path,
                    "会议知识声明的来源未包含在本次清单；未把导入记录标为原文核验通过",
                );
            }
        }
        self.documents.insert(
            path.into(),
            Document {
                sources: source_uris,
                ..Document::default()
            },
        );
    }
}
