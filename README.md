# Email Rendering Lab

Local workbench for render previews.

Run `npm install`, then `npm run dev`.

## CSS inlining pipeline

`POST /api/templates/:id/preview` inlines a template's CSS into its HTML.

- **Parse artifacts are cached, match results are not.** `src/server/inline/css.ts` parses CSS
  text into a `ParsedStylesheet` — plain, deep-frozen data with no DOM node references.
  `src/server/inline/cache.ts` caches it under a key of CSS text + parse-affecting options
  (`keepUnsupported`), with LRU eviction. Selector matching and cascade state are rebuilt per
  render in a `RenderSession` (`src/server/inline/inline.ts`), so the same cached artifact can
  serve any number of DOMs, concurrently, without cross-template leaks.
- **Cascade** handles specificity, `!important`, and existing `style` attributes
  (inline `!important` > stylesheet `!important` > inline > stylesheet).
- **Graceful degradation**: pseudo-class/element selectors, unknown at-rules, unsupported media
  queries, and malformed declarations are skipped with diagnostics; one failing rule never
  affects the rest of the render or later templates.
- **Cancellation**: pass an `AbortSignal`; renders abort between rules and discard partial state.

The frontend tags every preview request with the template id + revision
(`src/client/previewOwnership.ts`); responses and failures from stale revisions are ignored,
so an old request can never clear or overwrite the current preview.

## Tests

`npm test` covers: same CSS on different DOMs, concurrent previews, media rules, pseudo-class
skipping, existing `!important`, cache eviction, render cancellation, and preview ownership.
