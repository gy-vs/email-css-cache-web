// CSS parsing. The output (ParsedStylesheet) is pure, immutable data: no DOM
// nodes, no functions, no render state. That is what makes it safe to cache
// and reuse across documents and across concurrent renders. Per-DOM matching
// happens later, in the render pipeline, against fresh state every time.

import type {CompiledSelector} from './selector';
import {compileSelectorList, UnsupportedSelectorError} from './selector';

export interface Diagnostic {
  code: string;
  message: string;
  context?: string;
}

export interface Declaration {
  prop: string;
  value: string;
  important: boolean;
  order: number;
}

export interface MediaFeature {
  name: string;
  value: string;
}

export interface MediaQuery {
  type: 'all' | 'screen' | 'print' | null;
  features: MediaFeature[];
}

export interface StyleRule {
  selectorText: string;
  // null means the selector could not be compiled; the rule is skipped at
  // match time and a diagnostic was recorded at parse time.
  selectors: CompiledSelector[] | null;
  declarations: Declaration[];
  // null = not inside a media block; [] = media query never matches
  // (unsupported query); otherwise the rule applies when any query matches.
  media: MediaQuery[] | null;
  order: number;
}

export interface ParsedStylesheet {
  mode: 'stylesheet' | 'declarations';
  rules: StyleRule[];
  declarations: Declaration[];
  diagnostics: Diagnostic[];
}

export interface ParseOptions {
  mode?: 'stylesheet' | 'declarations';
}

interface Counter {
  value: number;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

// Reads until one of `stopChars` at paren depth 0 outside strings/comments.
// Returns the text read; `i` is left on the stop character or at end of input.
function readUntil(css: string, i: number, stopChars: string): [string, number] {
  const start = i;
  let depth = 0;
  let quote: string | null = null;
  while (i < css.length) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth > 0) depth--;
    } else if (depth === 0 && stopChars.includes(c)) {
      break;
    }
    i++;
  }
  return [css.slice(start, i), i];
}

// Skips a balanced {...} block, respecting strings and comments.
function skipBlock(css: string, i: number): number {
  let depth = 1;
  let quote: string | null = null;
  while (i < css.length && depth > 0) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    }
    i++;
  }
  return i;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const IMPORTANT_RE = /!\s*important\s*$/i;

export function parseDeclarationsBlock(
  text: string,
  counter: Counter,
  diagnostics: Diagnostic[],
  context: string,
): Declaration[] {
  const declarations: Declaration[] = [];
  for (const piece of splitTopLevel(text, ';')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      diagnostics.push({code: 'parse_error', message: 'declaration missing ":"', context: trimmed});
      continue;
    }
    const rawProp = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (!rawProp || !value) {
      diagnostics.push({code: 'parse_error', message: 'malformed declaration', context: trimmed});
      continue;
    }
    let important = false;
    if (IMPORTANT_RE.test(value)) {
      important = true;
      value = value.replace(IMPORTANT_RE, '').trim();
    }
    if (!value) {
      diagnostics.push({code: 'parse_error', message: 'declaration missing value', context: trimmed});
      continue;
    }
    // Custom properties are case-sensitive; standard properties are not.
    const prop = rawProp.startsWith('--') ? rawProp : rawProp.toLowerCase();
    declarations.push({prop, value, important, order: counter.value++});
  }
  return declarations;
}

function parseMediaQuery(text: string): MediaQuery | null {
  let rest = text.trim().toLowerCase();
  if (!rest) return null;
  if (rest.startsWith('only ')) rest = rest.slice(5).trim();
  if (/^not\b/.test(rest)) return null; // deliberately unsupported
  let type: MediaQuery['type'] = null;
  const typeMatch = /^(all|screen|print)\b/.exec(rest);
  if (typeMatch) {
    type = typeMatch[1] as MediaQuery['type'];
    rest = rest.slice(typeMatch[0].length).trim();
  }
  const features: MediaFeature[] = [];
  // A leading media type must be followed by "and (...)"; a type-less query
  // starts directly with its first feature.
  let needAnd = type !== null;
  while (rest) {
    if (needAnd) {
      const andMatch = /^and\s*/.exec(rest);
      if (!andMatch) return null;
      rest = rest.slice(andMatch[0].length);
    }
    needAnd = true;
    const featureMatch = /^\(\s*([a-z0-9-]+)\s*:\s*([^)]*?)\s*\)/.exec(rest);
    if (!featureMatch) return null;
    const name = featureMatch[1];
    const value = featureMatch[2].trim();
    if (name !== 'min-width' && name !== 'max-width') return null;
    if (!/^\d+(px)?$/.test(value)) return null;
    features.push({name, value: value.replace(/px$/, '')});
    rest = rest.slice(featureMatch[0].length).trim();
  }
  if (!type && features.length === 0) return null;
  return {type, features};
}

