//! Durable paper directory. All mutations use the document store's transaction.
use crate::{Error, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

fn db(error: rusqlite::Error) -> Error { Error::Invalid(format!("catalog: {error}")) }
fn valid_id(id: &str) -> Result<()> {
    Uuid::parse_str(id).map(|_| ()).map_err(|_| Error::Invalid("page UUID".into()))
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub id: String,
    pub epoch: u32,
    pub generation: u64,
    pub deleted: bool,
    pub local_date: Option<String>,
    pub sequence: Option<u32>,
    pub after_id: Option<String>,
    pub registered: bool,
}
impl Entry {
    pub fn filename(&self) -> Option<String> {
        Some(format!("{}-{:02}.writing.md", self.local_date.as_ref()?, self.sequence?))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryOperation { pub op_id: String, pub page_id: String, pub kind: String, pub payload: Value }

pub fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS sumi_catalog (
      id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, generation INTEGER NOT NULL,
      deleted INTEGER NOT NULL, local_date TEXT, sequence INTEGER, after_id TEXT,
      registered INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS sumi_filename ON sumi_catalog(local_date,sequence);
      CREATE TABLE IF NOT EXISTS sumi_directory_outbox (
      op_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sumi_preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
      .map_err(db)
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry { id:r.get(0)?,epoch:r.get(1)?,generation:u64::try_from(r.get::<_,i64>(2)?).map_err(|_|rusqlite::Error::IntegralValueOutOfRange(2,-1))?,deleted:r.get(3)?,local_date:r.get(4)?,sequence:r.get(5)?,after_id:r.get(6)?,registered:r.get(7)? })
}
pub fn get(tx: &Transaction<'_>, id: &str) -> Result<Option<Entry>> {
    tx.query_row("SELECT id,epoch,generation,deleted,local_date,sequence,after_id,registered FROM sumi_catalog WHERE id=?1", [id], row).optional().map_err(db)
}
pub fn list(tx: &Transaction<'_>) -> Result<Vec<Entry>> {
    let mut statement = tx.prepare("SELECT id,epoch,generation,deleted,local_date,sequence,after_id,registered FROM sumi_catalog ORDER BY id").map_err(db)?;
    let entries = statement.query_map([], row).map_err(db)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db)?;
    // Traverse deleted anchors too: removal must not reorder their descendants.
    let mut ordered = Vec::with_capacity(entries.len());
    let mut visited = std::collections::HashSet::new();
    fn walk(parent: Option<&str>, entries: &[Entry], visited: &mut std::collections::HashSet<String>, ordered: &mut Vec<Entry>) {
        for entry in entries.iter().filter(|entry| entry.after_id.as_deref() == parent) {
            if visited.insert(entry.id.clone()) { ordered.push(entry.clone()); walk(Some(&entry.id), entries, visited, ordered) }
        }
    }
    walk(None, &entries, &mut visited, &mut ordered);
    // An incoming child can precede its anchor in a paginated directory transfer.
    // Keep it visible deterministically until the missing anchor arrives.
    for entry in &entries { if visited.insert(entry.id.clone()) { ordered.push(entry.clone()); walk(Some(&entry.id), &entries, &mut visited, &mut ordered) } }
    Ok(ordered)
}
fn enqueue(tx: &Transaction<'_>, id: &str, kind: &str, mut payload: Value) -> Result<String> {
    let op_id = Uuid::new_v4().to_string(); payload["opId"] = json!(op_id);
    tx.execute("INSERT INTO sumi_directory_outbox VALUES (?1,?2,?3,?4)", params![op_id,id,kind,serde_json::to_string(&payload)?]).map_err(db)?;
    Ok(op_id)
}
pub fn create(tx: &Transaction<'_>, id: &str, after: Option<&str>) -> Result<Entry> {
    valid_id(id)?;
    if let Some(anchor) = after { valid_id(anchor)?; if get(tx,anchor)?.is_none() { return Err(Error::Invalid("missing page anchor".into())) } }
    tx.execute("INSERT INTO sumi_catalog VALUES (?1,1,0,0,NULL,NULL,?2,0)", params![id,after]).map_err(db)?;
    enqueue(tx,id,"create",json!({"pageId":id,"localDate":null,"afterId":after}))?;
    Ok(get(tx,id)?.unwrap())
}
pub fn first_write(tx: &Transaction<'_>, id: &str, date: &str) -> Result<Entry> {
    if chrono::NaiveDate::parse_from_str(date,"%Y-%m-%d").map(|d| d.format("%Y-%m-%d").to_string()).ok().as_deref()!=Some(date) {
        return Err(Error::Invalid("invalid first-write date".into()));
    }
    let entry=get(tx,id)?.ok_or_else(|| Error::Invalid("missing page".into()))?;
    if entry.deleted { return Err(Error::Invalid("page is deleted".into())) }
    if entry.local_date.is_some() { return Ok(entry) }
    let sequence:u32=tx.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM sumi_catalog WHERE local_date=?1",[date],|r| r.get(0)).map_err(db)?;
    tx.execute("UPDATE sumi_catalog SET local_date=?1,sequence=?2 WHERE id=?3",params![date,sequence,id]).map_err(db)?;
    Ok(get(tx,id)?.unwrap())
}
pub fn set_deleted(tx: &Transaction<'_>, id: &str, deleted: bool) -> Result<Entry> {
    let entry=get(tx,id)?.ok_or_else(|| Error::Invalid("missing page".into()))?;
    if entry.deleted == deleted { return Ok(entry) }
    // Generation belongs to the server lifecycle; the request records the exact expected value.
    // Increment locally to make edits predating this transition distinguishable immediately.
    enqueue(tx,id,if deleted {"delete"} else {"restore"},json!({"generation":entry.generation}))?;
    tx.execute("UPDATE sumi_catalog SET deleted=?1,generation=generation+1 WHERE id=?2",params![deleted,id]).map_err(db)?;
    Ok(get(tx,id)?.unwrap())
}
pub fn pending(tx: &Transaction<'_>) -> Result<Vec<DirectoryOperation>> {
    let mut statement=tx.prepare("SELECT op_id,page_id,kind,payload FROM sumi_directory_outbox ORDER BY rowid").map_err(db)?;
    let rows=statement.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).map_err(db)?;
    let mut result=Vec::new();
    for row in rows { let (op_id,page_id,kind,payload)=row.map_err(db)?; result.push(DirectoryOperation{op_id,page_id,kind,payload:serde_json::from_str(&payload)?}) }
    Ok(result)
}
pub fn acknowledge(tx:&Transaction<'_>, op_id:&str) -> Result<()> {
    tx.execute("DELETE FROM sumi_directory_outbox WHERE op_id=?1",[op_id]).map_err(db)?; Ok(())
}
/// Merge server directory identity without discarding a pending local lifecycle action.
/// The caller must reproject every returned renamed page with its recorded disk baseline.
pub fn apply_remote(tx:&Transaction<'_>, remote:&Entry) -> Result<Vec<Entry>> {
    valid_id(&remote.id)?;
    if remote.epoch == 0 || remote.local_date.is_some() != remote.sequence.is_some() || remote.sequence == Some(0) {
        return Err(Error::Invalid("invalid remote directory entry".into()));
    }
    if let Some(date)=&remote.local_date {
        if chrono::NaiveDate::parse_from_str(date,"%Y-%m-%d").map(|d| d.format("%Y-%m-%d").to_string()).ok().as_ref()!=Some(date) {
            return Err(Error::Invalid("invalid remote date".into()));
        }
    }
    let prior=get(tx,&remote.id)?;
    if let Some(old)=&prior { if old.epoch != remote.epoch { return Err(Error::Invalid("epoch transition requires recovery".into())) } }
    let mut changed=Vec::new();
    if let (Some(date),Some(sequence))=(&remote.local_date,remote.sequence) {
        let conflict=tx.query_row("SELECT id,epoch,generation,deleted,local_date,sequence,after_id,registered FROM sumi_catalog WHERE local_date=?1 AND sequence=?2 AND id<>?3",params![date,sequence,remote.id],row).optional().map_err(db)?;
        if let Some(conflict)=conflict {
            if conflict.registered { return Err(Error::Invalid("server filename conflicts with an acknowledged page".into())); }
            let next:u32=tx.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM sumi_catalog WHERE local_date=?1",[date],|r|r.get(0)).map_err(db)?;
            tx.execute("UPDATE sumi_catalog SET sequence=?1 WHERE id=?2",params![next,conflict.id]).map_err(db)?;
            changed.push(get(tx,&conflict.id)?.unwrap());
        }
    }
    let pending_lifecycle:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sumi_directory_outbox WHERE page_id=?1 AND kind IN ('delete','restore'))",[&remote.id],|r|r.get(0)).map_err(db)?;
    let preserve=prior.as_ref().filter(|old| pending_lifecycle || old.generation>remote.generation);
    let deleted=preserve.map_or(remote.deleted,|old|old.deleted);
    let generation=preserve.map_or(remote.generation,|old|old.generation);
    // A server acknowledgement of an empty create must not erase the first local write
    // waiting in the content outbox. The first nonempty update will assign its final path.
    let local_date=remote.local_date.clone().or_else(||prior.as_ref().and_then(|old|old.local_date.clone()));
    let sequence=remote.sequence.or_else(||prior.as_ref().and_then(|old|old.sequence));
    let registered=remote.sequence.is_some();
    tx.execute("INSERT INTO sumi_catalog VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,deleted=excluded.deleted,local_date=excluded.local_date,sequence=excluded.sequence,after_id=excluded.after_id,registered=excluded.registered",params![remote.id,remote.epoch,i64::try_from(generation).map_err(|_|Error::Invalid("generation overflow".into()))?,deleted,local_date,sequence,remote.after_id,registered]).map_err(db)?;
    changed.push(get(tx,&remote.id)?.unwrap());
    Ok(changed)
}
pub fn remember(tx:&Transaction<'_>, key:&str, value:&Value) -> Result<()> {
    tx.execute("INSERT INTO sumi_preferences VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,serde_json::to_string(value)?]).map_err(db)?; Ok(())
}
pub fn recall(tx:&Transaction<'_>, key:&str) -> Result<Option<Value>> {
    tx.query_row("SELECT value FROM sumi_preferences WHERE key=?1",[key],|r| r.get::<_,String>(0)).optional().map_err(db)?.map(|s|serde_json::from_str(&s).map_err(Error::from)).transpose()
}
