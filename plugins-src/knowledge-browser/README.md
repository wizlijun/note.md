# Knowledge Browser

Knowledge Browser is a read-only note.md plugin for `knowledge-representation-dataset/3.1.0` JSON files produced by `relation-schema-extractor`. It supports extractor rules 3.1.0 and 3.1.1, and also opens paired 3.0.0 datasets as a legacy read-only format.

The plugin version follows the newest extractor rule it supports. Version 3.1.1 uses rule 3.1.1 as current while retaining explicit compatibility with rule 3.1.0 and paired legacy 3.0.0 files. Rule 3.1.1 adds diagnostics for speaker attribution, speech acts, independent corroboration, numeric precision and object-level limits.

Its menu always asks for a JSON file and opens the selection in the main editor's Knowledge Viewer. The viewer uses a deterministic parser, validation, search, relation, timeline, narrative and evidence-reading model. The plugin never writes a dataset or source file.

## Development

```bash
pnpm --filter knowledge-browser test
pnpm --filter knowledge-browser check
pnpm --filter knowledge-browser build
scripts/dev-install-plugin.sh knowledge-browser
```

The fixed schema and relation registry are stored in `references/` with their provenance record. Public marketplace publishing is a separate release action.
