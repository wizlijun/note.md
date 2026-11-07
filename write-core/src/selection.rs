//! Small, versioned local preferences. Anchors never carry document state and
//! cannot be interpreted in a different page/epoch or reconstructed CRDT root.
use super::{Document, Error, Result};
use serde::{Deserialize, Serialize};
use yrs::{Assoc, IndexScope, Map, ReadTxn, StickyIndex, Transact, ID};

const MAX_ENCODED_SELECTION: usize = 1024;

/// Stable source positions; serialize only through the owning Document.
#[derive(Clone, Debug)]
pub struct SelectionAnchor {
    pub(super) page_id: String,
    pub(super) epoch: u32,
    pub(super) root_line_id: String,
    pub(super) start: StickyIndex,
    pub(super) end: StickyIndex,
    pub(super) collapsed: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSelection {
    schema: u32,
    page_id: String,
    epoch: u32,
    root_line_id: String,
    start: Position,
    end: Position,
    collapsed: bool,
}

// Do not deserialize Yrs StickyIndex directly: its permissive map decoder can
// accept multiple scope fields. This protocol has exactly one scope, and a root
// position can only refer to the canonical body (never page/timing/nested types).
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Position {
    Body {
        before: bool,
    },
    Item {
        client: u32,
        clock: u32,
        before: bool,
    },
}
impl Position {
    fn from_index(index: &StickyIndex) -> Result<Self> {
        let before = index.assoc == Assoc::Before;
        match index.scope() {
            IndexScope::Root(name) if name.as_ref() == "body" => Ok(Self::Body { before }),
            IndexScope::Relative(id) => Ok(Self::Item {
                client: u32::try_from(id.client).map_err(|_| Error::InvalidOffset)?,
                clock: id.clock,
                before,
            }),
            _ => Err(Error::InvalidOffset),
        }
    }
    fn into_index(self) -> StickyIndex {
        let (scope, before) = match self {
            Self::Body { before } => (IndexScope::Root("body".into()), before),
            Self::Item {
                client,
                clock,
                before,
            } => (IndexScope::Relative(ID::new(client.into(), clock)), before),
        };
        StickyIndex::new(scope, if before { Assoc::Before } else { Assoc::After })
    }
}

impl Document {
    pub(super) fn selection_root<T: ReadTxn>(&self, txn: &T) -> Result<String> {
        self.page
            .get(txn, "root_line_id")
            .map(|value| value.to_string(txn))
            .ok_or_else(|| Error::Invalid("selection root missing".into()))
    }
    pub(super) fn check_selection_identity<T: ReadTxn>(
        &self,
        anchor: &SelectionAnchor,
        txn: &T,
    ) -> Result<()> {
        if anchor.page_id != self.page_id
            || anchor.epoch != self.epoch
            || anchor.root_line_id != self.selection_root(txn)?
        {
            return Err(Error::Invalid(
                "selection belongs to a different page, epoch or CRDT root".into(),
            ));
        }
        Ok(())
    }

    /// Serialize a trusted anchor into a bounded preference, without walking the
    /// body or encoding a CRDT snapshot. Existing anchors remain valid after edits.
    pub fn serialize_selection(&self, anchor: &SelectionAnchor) -> Result<Vec<u8>> {
        self.check_selection_identity(anchor, &self.doc.transact())?;
        let encoded = serde_json::to_vec(&StoredSelection {
            schema: 1,
            page_id: anchor.page_id.clone(),
            epoch: anchor.epoch,
            root_line_id: anchor.root_line_id.clone(),
            start: Position::from_index(&anchor.start)?,
            end: Position::from_index(&anchor.end)?,
            collapsed: anchor.collapsed,
        })?;
        if encoded.len() > MAX_ENCODED_SELECTION {
            return Err(Error::Capacity);
        }
        Ok(encoded)
    }

    /// Decode only for this causal document. Unknown item dependencies return
    /// InvalidOffset: retain the bytes and retry after the document catches up.
    /// A decoded anchor is guaranteed to reference body positions, not a map.
    pub fn deserialize_selection(&self, encoded: &[u8]) -> Result<SelectionAnchor> {
        if encoded.len() > MAX_ENCODED_SELECTION {
            return Err(Error::Capacity);
        }
        let stored: StoredSelection = serde_json::from_slice(encoded)?;
        if stored.schema != 1 {
            return Err(Error::Invalid("selection schema".into()));
        }
        let anchor = SelectionAnchor {
            page_id: stored.page_id,
            epoch: stored.epoch,
            root_line_id: stored.root_line_id,
            start: stored.start.into_index(),
            end: stored.end.into_index(),
            collapsed: stored.collapsed,
        };
        let txn = self.doc.transact();
        self.check_selection_identity(&anchor, &txn)?;
        if anchor.start.assoc != Assoc::After
            || (anchor.collapsed && anchor.start != anchor.end)
            || (!anchor.collapsed && anchor.end.assoc != Assoc::Before)
        {
            return Err(Error::InvalidOffset);
        }
        for position in [&anchor.start, &anchor.end] {
            let resolved = position.get_offset(&txn).ok_or(Error::InvalidOffset)?;
            if !std::ptr::eq(&*resolved.branch, self.body.as_ref()) {
                return Err(Error::InvalidOffset);
            }
        }
        Ok(anchor)
    }
}
