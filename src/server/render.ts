// Render pipeline: parse (cached, shared) -> match (per-DOM, never cached)
// -> cascade -> serialize. All mutable working state is local to a single
// renderPreview call, so concurrent renders cannot observe each other.

import type {ElementNode} from './html/dom';
import {
  getAttr,
  parseHtml,
  removeFromParent,
  serializeHtml,
  walkElements,
} from './html/dom';
import {StylesheetCache} from './css/cache';
import type {Diagnostic, MediaQuery, StyleRule} from './css/stylesheet';
import {matchesCompiled} from './css/selector';
import type {MatchedDeclaration} from './css/cascade';
import {applyCascade} from './css/cascade';

export class RenderCancelled extends Error {
  constructor() {
    super('render cancelled');
    this.name = 'RenderCancelled';
  }
}

export interface MediaContext {
  type: 'all' | 'screen' | 'print';
  width?: number;
}

export interface RenderOptions {
  media?: Partial<MediaContext>;
  signal?: AbortSignal;
  cache?: StylesheetCache;
}

export interface RenderResult {
  html: string;
  diagnostics: Diagnostic[];
}

const DEFAULT_MEDIA: MediaContext = {type: 'screen', width: 600};
const MAX_DIAGNOSTICS = 50;
const YIELD_INTERVAL = 256;

// Shared default cache. Only immutable parse artifacts live here, so sharing
// it across templates and concurrent renders is safe.
export const sharedStylesheetCache = new StylesheetCache(100);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderCancelled();
}

function mediaMatches(media: MediaQuery[] | null, context: MediaContext): boolean {
  if (!media) return true;
  return media.some(query => {
    if (query.type && query.type !== 'all' && query.type !== context.type) return false;
    return query.features.every(feature => {
      if (context.width === undefined) return false;
      const value = parseInt(feature.value, 10);
      if (feature.name === 'min-width') return context.width >= value;
      if (feature.name === 'max-width') return context.width <= value;
      return false;
    });
  });
}

// Declarations from later chunks must win ties against earlier chunks, so the
// per-stylesheet declaration order is offset by a fixed stride per chunk.
const ORDER_STRIDE = 10_000_000;

export async function renderPreview(
  html: string,
  css: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const {signal} = options;
  const cache = options.cache ?? sharedStylesheetCache;
  const media: MediaContext = {...DEFAULT_MEDIA, ...options.media};
  const diagnostics: Diagnostic[] = [];
  let truncated = false;
  const report = (list: Diagnostic[]) => {
    for (const diagnostic of list) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        if (!truncated) {
          truncated = true;
          diagnostics.push({code: 'diagnostics_truncated', message: 'further diagnostics omitted'});
        }
        return;
      }
      diagnostics.push(diagnostic);
    }
  };

  throwIfAborted(signal);

  // --- Parse phase (results are cacheable, pure data) ---
  const doc = parseHtml(html);
  const styleTexts: string[] = [];
  const styleElements: ElementNode[] = [];
  walkElements(doc, el => {
    if (el.tag === 'style') styleElements.push(el);
  });
  for (const el of styleElements) {
    styleTexts.push(
      el.children.map(child => (child.type === 'text' ? child.text : '')).join(''),
    );
    removeFromParent(el);
  }
  if (css.trim()) styleTexts.push(css);

  const sheets = styleTexts
    .filter(text => text.trim())
    .map(text => cache.get(text, {mode: 'stylesheet'}));
  for (const sheet of sheets) report(sheet.diagnostics);

  throwIfAborted(signal);

  // --- Match phase (per-DOM working state, rebuilt for every render) ---
  const elements: ElementNode[] = [];
  walkElements(doc, el => elements.push(el));
  const matchedByElement = new Map<ElementNode, MatchedDeclaration[]>();
  let ops = 0;
  const tick = async () => {
    if (++ops % YIELD_INTERVAL === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      throwIfAborted(signal);
    }
  };

  for (let chunkIndex = 0; chunkIndex < sheets.length; chunkIndex++) {
    const sheet = sheets[chunkIndex];
    const orderOffset = chunkIndex * ORDER_STRIDE;
    for (const rule of sheet.rules) {
      if (!rule.selectors || rule.declarations.length === 0) continue;
      if (!mediaMatches(rule.media, media)) continue;
      for (const el of elements) {
        await tick();
        for (const selector of rule.selectors) {
          if (!matchesCompiled(el, selector)) continue;
          let matched = matchedByElement.get(el);
          if (!matched) {
            matched = [];
            matchedByElement.set(el, matched);
          }
          for (const declaration of rule.declarations) {
            matched.push({
              declaration,
              inline: false,
              specificity: selector.specificity,
              order: orderOffset + declaration.order,
            });
          }
          break;
        }
      }
    }
  }

  // --- Apply phase ---
  for (const el of elements) {
    const styleAttr = getAttr(el, 'style');
    const matched = matchedByElement.get(el);
    if (styleAttr === undefined && !matched) continue;
    const inlineSheet = styleAttr !== undefined && styleAttr.trim()
      ? cache.get(styleAttr, {mode: 'declarations'})
      : null;
    if (inlineSheet) report(inlineSheet.diagnostics);
    const inlineDeclarations = inlineSheet ? inlineSheet.declarations : [];
    if (inlineDeclarations.length === 0 && !matched) continue;
    applyCascade(el, inlineDeclarations, matched ?? []);
    await tick();
  }

  throwIfAborted(signal);
  return {html: serializeHtml(doc), diagnostics};
}
