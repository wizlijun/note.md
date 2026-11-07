//! External Markdown is a three-way import against the last published CRDT baseline.
//! Ambiguous overlaps are returned intact rather than converted into a whole-document replacement.
use crate::{Document, Error, Result};
use similar::{ChangeTag, DiffTag, TextDiff};
use std::{collections::HashMap, ops::Range, time::Duration};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug)]
pub enum ImportOutcome {
    Unchanged,
    Applied {
        update: Vec<u8>,
    },
    Conflict {
        baseline: String,
        current: String,
        external: String,
        reason: &'static str,
    },
}
#[derive(Debug, Clone, PartialEq)]
struct Edit {
    old: Range<usize>,
    text: String,
}
fn edits(old: &str, new: &str) -> Vec<Edit> {
    let diff = TextDiff::configure()
        .timeout(Duration::from_millis(100))
        .diff_graphemes(old, new);
    diff.ops()
        .iter()
        .filter(|op| op.tag() != DiffTag::Equal)
        .map(|op| Edit {
            old: op.old_range(),
            text: diff
                .iter_changes(op)
                .filter(|c| c.tag() != ChangeTag::Delete)
                .map(|c| c.value())
                .collect(),
        })
        .collect()
}
fn overlaps(a: &Range<usize>, b: &Range<usize>) -> bool {
    if a.is_empty() && b.is_empty() {
        a.start == b.start
    } else if a.is_empty() {
        b.start <= a.start && a.start <= b.end
    } else if b.is_empty() {
        a.start <= b.start && b.start <= a.end
    } else {
        a.start < b.end && b.start < a.end
    }
}
pub fn import_external(
    current: &mut Document,
    baseline_state: &[u8],
    external: &str,
    at_ms: i64,
) -> Result<ImportOutcome> {
    merge_text(current, baseline_state, external, at_ms, false)
}
/// Same conservative three-way merge, with device provenance and local undo.
pub fn import_source(
    current: &mut Document,
    baseline_state: &[u8],
    source: &str,
    at_ms: i64,
) -> Result<ImportOutcome> {
    merge_text(current, baseline_state, source, at_ms, true)
}
fn merge_text(
    current: &mut Document,
    baseline_state: &[u8],
    external: &str,
    at_ms: i64,
    local: bool,
) -> Result<ImportOutcome> {
    if external.contains('\r') {
        return Err(Error::Invalid(
            "normalize external CRLF explicitly before import".into(),
        ));
    }
    let current_snapshot = current.snapshot()?;
    let mut baseline = Document::load(
        &current_snapshot.page_id,
        current_snapshot.epoch,
        current.fresh_client_id(),
        baseline_state,
    )?;
    let old = baseline.body();
    let now = current_snapshot.body;
    if old == external || now == external {
        return Ok(ImportOutcome::Unchanged);
    }
    let mut changes = edits(&old, external);
    let concurrent = edits(&old, &now);
    changes.retain(|e| !concurrent.contains(e));
    if changes.is_empty() {
        return Ok(ImportOutcome::Unchanged);
    }
    if changes
        .iter()
        .any(|a| concurrent.iter().any(|b| overlaps(&a.old, &b.old)))
    {
        return Ok(ImportOutcome::Conflict {
            baseline: old,
            current: now,
            external: external.into(),
            reason: "overlapping external and live edits",
        });
    }
    let mut counts = HashMap::new();
    for line in old.split('\n').filter(|s| !s.is_empty()) {
        *counts.entry(line).or_insert(0usize) += 1;
    }
    let mut line_at = 0;
    for line in old.split('\n') {
        let end = line_at + line.graphemes(true).count();
        if counts.get(line).copied().unwrap_or(0) > 1
            && changes.iter().any(|e| overlaps(&e.old, &(line_at..end)))
        {
            return Ok(ImportOutcome::Conflict {
                baseline: old,
                current: now,
                external: external.into(),
                reason: "repeated source lines have ambiguous identity",
            });
        }
        line_at = end + 1;
    }
    let vector = baseline.state_vector();
    let mut utf16 = vec![0u32];
    for g in old.graphemes(true) {
        utf16.push(utf16.last().unwrap() + g.encode_utf16().count() as u32);
    }
    for edit in changes.into_iter().rev() {
        baseline.replace_from_source(
            baseline.revision(),
            utf16[edit.old.start],
            utf16[edit.old.end] - utf16[edit.old.start],
            &edit.text,
            at_ms,
            if local { "device" } else { "import" },
        )?;
    }
    let update = baseline.encode_update(&vector)?;
    if local {
        current.apply_source_update(&update)?;
    } else {
        current.apply_remote(&update)?;
    }
    Ok(ImportOutcome::Applied { update })
}

/// Rebase typing performed while a source save was in flight onto its accepted
/// result. Callers bind the returned text to the accepted revision only on Merge.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DraftRebase {
    Merged {
        text: String,
    },
    Conflict {
        submitted: String,
        accepted: String,
        draft: String,
    },
}
pub fn rebase_draft(submitted: &str, accepted: &str, draft: &str) -> DraftRebase {
    let accepted_edits = edits(submitted, accepted);
    let mut draft_edits = edits(submitted, draft);
    draft_edits.retain(|e| !accepted_edits.contains(e));
    if draft_edits.iter().any(|a| {
        accepted_edits
            .iter()
            .any(|b| overlaps(&a.old, &b.old) && !(a.old.is_empty() && b.old.is_empty()))
    }) {
        return DraftRebase::Conflict {
            submitted: submitted.into(),
            accepted: accepted.into(),
            draft: draft.into(),
        };
    }
    let source: Vec<_> = submitted.graphemes(true).collect();
    // Accepted inserts precede in-flight draft inserts at the same boundary.
    // Both survive; identical complete edits were deduplicated above.
    let mut all: Vec<_> = accepted_edits
        .into_iter()
        .map(|e| (e, 0))
        .chain(draft_edits.into_iter().map(|e| (e, 1)))
        .collect();
    all.sort_by_key(|(e, side)| (e.old.start, *side));
    let mut text = String::new();
    let mut cursor = 0;
    for (edit, _) in all {
        text.extend(source[cursor..edit.old.start].iter().copied());
        text.push_str(&edit.text);
        cursor = edit.old.end;
    }
    text.extend(source[cursor..].iter().copied());
    DraftRebase::Merged { text }
}
