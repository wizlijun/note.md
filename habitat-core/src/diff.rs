use crate::model::*;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub id: String,
    pub before: String,
    pub after: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub from: String,
    pub to: String,
    pub causes: Vec<String>,
    pub comparable: bool,
    pub warnings: Vec<String>,
    pub added: Vec<Node>,
    pub removed: Vec<Node>,
    pub renamed: Vec<Rename>,
    pub changed: Vec<Node>,
    pub edges_added: Vec<Edge>,
    pub edges_removed: Vec<Edge>,
    pub edges_changed: Vec<Edge>,
    pub membership_changes: usize,
    pub layout_changes: usize,
}
/// Raw capture identity is independent of parser output, source-family
/// grouping, availability flags and evidence locators.
pub fn material_changed(before: &Snapshot, after: &Snapshot) -> bool {
    fn manifest(snapshot: &Snapshot) -> BTreeMap<&str, &str> {
        snapshot
            .sources
            .iter()
            .map(|source| (source.path.as_str(), source.hash.as_str()))
            .collect()
    }
    manifest(before) != manifest(after)
}

pub fn compare(before: &Snapshot, after: &Snapshot) -> Result<Diff, String> {
    if before.meta.vault_id != after.meta.vault_id {
        return Err("不能比较不同 Vault 的结构".into());
    }
    let mut out = Diff {
        from: before.meta.snapshot_id.clone(),
        to: after.meta.snapshot_id.clone(),
        causes: vec![],
        comparable: true,
        warnings: vec![],
        added: vec![],
        removed: vec![],
        renamed: vec![],
        changed: vec![],
        edges_added: vec![],
        edges_removed: vec![],
        edges_changed: vec![],
        membership_changes: 0,
        layout_changes: 0,
    };
    let algorithm = before.meta.algorithm != after.meta.algorithm;
    let scope = before.meta.scope_hash != after.meta.scope_hash;
    let evidence = before.meta.evidence_hash != after.meta.evidence_hash
        || before.meta.manifest_hash != after.meta.manifest_hash;
    if algorithm {
        out.causes.push("algorithm".into());
        out.warnings
            .push("分析方法发生变化，新增对象不能直接解释为知识增长。".into());
    }
    if scope {
        out.causes.push("scope".into());
        out.warnings
            .push("分析范围变化，两版不作同口径增长比较。".into());
    }
    if evidence {
        out.causes.push("evidence".into());
    }
    if algorithm && material_changed(before, after) {
        out.causes.push("mixed".into());
        out.warnings
            .push("方法和材料同时改变，未做对照重算，不能单独归因。".into());
    }
    out.comparable = !algorithm && !scope;
    if before.meta.coverage.unavailable > 0 || after.meta.coverage.unavailable > 0 {
        out.warnings
            .push("存在未读取的来源；列表中的缺失不代表概念消失或被遗忘。".into());
        out.comparable = false;
    }
    let old: BTreeMap<_, _> = before.nodes.iter().map(|n| (&n.id, n)).collect();
    let new: BTreeMap<_, _> = after.nodes.iter().map(|n| (&n.id, n)).collect();
    for (id, n) in &new {
        match old.get(id) {
            None => out.added.push((*n).clone()),
            Some(prior) => {
                if prior.label != n.label {
                    out.renamed.push(Rename {
                        id: (*id).clone(),
                        before: prior.label.clone(),
                        after: n.label.clone(),
                    });
                }
                let mut copy = (*prior).clone();
                copy.label = n.label.clone();
                if &copy != *n {
                    out.changed.push((*n).clone());
                }
            }
        }
    }
    for (id, n) in &old {
        if !new.contains_key(id) {
            out.removed.push((*n).clone());
        }
    }
    let old: BTreeMap<_, _> = before.edges.iter().map(|e| (&e.id, e)).collect();
    let new: BTreeMap<_, _> = after.edges.iter().map(|e| (&e.id, e)).collect();
    for (id, e) in &new {
        match old.get(id) {
            None => out.edges_added.push((*e).clone()),
            Some(prior) if prior != e => out.edges_changed.push((*e).clone()),
            _ => {}
        }
    }
    for (id, e) in &old {
        if !new.contains_key(id) {
            out.edges_removed.push((*e).clone());
        }
    }
    out.membership_changes = changed_records(
        before.memberships.iter().map(|v| (&v.id, v)),
        after.memberships.iter().map(|v| (&v.id, v)),
    );
    out.layout_changes = changed_records(
        before.layout.iter().map(|v| (&v.id, v)),
        after.layout.iter().map(|v| (&v.id, v)),
    );
    if before.meta.structure_hash != after.meta.structure_hash {
        out.causes.push("structure".into());
    }
    if out.layout_changes > 0 {
        out.causes.push("layout".into());
    }
    Ok(out)
}
fn changed_records<'a, T: PartialEq + 'a>(
    a: impl Iterator<Item = (&'a String, &'a T)>,
    b: impl Iterator<Item = (&'a String, &'a T)>,
) -> usize {
    let a: BTreeMap<_, _> = a.collect();
    let b: BTreeMap<_, _> = b.collect();
    a.iter().filter(|(id, v)| b.get(*id) != Some(v)).count()
        + b.keys().filter(|id| !a.contains_key(*id)).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{finalize, hash};
    fn base() -> Snapshot {
        let mut s = Snapshot::default();
        s.meta.vault_id = "v".into();
        s.meta.scope_hash = hash("scope");
        s.meta.algorithm.version = "v1".into();
        s.nodes.push(Node {
            id: "n".into(),
            key: "k".into(),
            node_type: "concept".into(),
            label: "旧名".into(),
            status: "candidate".into(),
            ..Default::default()
        });
        finalize(&mut s, None).unwrap();
        s
    }
    #[test]
    fn rename_does_not_create_or_remove() {
        let a = base();
        let mut b = a.clone();
        b.nodes[0].label = "新名".into();
        finalize(&mut b, Some(&a)).unwrap();
        let d = compare(&a, &b).unwrap();
        assert_eq!(d.renamed.len(), 1);
        assert!(d.added.is_empty() && d.removed.is_empty());
    }
    #[test]
    fn method_or_missing_sources_is_not_comparable_growth() {
        let a = base();
        let mut b = a.clone();
        b.meta.algorithm.version = "v2".into();
        finalize(&mut b, Some(&a)).unwrap();
        assert!(!compare(&a, &b).unwrap().comparable);
        b.meta.algorithm = a.meta.algorithm.clone();
        b.meta.coverage.unavailable = 1;
        finalize(&mut b, Some(&a)).unwrap();
        assert!(!compare(&a, &b).unwrap().comparable);
    }
    #[test]
    fn parser_and_evidence_changes_do_not_claim_raw_material_changed() {
        let mut a = base();
        a.sources.push(Source {
            id: "s".into(),
            path: "note.md".into(),
            hash: hash("same source body"),
            family: "f".into(),
            status: "available".into(),
            ..Default::default()
        });
        a.evidence.push(Evidence {
            id: "e".into(),
            source: "s".into(),
            locator: Locator {
                start: 1,
                end: 1,
                ..Default::default()
            },
            ..Default::default()
        });
        a.nodes[0].evidence.push("e".into());
        finalize(&mut a, None).unwrap();
        let mut b = a.clone();
        b.meta.algorithm.parser_version = "parser/2".into();
        b.evidence[0].locator.end = 2;
        b.sources[0].family = "reclassified-family".into();
        b.sources[0].family_status = "verified".into();
        finalize(&mut b, Some(&a)).unwrap();
        let d = compare(&a, &b).unwrap();
        assert!(!material_changed(&a, &b));
        assert!(d.causes.contains(&"algorithm".into()));
        assert!(d.causes.contains(&"evidence".into()));
        assert!(!d.causes.contains(&"mixed".into()));
        assert!(!d
            .warnings
            .iter()
            .any(|warning| warning.contains("材料同时改变")));
        b.sources[0].hash = hash("changed source body");
        finalize(&mut b, Some(&a)).unwrap();
        assert!(material_changed(&a, &b));
        assert!(compare(&a, &b).unwrap().causes.contains(&"mixed".into()));
    }
}
