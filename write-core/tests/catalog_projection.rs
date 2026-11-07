use write_core::{catalog, projection, storage::{Store, FilePair}, Document};
use uuid::Uuid;

#[test]
fn empty_pages_get_a_filename_only_on_first_written_day_and_never_reuse_deleted_slots() {
    let temp=tempfile::tempdir().unwrap(); let mut store=Store::open(temp.path().join("state.db")).unwrap();
    store.transaction(|tx| {
        catalog::initialize(tx)?;
        let first=Uuid::new_v4().to_string();
        assert!(catalog::create(tx,&first,None)?.filename().is_none());
        assert_eq!(catalog::first_write(tx,&first,"2026-11-08")?.filename().unwrap(),"2026-11-08-01.writing.md");
        assert_eq!(catalog::first_write(tx,&first,"2026-11-09")?.local_date.as_deref(),Some("2026-11-08"));
        catalog::set_deleted(tx,&first,true)?;
        let mut last=None;
        for _ in 0..100 { let id=Uuid::new_v4().to_string(); catalog::create(tx,&id,last.as_deref())?; last=Some(id.clone()); catalog::first_write(tx,&id,"2026-11-08")?; }
        assert_eq!(catalog::get(tx,last.as_deref().unwrap())?.unwrap().filename().unwrap(),"2026-11-08-101.writing.md");
        Ok(())
    }).unwrap();
}

#[test]
fn server_filename_reassigns_only_provisional_collision_without_losing_local_delete() {
    let temp=tempfile::tempdir().unwrap(); let mut store=Store::open(temp.path().join("state.db")).unwrap();
    store.transaction(|tx| {
        catalog::initialize(tx)?;
        let a=Uuid::new_v4().to_string(); catalog::create(tx,&a,None)?;
        catalog::first_write(tx,&a,"2026-11-08")?; catalog::set_deleted(tx,&a,true)?;
        let b=catalog::Entry {id:Uuid::new_v4().to_string(),epoch:1,generation:0,deleted:false,local_date:Some("2026-11-08".into()),sequence:Some(1),after_id:None,registered:true};
        let changes=catalog::apply_remote(tx,&b)?;
        assert_eq!(changes.len(),2);
        assert_eq!(catalog::get(tx,&a)?.unwrap().sequence,Some(2));
        let mut stale=catalog::get(tx,&a)?.unwrap(); stale.generation=0; stale.deleted=false;
        catalog::apply_remote(tx,&stale)?;
        assert!(catalog::get(tx,&a)?.unwrap().deleted);
        Ok(())
    }).unwrap();
}

#[test]
fn failed_document_transaction_does_not_leave_directory_or_outbox_behind() {
    let temp=tempfile::tempdir().unwrap(); let mut store=Store::open(temp.path().join("state.db")).unwrap();
    store.transaction(catalog::initialize).unwrap();
    let id=Uuid::new_v4().to_string(); let doc=Document::new(&id,1,11).unwrap();
    let pair=write_core::storage::serialize_pair(&doc.snapshot().unwrap(),None,None).unwrap();
    assert!(store.commit_local_with(&doc,&Uuid::new_v4().to_string(),&doc.encode_full(),&pair,|tx| {
        catalog::create(tx,&id,None)?;
        Err(write_core::Error::Invalid("injected failure".into()))
    }).is_err());
    assert!(store.outbox().unwrap().is_empty());
    assert!(store.transaction(|tx|catalog::get(tx,&id)).unwrap().is_none());
    assert!(store.load(&id,12).is_err());
}

fn pair(text:&str)->FilePair { FilePair { markdown:text.into(),metadata:format!("metadata for {text}") } }

#[test]
fn interrupted_pair_write_can_resume_but_unrelated_files_are_never_overwritten() {
    let root=tempfile::tempdir().unwrap(); let filename="2026-11-08-01.writing.md"; let pair=pair("hello");
    let (md,meta)=projection::paths(root.path(),filename).unwrap();
    std::fs::write(&md,&pair.markdown).unwrap(); // crash after the first rename
    let baseline=projection::publish(root.path(),filename,&pair,&projection::Baseline::default()).unwrap();
    assert_eq!(std::fs::read_to_string(&meta).unwrap(),pair.metadata);
    std::fs::write(&md,"external author").unwrap();
    assert!(projection::publish(root.path(),filename,&self::pair("next"),&baseline).is_err());
    assert_eq!(std::fs::read_to_string(&md).unwrap(),"external author");
    assert_eq!(std::fs::read_to_string(&meta).unwrap(),pair.metadata);
}

#[test]
fn metadata_conflict_is_checked_before_any_markdown_write() {
    let root=tempfile::tempdir().unwrap(); let filename="2026-11-08-01.writing.md";
    let (md,meta)=projection::paths(root.path(),filename).unwrap();
    std::fs::write(&meta,"unrelated metadata").unwrap();
    assert!(projection::publish(root.path(),filename,&pair("hello"),&projection::Baseline::default()).is_err());
    assert!(!md.exists());
    assert!(projection::paths(root.path(),"../escape.writing.md").is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_writing_directory_cannot_escape_vault() {
    let root=tempfile::tempdir().unwrap(); let outside=tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(),root.path().join("inbox")).unwrap();
    assert!(projection::paths(root.path(),"2026-11-08-01.writing.md").is_err());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(),0);
}
