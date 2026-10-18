# Pele Reversible Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task, with scoped reviews.

**Goal:** Add a fully reversible Pele build while keeping existing Mermaid code and default behavior.
**Architecture:** Build-time selection across desktop, export and isolated share resources. CORE stays renderer-agnostic, adding opt-in width context only.
**Tech Stack:** TypeScript, Svelte5, ProseMirror, Vite6, Vitest4, Pele1.6.0, DOMPurify.
**Spec:** docs/superpowers/specs/2026-10-18-pele-reversible-build-design.md

## Global Constraints

- Only build switch VITE_DIAGRAM_RENDERER=pele; unset/mermaid is old engine. Unknown nonempty values fail build. No settings UI/persistence, no automatic fallback.
- Preserve CORE src/plugins/mermaid-renderer.ts, host legacy mermaidPlugin, src/share-editor/mermaid.ts and existing Mermaid dependencies. No Markdown/data/version/release change.
- Optional supportsResponsiveLayout and width context; old renderer is one-argument/no ResizeObserver. Pure SVG string ownership stays NodeView, never mount().
- Same engine in all three host rendering paths; independent share IIFE same registration/manifest/SRI/CSP contract. No Pele in main share editor IIFE.
- Pele1.6.0 exact pin, images disabled before render, trusted options only, no external resources or unsafe-eval, independent SVG theme/export, old share security retained.
- No worktree, preserve original7untracked; scope commits exactly, no pushing/publishing. Save tests/reports in this plan scratch and archive before deleting scratch.

### Task 1: CORE opt-in responsive diagram contract

**Files:** ../moraya-core/src/types.ts; src/plugins/code-block-view.ts; new src/__tests__/mermaid-responsive.spec.ts; build-generated dist, CHANGELOG.md entry if existing convention.
**Interfaces:** Produces MermaidApi.renderMermaid(code:string, options?:{maxWidth?:number}), optional supportsResponsiveLayout?:boolean. Existing old renderer module remains byte-identical.

- [ ] Add behavior tests using real NodeView and a controlled ResizeObserver: old loader single arg/no observer; opt-in receives positive content width, same width/height-only/zero ignored; 0-to-visible renders; resize invalidates pending old width; theme/re-edit/reconnect/destroy preserve lifecycle.
```ts
expect(legacyRender).toHaveBeenCalledWith(source)
expect(responsiveRender).toHaveBeenLastCalledWith(source, { maxWidth: 320 })
expect(root.textContent).not.toContain('stale-width')
```
- [ ] Run focused tests and record expected RED, implement optional contract and width observer/cache invalidation with current generation/debounce; disconnect on edit/leave/destroy. Hidden initial 0 waits for valid width for opt-in; legacy remains unchanged.
- [ ] Run new tests plus mermaid-loader.spec.ts and mermaid-theme-observer.spec.ts; typecheck/build CORE. Compare legacy renderer source with baseline; commit only own source/test/generated-dist/changelog. Report exact commands/counts and commit.

### Task 2: Shared Pele SVG engine

**Files:** package.json, pnpm-lock.yaml; new src/lib/diagrams/pele-renderer.ts and pele-renderer.test.ts; THIRD_PARTY_NOTICES entry if established path, otherwise adjacent README or docs note.
**Interfaces:** export renderPeleSvg(code:string, options?:PeleRenderOptions):string. Export PeleRenderOptions with maxWidth?:number, appearance?:{theme:'default'|'dark',themeVariables:{primaryColor:string,primaryTextColor:string,primaryBorderColor:string,lineColor:string,secondaryColor:string,tertiaryColor:string}}, links?:boolean. Default links false, images always false. Shared module no Tauri/settings dependencies.

