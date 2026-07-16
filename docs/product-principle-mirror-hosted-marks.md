# Product principle: your marks belong to the vault, not to a path

Reading happens everywhere — Downloads, external drives, other tools' folders.
The moment you annotate, those marks are the most valuable signal you own, and
they must not be orphaned when a path changes: a different machine, a moved or
deleted original, a tool that reorganizes its folders.

So note.md **mirrors** the source into your vault at annotation time. The mirror
is a git-versioned, stable host for your marks; the original stays where it is,
and note.md keeps the mirror consistent with it. Your notes live in the vault —
durable, syncable, greppable — attached to a mirror that remembers where the
original came from, even when the original moves or you switch machines.

The mirror's mapping (which device, which original path, last sync, checksum)
is recorded in `{vault}/.notemd/mirrors/`, so it travels with the vault via git
instead of living on one machine. See
`docs/superpowers/specs/2026-07-16-mirror-hosted-marks-design.md`.
