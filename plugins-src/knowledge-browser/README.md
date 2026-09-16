# Knowledge Browser

Knowledge Browser is a read-only note.md plugin for the current `knowledge-representation-dataset/3.1.0` JSON files produced by `relation-schema-extractor`. It also opens paired 3.0.0 datasets as a legacy read-only format.

The plugin version follows the newest dataset format it supports. Version 3.1.0 therefore denotes current 3.1.0 format support, while retaining explicit 3.0.0 compatibility.

Its menu always asks for a JSON file and opens the selection in the main editor's Knowledge Viewer. The viewer uses a deterministic parser, validation, search, relation, timeline, narrative and evidence-reading model. The plugin never writes a dataset or source file.

## Development

```bash
pnpm --filter knowledge-browser test
pnpm --filter knowledge-browser check
pnpm --filter knowledge-browser build
scripts/dev-install-plugin.sh knowledge-browser
```

The fixed schema and relation registry are stored in `references/` with their provenance record. Public marketplace publishing is a separate release action.
