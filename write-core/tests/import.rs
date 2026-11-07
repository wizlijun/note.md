use write_core::{
    import::{import_external, ImportOutcome},
    Document,
};
const PAGE: &str = "87d92d1a-f37d-46e8-b83e-dc3e671fb425";
fn base() -> Document {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "alpha\nbeta\ngamma", 10)
        .unwrap();
    d
}
#[test]
fn non_overlapping_external_change_preserves_live_edit_and_identity() {
    let mut d = base();
    let baseline = d.encode_full();
    let old = d.snapshot().unwrap();
    d.replace(d.revision(), 0, 1, "A", 20).unwrap();
    let outcome = import_external(&mut d, &baseline, "alpha\nbeta\nGAMMA", 30).unwrap();
    assert!(matches!(outcome, ImportOutcome::Applied { .. }));
    let s = d.snapshot().unwrap();
    assert_eq!(s.body, "Alpha\nbeta\nGAMMA");
    assert_eq!(s.lines[1], old.lines[1]);
    assert_eq!(s.lines[2].id, old.lines[2].id);
    assert_eq!(s.lines[2].first_ms, Some(10));
    assert_eq!(s.lines[2].last_ms, Some(30));
    assert_eq!(s.lines[2].time_source, "mixed");
}
#[test]
fn overlapping_and_repeated_context_are_preserved() {
    let mut d = base();
    let b = d.encode_full();
    d.replace(d.revision(), 0, 5, "LOCAL", 20).unwrap();
    let before = d.encode_full();
    assert!(matches!(
        import_external(&mut d, &b, "EXTERNAL\nbeta\ngamma", 30).unwrap(),
        ImportOutcome::Conflict { .. }
    ));
    assert_eq!(d.encode_full(), before);
    let mut x = Document::new(PAGE, 1, 2).unwrap();
    x.replace(x.revision(), 0, 0, "same\nsame", 1).unwrap();
    let b = x.encode_full();
    assert!(matches!(
        import_external(&mut x, &b, "same\nchanged", 2).unwrap(),
        ImportOutcome::Conflict { .. }
    ));
}
#[test]
fn matching_external_edit_is_not_inserted_twice() {
    let mut d = base();
    let b = d.encode_full();
    d.replace(d.revision(), 0, 0, "X", 20).unwrap();
    d.replace(d.revision(), d.body().len() as u32, 0, "Y", 21)
        .unwrap();
    assert!(matches!(
        import_external(&mut d, &b, "Xalpha\nbeta\ngamma", 30).unwrap(),
        ImportOutcome::Unchanged
    ));
    assert_eq!(d.body(), "Xalpha\nbeta\ngammaY");
}

#[test]
fn external_combining_character_and_emoji_changes_use_grapheme_boundaries() {
    let mut d = Document::new(PAGE, 1, 1).unwrap();
    d.replace(d.revision(), 0, 0, "a\u{301} 👩‍💻\nunchanged", 10)
        .unwrap();
    let b = d.encode_full();
    let old = d.snapshot().unwrap();
    assert!(matches!(
        import_external(&mut d, &b, "a\u{300} 👩‍🚀\nunchanged", 20).unwrap(),
        ImportOutcome::Applied { .. }
    ));
    let s = d.snapshot().unwrap();
    assert_eq!(s.body, "a\u{300} 👩‍🚀\nunchanged");
    assert_eq!(s.lines[1], old.lines[1]);
}

#[test]
fn source_save_is_local_undoable_and_preserves_concurrent_changes() {
    let mut d = base();
    let baseline = d.encode_full();
    let mut remote = Document::load(PAGE, 1, 2, &baseline).unwrap();
    let u = remote.replace(remote.revision(), 0, 1, "A", 20).unwrap();
    d.apply_remote(&u).unwrap();
    assert!(matches!(
        write_core::import::import_source(&mut d, &baseline, "alpha\nbeta\nGAMMA", 30).unwrap(),
        ImportOutcome::Applied { .. }
    ));
    assert_eq!(d.snapshot().unwrap().lines[2].time_source, "device");
    d.undo(40).unwrap();
    assert_eq!(d.body(), "Alpha\nbeta\ngamma");
    d.redo(50).unwrap();
    assert_eq!(d.body(), "Alpha\nbeta\nGAMMA");
    assert_eq!(d.snapshot().unwrap().lines[2].first_ms, Some(10));
}

#[test]
fn in_flight_source_draft_rebases_without_repeating_accepted_typing() {
    use write_core::import::{rebase_draft, DraftRebase::*};
    assert_eq!(rebase_draft("A", "AB", "AX"), Merged { text: "ABX".into() });
    assert_eq!(
        rebase_draft("a👩‍💻z", "a👩‍💻z!", "A👩‍💻z"),
        Merged {
            text: "A👩‍💻z!".into()
        }
    );
    assert_eq!(rebase_draft("A", "AB", "AB"), Merged { text: "AB".into() });
    assert!(matches!(rebase_draft("abc", "aBc", "aXc"), Conflict { .. }));
    assert!(matches!(rebase_draft("abc", "ac", "abXc"), Conflict { .. }));
}