- [ ] Pin dependency with pnpm add --save-exact pele@1.6.0, inspect lock diff; no unrelated dependency upgrades. Add real Pele tests: source fixture, Chinese flowchart/quadrant/C4, style, syntax error, wide/narrow, source limit, unsafe href/image/CSS suppression, root self-contained theme colors for detached SVG and dark background. Tests must fail before module implementation.
```ts
const wide = renderPeleSvg(code,{maxWidth:800})
const narrow = renderPeleSvg(code,{maxWidth:320})
expect(narrow).not.toBe(wide)
expect(renderPeleSvg(source,{appearance:dark})).toContain('--pele-fg:')
```
- [ ] Implement minimal render→SVG DOMPurify/filter pipeline; frozen root palette with background, safe SVG references/IDs; no mount/observers/stateful global renderer queue. Keep errors thrown to caller, never interpolate unsafe error HTML.
- [ ] Run focused tests/typecheck as applicable, ensure no host unsafe imports or legacy-source changes. Commit own files only, report RED/GREEN/output/source boundaries.

### Task 3: Build selection and all host paths

**Files:** src/lib/adapters/mermaid-loader.ts; renderer-registry.ts; new src/lib/adapters/pele-loader.ts; src/share-editor/contract.ts and mermaid-loader.ts; new src/share-editor/pele.ts; scripts/build-share-editor.mjs, check-share-editor-build.mjs, new scripts/diagram-renderer-option.mjs; vite.config.ts; covering existing/new tests; bilingual CHANGELOG/docs.
**Interfaces:** consumes Task1 width capability and Task2 renderPeleSvg. Share module optional supportsResponsiveLayout?:boolean and render(code,appearance,options?:{maxWidth?:number}) returns Promise<string>; old module stays unchanged.

- [ ] Tests RED: unset/default/explicit mermaid original identity; Pele chooses new adapter and never loads old; unknown build selector fails; static renderer Pele output self-contained; share loader forwards width/capability only when supported; old two-param calls unchanged. Existing original share .ts file never modified.
- [ ] Add host selector branches with compile-time import.meta.env.VITE_DIAGRAM_RENDERER and validated build process env. New desktop adapter returns current theme SVG, opts into width. Export registry keeps old implementation body and uses new separate plugin only for Pele. Share build chooses src/share-editor/mermaid.ts or pele.ts, applies shareMermaidBrowser plugin only for old engine, records selected renderer in module graph; checker validates actual matching graph and excludes the other engine while preserving old fixture compatibility.
- [ ] Build inputs and main app use same switch; main share editor imports neither engine. No lazy per-type external chunks in share independent IIFE. Rendering APIs and hash/SRI remain same shape; width third parameter only optional.
- [ ] Run default regression and Pele integration tests. Test actual standalone IIFE strict CSP/registration/render/output-safe theme. Add usage/revert instructions: env pnpm_config_verify_deps_before_run=false VITE_DIAGRAM_RENDERER=pele pnpm build; default unset env rebuild. Document feature differences and no immediate performance guarantee. Commit exact code/docs only.

### Task 4: Integration verification and review evidence

**Files:** report docs/superpowers/reports/2026-10-18-pele-reversible-build-verification.md; tasks/todo.md; precise fixes only after review.

- [ ] Build CORE and sync installed distribution with pnpm sync:core; compare complete source-dist vs installed-dist bytes without removing unknown files. Run pnpm check, covering/default regression and full host tests with bounded workers; run applicable CORE tests/typecheck/build.
- [ ] Run default pnpm build and Pele pnpm build to separate ignored output/evidence directories (retain legacy release dist if present). Both check-share-editor-build gates pass with same budgets. Inspect graph absent opposite renderer, hash/SRI and no extra requests; retain final local Pele dist for trial. No Rust build required.
- [ ] Use available browser to exercise actual final bundle and preview layouts/theme/standalone SVG/PNG; record exact environment and any unavailable WebViews. Do not claim Windows/Linux/macOS native results not observed.
- [ ] Independent whole-change review gets frozen host+CORE diff packages and test evidence. One fix wave/scoped re-review if required; record rulings. Archive evidence, precise report commit, final clean tracked state and original7preserved; no push/release.
