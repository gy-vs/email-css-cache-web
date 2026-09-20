# Email Rendering Lab

Local workbench for render previews.

Run `npm install`, then `npm run dev`.

## How rendering works

`POST /api/templates/:id/preview` inlines CSS into HTML for a template
revision. The pipeline is split so cached work never mixes with per-document
state:

- **Parse artifacts are cacheable** (`src/server/css/cache.ts`): the cache key
  is a hash of the CSS text plus the options that affect parsing
  (`stylesheet` vs `declarations` mode). Values are frozen, pure data — no DOM
  node references — so one parsed stylesheet is safely reused across
  templates, documents, and concurrent renders. The cache is LRU-bounded.
- **Matching is per DOM** (`src/server/render.ts`): every render builds its
  own element index and match results, evaluates media queries against the
  caller's context, applies the cascade (specificity, `!important`, existing
  `style` attributes), and discards all working state when done. Concurrent
  renders are fully isolated, and a render can be cancelled via
  `AbortSignal` (the server cancels when the client disconnects).
- **Failures are contained**: unsupported selectors (e.g. pseudo-classes),
  unsupported at-rules, and malformed declarations produce diagnostics and
  are skipped; they never affect other rules or later templates.

The client attributes every preview request to the template id + revision it
was issued for (`src/client/previewCoordinator.ts`); responses and failures
from superseded requests are ignored, so a stale request can never clear or
overwrite a newer preview.
