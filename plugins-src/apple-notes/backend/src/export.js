// Public Notes Apple Events dictionary only. No private database or UI scripting.
function run(argv) {
    if (argv.length !== 1) throw new Error("An attachment staging directory is required");
    var app = Application("Notes");
    var staging = argv[0];
    var warnings = [];
    var complete = true;

    function warn(message) {
        complete = false;
        if (warnings.indexOf(message) < 0) warnings.push(message);
    }
    function date(value) {
        return value.toISOString();
    }
    function folderPath(note, accountId) {
        var path = [];
        var seen = {};
        var container = note.container();
        while (String(container.id()) !== accountId) {
            var id = String(container.id());
            if (seen[id] || path.length >= 100) throw new Error("Invalid folder hierarchy");
            seen[id] = true;
            path.unshift({id: id, name: String(container.name())});
            container = container.container();
        }
        return path;
    }
    function inventory() {
        var accounts = [];
        var notes = [];
        var refs = {};
        var seen = {};
        var sourceAccounts = app.accounts();
        for (var i = 0; i < sourceAccounts.length; i++) {
            var account = sourceAccounts[i];
            var accountId = String(account.id());
            accounts.push({id: accountId, name: String(account.name())});
            // account.notes includes notes in all its folders. Resolve each note's
            // container instead of assuming account.folders is a flat or nested list.
            var sourceNotes = account.notes();
            for (var j = 0; j < sourceNotes.length; j++) {
                var note = sourceNotes[j];
                var id = String(note.id());
                var metadata = {
                    id: id,
                    title: String(note.name()),
                    account_id: accountId,
                    folders: folderPath(note, accountId),
                    created_at: date(note.creationDate()),
                    modified_at: date(note.modificationDate()),
                    locked: Boolean(note.passwordProtected())
                };
                // Notes can expose the same object more than once. Identical
                // references are one note; conflicting identities are unsafe.
                if (seen[id]) {
                    if (seen[id] !== JSON.stringify(metadata)) throw new Error("Conflicting note identity");
                    continue;
                }
                seen[id] = JSON.stringify(metadata);
                notes.push(metadata);
                refs[id] = note;
            }
        }
        // Cross-check the global collection to catch disappearing accounts and
        // incomplete enumeration. A failure aborts instead of becoming empty data.
        var globalSeen = {};
        var globalIds = app.notes.id().map(String).filter(function(id) {
            if (globalSeen[id]) return false;
            globalSeen[id] = true;
            return true;
        }).sort();
        var accountIds = notes.map(function(note) { return note.id; }).sort();
        if (JSON.stringify(globalIds) !== JSON.stringify(accountIds)) {
            throw new Error("Notes inventory changed during enumeration");
        }
        accounts.sort(function(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
        notes.sort(function(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
        return {accounts: accounts, notes: notes, refs: refs};
    }
    function signature(value) {
        return JSON.stringify({accounts: value.accounts, notes: value.notes});
    }
    function safeName(name) {
        // Staging names are ASCII and byte-bounded; the original display name is
        // retained separately, including Unicode and the original extension.
        var result = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
        return (result || "attachment").slice(-120);
    }
    var before = inventory();
    var beforeSignature = signature(before);
    var exported = [];
    for (var i = 0; i < before.notes.length; i++) {
        var metadata = before.notes[i];
        var source = before.refs[metadata.id];
        // Clone so the inventory signature never includes exported content.
        var note = JSON.parse(JSON.stringify(metadata));
        note.html = "";
        note.attachments = [];
        if (!note.locked) {
            try {
                note.html = String(source.body());
                var attachments = source.attachments();
                for (var j = 0; j < attachments.length; j++) {
                    var sourceAttachment = attachments[j];
                    var attachment = {
                        id: String(sourceAttachment.id()),
                        name: String(sourceAttachment.name() || "attachment"),
                        content_id: String(sourceAttachment.contentIdentifier() || ""),
                        relative_path: null,
                        url: null
                    };
                    var url = sourceAttachment.url();
                    if (url) attachment.url = String(url);
                    if (!attachment.url) {
                        var relative = "note-" + i + "-attachment-" + j + "-" + safeName(attachment.name);
                        try {
                            app.save(sourceAttachment, {in: Path(staging + "/" + relative)});
                            attachment.relative_path = relative;
                        } catch (error) {
                            // An unsupported attachment does not make the note
                            // inventory incomplete. Keep its identity so the sync
                            // engine can preserve an earlier export or a placeholder.
                            var code = typeof error.errorNumber === "number" ? " (Notes error " + error.errorNumber + ")" : "";
                            var message = "Attachment " + attachment.id + " in note " + note.id + " could not be exported by the Notes interface" + code + "; any existing copy will be preserved";
                            if (warnings.indexOf(message) < 0) warnings.push(message);
                        }
                    }
                    note.attachments.push(attachment);
                }
                exported.push(note);
            } catch (error) {
                warn("Some notes could not be read completely; their existing copies were preserved and deletion was skipped");
            }
        } else {
            exported.push(note);
        }
    }
    try {
        if (beforeSignature !== signature(inventory())) {
            warn("Apple Notes changed during export; deletion was skipped. Run sync again");
        }
    } catch (error) {
        warn("Apple Notes could not be rechecked after export; deletion was skipped");
    }
    return JSON.stringify({accounts: before.accounts, notes: exported, complete: complete, warnings: warnings});
}
