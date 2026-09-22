# Knowledge Browser

Knowledge Browser is a read-only note.md plugin for `knowledge-representation-dataset/3.1.0` JSON files produced by `relation-schema-extractor`. It supports extractor rules 3.1.0 and 3.1.1, and also opens paired 3.0.0 datasets as a legacy read-only format.

Plugin and extractor versions advance independently. Knowledge Browser 3.2.0 adds the graph experience while continuing to use extractor rule 3.1.1 as current, with explicit compatibility for rule 3.1.0 and paired legacy 3.0.0 files. Rule 3.1.1 adds diagnostics for speaker attribution, speech acts, independent corroboration, numeric precision and object-level limits.

Knowledge Browser 3.2.0 requires note.md 6.916.1 or later. It is a universal
UI plugin and is available on both macOS and Windows when the host requirement
is met.

Its menu always asks for a JSON file and opens the selection in the main editor's Knowledge Viewer. The viewer uses a deterministic parser, validation, search, an interactive multi-type knowledge graph, relation groups, timeline, narrative and evidence-reading model. The plugin never writes a dataset or source file.

## Development

```bash
pnpm --filter knowledge-browser test
pnpm --filter knowledge-browser check
pnpm --filter knowledge-browser build
scripts/dev-install-plugin.sh knowledge-browser
```

The fixed schema and relation registry are stored in `references/` with their provenance record. Public marketplace publishing is a separate release action.

The release package includes `THIRD_PARTY_LICENSES.txt` for the bundled Cytoscape.js graph renderer.