function parseMediaQueryList(prelude: string): MediaQuery[] | null {
  const queries: MediaQuery[] = [];
  for (const part of splitTopLevel(prelude, ',')) {
    const query = parseMediaQuery(part);
    if (!query) return null;
    queries.push(query);
  }
  return queries.length > 0 ? queries : null;
}

function combineMedia(outer: MediaQuery[] | null, inner: MediaQuery[]): MediaQuery[] {
  if (!outer) return inner;
  const combined: MediaQuery[] = [];
  for (const o of outer) {
    for (const q of inner) {
      combined.push({type: q.type ?? o.type, features: [...o.features, ...q.features]});
    }
  }
  return combined;
}

export function parseCss(css: string, options: ParseOptions = {}): ParsedStylesheet {
  const mode = options.mode ?? 'stylesheet';
  const diagnostics: Diagnostic[] = [];
  const counter: Counter = {value: 0};

  if (mode === 'declarations') {
    const declarations = parseDeclarationsBlock(css, counter, diagnostics, 'style attribute');
    return {mode, rules: [], declarations, diagnostics};
  }

  const rules: StyleRule[] = [];
  let i = 0;
  const n = css.length;

  const skipWsAndComments = () => {
    while (i < n) {
      if (isSpace(css[i])) i++;
      else if (css.startsWith('/*', i)) {
        const end = css.indexOf('*/', i + 2);
        i = end === -1 ? n : end + 2;
      } else break;
    }
  };

  const parseBlock = (media: MediaQuery[] | null, topLevel: boolean): void => {
    for (;;) {
      skipWsAndComments();
      if (i >= n) return;
      if (css[i] === '}') {
        i++;
        if (topLevel) {
          diagnostics.push({code: 'parse_error', message: 'unexpected "}"'});
          continue;
        }
        return;
      }
      if (css[i] === '@') {
        parseAtRule(media);
        continue;
      }
      parseStyleRule(media);
    }
  };

  const parseAtRule = (media: MediaQuery[] | null): void => {
    i++; // past '@'
    const nameMatch = /^[a-zA-Z-]+/.exec(css.slice(i));
    const name = nameMatch ? nameMatch[0].toLowerCase() : '';
    i += nameMatch ? nameMatch[0].length : 0;
    const [prelude, at] = readUntil(css, i, '{;');
    i = at;
    if (i >= n || css[i] === ';') {
      if (i < n) i++;
      if (name !== 'charset') {
        diagnostics.push({code: 'unsupported_at_rule', message: `@${name} is not inlined`, context: `@${name}`});
      }
      return;
    }
    i++; // past '{'
    if (name === 'media') {
      const queries = parseMediaQueryList(prelude);
      if (!queries) {
        diagnostics.push({
          code: 'unsupported_media_query',
          message: 'media query is not supported; its rules are skipped',
          context: prelude.trim(),
        });
        i = skipBlock(css, i);
        return;
      }
      parseBlock(combineMedia(media, queries), false);
      return;
    }
    diagnostics.push({code: 'unsupported_at_rule', message: `@${name} is not inlined`, context: `@${name}`});
    i = skipBlock(css, i);
  };

  const parseStyleRule = (media: MediaQuery[] | null): void => {
    const [rawSelector, at] = readUntil(css, i, '{;}');
    i = at;
    const selectorText = rawSelector.trim();
    if (i >= n) {
      if (selectorText) {
        diagnostics.push({code: 'parse_error', message: 'unterminated rule', context: selectorText});
      }
      return;
    }
    if (css[i] === ';') {
      i++;
      diagnostics.push({code: 'parse_error', message: 'expected "{" after selector', context: selectorText});
      return;
    }
    if (css[i] === '}') {
      diagnostics.push({code: 'parse_error', message: 'expected "{" after selector', context: selectorText});
      return; // leave the brace for the enclosing block to handle
    }
    i++; // past '{'
    const [declText, afterDecls] = readUntil(css, i, '}');
    i = afterDecls;
    if (i < n) i++; // past '}'
    else diagnostics.push({code: 'parse_error', message: 'unterminated declaration block', context: selectorText});

    if (!selectorText) {
      diagnostics.push({code: 'parse_error', message: 'rule without selector'});
      return;
    }
    const declarations = parseDeclarationsBlock(declText, counter, diagnostics, selectorText);
    let selectors: CompiledSelector[] | null = null;
    try {
      selectors = compileSelectorList(selectorText);
    } catch (err) {
      if (err instanceof UnsupportedSelectorError) {
        diagnostics.push({code: 'unsupported_selector', message: err.message, context: selectorText});
      } else {
        diagnostics.push({
          code: 'parse_error',
          message: err instanceof Error ? err.message : String(err),
          context: selectorText,
        });
      }
    }
    rules.push({selectorText, selectors, declarations, media, order: counter.value++});
  };

  parseBlock(null, true);
  return {mode, rules, declarations: [], diagnostics};
}
