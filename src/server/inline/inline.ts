// CSS inliner. Each call builds its own render session (DOM, cascade state)
// from the shared, DOM-free parse artifact — so concurrent renders are
// isolated and a failed rule never pollutes later templates.

import {allElements, parseHtml, serialize, type Element} from './dom';
import {
  matchesMediaQuery,
  parseDeclarations,
  parseStylesheet,
  type Declaration,
  type Diagnostic,
  type MediaContext,
} from './css';
import {compareSpecificity, matchesSelector, specificityOf, type Specificity} from './selector';
import {StylesheetCache, cacheKeyFor} from './cache';

export type {Diagnostic, MediaContext} from './css';
export {StylesheetCache, cacheKeyFor} from './cache';

export type InlineOptions = {
  media?: MediaContext;
  signal?: AbortSignal;
  cache?: StylesheetCache;
  keepUnsupported?: boolean;
};

export type InlineResult = {
  html: string;
  diagnostics: Diagnostic[];
  cacheHit: boolean;
  matchedElements: number;
  styledElements: number;
};

export const sharedCache = new StylesheetCache(50);

const INLINE_SPECIFICITY: Specificity = [1, 0, 0, 0];

type AppliedDeclaration = {value: string; important: boolean; specificity: Specificity; order: number};

// Per-render working state. Created fresh per call, never cached, so
// concurrent previews cannot observe each other's partial cascade.
class RenderSession {
  readonly styles = new Map<Element, Map<string, AppliedDeclaration>>();

  constructor(readonly diagnostics: Diagnostic[]) {}

  apply(el: Element, decl: Declaration, specificity: Specificity, order: number): void {
    let props = this.styles.get(el);
    if (!props) {
      props = new Map();
      this.styles.set(el, props);
    }
    const current = props.get(decl.prop);
    if (!current || wins(decl.important, specificity, order, current)) {
      props.set(decl.prop, {value: decl.value, important: decl.important, specificity, order});
    }
  }
}

// CSS cascade: importance first, then specificity, then source order.
function wins(important: boolean, specificity: Specificity, order: number, current: AppliedDeclaration): boolean {
  if (important !== current.important) return important;
  const cmp = compareSpecificity(specificity, current.specificity);
  if (cmp !== 0) return cmp > 0;
  return order >= current.order;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  }
}

export async function inlineCss(html: string, css: string, options: InlineOptions = {}): Promise<InlineResult> {
  const {signal} = options;
  throwIfAborted(signal);

  const cache = options.cache ?? sharedCache;
  const key = cacheKeyFor(css, {keepUnsupported: options.keepUnsupported});
  let artifact = cache.get(key);
  const cacheHit = artifact !== undefined;
  if (!artifact) {
    artifact = parseStylesheet(css, {keepUnsupported: options.keepUnsupported});
    cache.set(key, artifact);
  }

  // Everything below is per-render state; the cached artifact is only read.
  const root = parseHtml(html);
  const elements = [...allElements(root)];
  const session = new RenderSession([...artifact.diagnostics]);

  // Existing style attributes join the cascade as inline-specificity declarations.
  for (const el of elements) {
    const inline = el.attrs.get('style');
    if (!inline) continue;
    const parsed = parseDeclarations(inline);
    session.diagnostics.push(...parsed.diagnostics);
    parsed.declarations.forEach((decl, i) => session.apply(el, decl, INLINE_SPECIFICITY, i - parsed.declarations.length));
  }

  let matchedElements = 0;
  for (const rule of artifact.rules) {
    throwIfAborted(signal);
    await Promise.resolve(); // yield: concurrent renders interleave on isolated state
    if (rule.media && !rule.media.some((query) => matchesMediaQuery(query, options.media))) {
      session.diagnostics.push({code: 'media_skipped', message: `media query "${rule.mediaText}" did not match`, detail: rule.mediaText});
      continue;
    }
    for (const selector of rule.selectors) {
      let targets: Element[];
      try {
        targets = elements.filter((el) => matchesSelector(el, selector));
      } catch (err) {
        // A single broken rule must not poison this render or later ones.
        session.diagnostics.push({code: 'match_failed', message: err instanceof Error ? err.message : String(err), detail: selector.text});
        continue;
      }
      const specificity = specificityOf(selector);
      for (const el of targets) {
        matchedElements++;
        for (const decl of rule.declarations) session.apply(el, decl, specificity, rule.order);
      }
    }
  }

  let styledElements = 0;
  for (const [el, props] of session.styles) {
    if (!props.size) continue;
    el.attrs.set('style', serializeStyle(props));
    styledElements++;
  }

  return {html: serialize(root), diagnostics: session.diagnostics, cacheHit, matchedElements, styledElements};
}

function serializeStyle(props: Map<string, AppliedDeclaration>): string {
  return [...props].map(([prop, decl]) => `${prop}: ${decl.value}${decl.important ? ' !important' : ''}`).join('; ');
}
