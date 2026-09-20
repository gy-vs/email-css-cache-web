// CSS parsing into reusable, DOM-free artifacts.
//
// A ParsedStylesheet is plain, frozen data: selectors as ASTs, declarations,
// media queries, diagnostics. It never contains DOM node references, so it is
// safe to cache by CSS text and share across renders. Everything that depends
// on a specific DOM (matching, cascade state) lives in per-render sessions
// (see inline.ts).

export type Declaration = {prop: string; value: string; important: boolean};

export type AttributeSelector = {name: string; value?: string};
export type CompoundSelector = {
  tag?: string;
  universal?: boolean;
  id?: string;
  classes: string[];
  attrs: AttributeSelector[];
};
export type Combinator = ' ' | '>' | '+' | '~';
export type ComplexSelector = {compounds: CompoundSelector[]; combinators: Combinator[]; text: string};

export type MediaFeature = {name: 'max-width' | 'min-width'; value: number};
export type MediaQuery = {type?: string; features: MediaFeature[]};
export type MediaContext = {type?: string; width?: number};

export type StyleRule = {
  selectors: ComplexSelector[];
  declarations: Declaration[];
  order: number;
  media?: MediaQuery[];
  mediaText?: string;
};

export type Diagnostic = {code: string; message: string; detail?: string};

export type ParsedStylesheet = {
  rules: StyleRule[];
  skipped: {selector: string; reason: string}[];
  diagnostics: Diagnostic[];
};

export type ParseOptions = {
  // Keep rules with unsupported selectors in `skipped` instead of dropping
  // them. This changes the artifact, so it is part of the cache key.
  keepUnsupported?: boolean;
};

export class UnsupportedSelector extends Error {}

export function parseStylesheet(css: string, options: ParseOptions = {}): ParsedStylesheet {
  const keepUnsupported = options.keepUnsupported ?? false;
  const rules: StyleRule[] = [];
  const skipped: {selector: string; reason: string}[] = [];
  const diagnostics: Diagnostic[] = [];
  let order = 0;

  const parseBlock = (text: string, media: MediaQuery[] | undefined, mediaText: string | undefined): void => {
    let pos = 0;
    while (pos < text.length) {
      const pre = readPrelude(text, pos);
      pos = pre.next;
      const prelude = pre.prelude.trim();
      if (pre.terminator === '{') {
        const block = readBlock(text, pre.blockStart);
        pos = block.end;
        if (/^@media\b/i.test(prelude)) {
          const queryText = prelude.replace(/^@media/i, '').trim();
          const queries = media ? null : parseMediaQueryList(queryText);
          if (!queries) {
            diagnostics.push({code: media ? 'nested_media' : 'unsupported_media_query', message: `cannot apply media query "${queryText}"`, detail: queryText});
          } else {
            parseBlock(block.body, queries, queryText);
          }
        } else if (prelude.startsWith('@')) {
          diagnostics.push({code: 'unsupported_at_rule', message: `unsupported at-rule "${prelude}"`, detail: prelude});
        } else if (prelude) {
          const selectors = parseSelectorList(prelude, skipped, diagnostics, keepUnsupported);
          const parsed = parseDeclarations(block.body);
          diagnostics.push(...parsed.diagnostics);
          if (selectors.length && parsed.declarations.length) {
            rules.push({selectors, declarations: parsed.declarations, order: order++, media, mediaText});
          }
        }
      } else if (prelude) {
        const code = prelude.startsWith('@') ? 'unsupported_at_rule' : 'unexpected_statement';
        diagnostics.push({code, message: `skipped "${prelude}"`, detail: prelude});
      }
      if (pre.terminator === 'eof') break;
    }
  };

  parseBlock(stripComments(css), undefined, undefined);
  return {rules, skipped, diagnostics};
}

function parseSelectorList(prelude: string, skipped: {selector: string; reason: string}[], diagnostics: Diagnostic[], keepUnsupported: boolean): ComplexSelector[] {
  const selectors: ComplexSelector[] = [];
  for (const part of splitTopLevel(prelude, ',')) {
    const text = part.trim();
    if (!text) continue;
    try {
      selectors.push(parseComplexSelector(text));
    } catch (err) {
      // One bad selector must not take down the rule list or the stylesheet.
      const reason = err instanceof Error ? err.message : String(err);
      diagnostics.push({code: 'unsupported_selector', message: reason, detail: text});
      if (keepUnsupported) skipped.push({selector: text, reason});
    }
  }
  return selectors;
}

export function parseComplexSelector(text: string): ComplexSelector {
  // Tokenize into compound strings and explicit combinators. Whitespace at
  // depth 0 separates compounds; brackets/quotes protect their contents.
  const tokens: (string | Combinator)[] = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  const pushBuf = () => {
    const token = buf.trim();
    if (token) tokens.push(token);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") {quote = c; buf += c; continue;}
    if (c === '[') {depth++; buf += c; continue;}
    if (c === ']') {depth = Math.max(0, depth - 1); buf += c; continue;}
    if (depth === 0 && (c === '>' || c === '+' || c === '~')) {pushBuf(); tokens.push(c); continue;}
    if (depth === 0 && /\s/.test(c)) {pushBuf(); continue;}
    buf += c;
  }
  pushBuf();
  if (quote || depth !== 0) throw new UnsupportedSelector(`unterminated selector "${text}"`);

  const compounds: CompoundSelector[] = [];
  const combinators: Combinator[] = [];
  let expectCompound = true;
  let pending: Combinator | null = null;
  for (const token of tokens) {
    if (typeof token !== 'string') {
      if (expectCompound || pending) throw new UnsupportedSelector(`misplaced combinator "${token}" in "${text}"`);
      pending = token;
      expectCompound = true;
      continue;
    }
    if (compounds.length) combinators.push(pending ?? ' ');
    compounds.push(parseCompound(token, text));
    pending = null;
    expectCompound = false;
  }
  if (!compounds.length) throw new UnsupportedSelector('empty selector');
  if (expectCompound) throw new UnsupportedSelector(`trailing combinator in "${text}"`);
  return {compounds, combinators, text};
}

function parseCompound(text: string, full: string): CompoundSelector {
  const sel: CompoundSelector = {classes: [], attrs: []};
  let i = 0;
  let parts = 0;
  const readIdent = (): string => {
    const m = /^-?[_a-zA-Z][_a-zA-Z0-9-]*/.exec(text.slice(i));
    if (!m) throw new UnsupportedSelector(`expected identifier in "${full}"`);
    i += m[0].length;
    return m[0];
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '*') {
      if (sel.universal || sel.tag) throw new UnsupportedSelector(`misplaced "*" in "${full}"`);
      sel.universal = true;
      i++;
    } else if (c === '#') {
      i++;
      const id = readIdent();
      if (sel.id) throw new UnsupportedSelector(`multiple ids in "${full}"`);
      sel.id = id;
    } else if (c === '.') {
      i++;
      sel.classes.push(readIdent());
    } else if (c === '[') {
      const end = findAttributeEnd(text, i, full);
      sel.attrs.push(parseAttributeSelector(text.slice(i + 1, end), full));
      i = end + 1;
    } else if (c === ':') {
      throw new UnsupportedSelector(`pseudo-class/element selectors are not inlined: "${full}"`);
    } else if (/[-_a-zA-Z]/.test(c)) {
      const tag = readIdent();
      if (sel.tag || sel.universal) throw new UnsupportedSelector(`multiple type selectors in "${full}"`);
      sel.tag = tag.toLowerCase();
    } else {
      throw new UnsupportedSelector(`unexpected "${c}" in "${full}"`);
    }
    parts++;
  }
  if (!parts) throw new UnsupportedSelector(`empty compound in "${full}"`);
  return sel;
}

function findAttributeEnd(text: string, start: number, full: string): number {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ']') return i;
  }
  throw new UnsupportedSelector(`unterminated attribute selector in "${full}"`);
}

function parseAttributeSelector(body: string, full: string): AttributeSelector {
  const m = /^\s*([-_a-zA-Z][-_a-zA-Z0-9]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([-_a-zA-Z0-9]+))\s*)?$/.exec(body);
  if (!m) throw new UnsupportedSelector(`unsupported attribute selector "[${body}]" in "${full}"`);
  const value = m[2] ?? m[3] ?? m[4];
  return value === undefined ? {name: m[1]} : {name: m[1], value};
}

export function parseDeclarations(body: string): {declarations: Declaration[]; diagnostics: Diagnostic[]} {
  const declarations: Declaration[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const part of splitTopLevel(body, ';')) {
    const text = part.trim();
    if (!text) continue;
    const colon = indexOfTopLevel(text, ':');
    const prop = colon > 0 ? text.slice(0, colon).trim().toLowerCase() : '';
    let value = colon > 0 ? text.slice(colon + 1).trim() : '';
    if (!/^[-_a-zA-Z][-_a-zA-Z0-9]*$/.test(prop) || !value) {
      diagnostics.push({code: 'bad_declaration', message: `malformed declaration "${text}"`, detail: text});
      continue;
    }
    let important = false;
    const im = /!\s*important\s*$/i.exec(value);
    if (im) {
      important = true;
      value = value.slice(0, im.index).trim();
      if (!value) {
        diagnostics.push({code: 'bad_declaration', message: `malformed declaration "${text}"`, detail: text});
        continue;
      }
    }
    declarations.push({prop, value, important});
  }
  return {declarations, diagnostics};
}

export function parseMediaQueryList(text: string): MediaQuery[] | null {
  const queries: MediaQuery[] = [];
  for (const part of splitTopLevel(text, ',')) {
    const query = parseMediaQuery(part.trim());
    if (!query) return null;
    queries.push(query);
  }
  return queries.length ? queries : null;
}

function parseMediaQuery(text: string): MediaQuery | null {
  if (!text) return null;
  let rest = text.replace(/^only\s+/i, '');
  if (/^not\b/i.test(rest)) return null;
  const query: MediaQuery = {features: []};
  const typeMatch = /^(all|screen|print)\b/i.exec(rest);
  if (typeMatch) {
    query.type = typeMatch[1].toLowerCase();
    rest = rest.slice(typeMatch[0].length).trim();
  } else if (!rest.startsWith('(')) {
    return null; // unknown media type
  }
  while (rest.length) {
    rest = rest.replace(/^and\s+/i, '');
    const m = /^\(\s*(max-width|min-width)\s*:\s*(\d+(?:\.\d+)?)px\s*\)\s*/i.exec(rest);
    if (!m) return null;
    query.features.push({name: m[1].toLowerCase() as MediaFeature['name'], value: Number(m[2])});
    rest = rest.slice(m[0].length).trim();
  }
  return query;
}

export function matchesMediaQuery(query: MediaQuery, context: MediaContext | undefined): boolean {
  if (!context) return false;
  if (query.type && query.type !== 'all' && query.type !== (context.type ?? 'screen')) return false;
  for (const feature of query.features) {
    if (context.width === undefined) return false;
    if (feature.name === 'max-width' && !(context.width <= feature.value)) return false;
    if (feature.name === 'min-width' && !(context.width >= feature.value)) return false;
  }
  return true;
}

function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) {
        if (css[j] === '\\') j++;
        j++;
      }
      out += css.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function readPrelude(text: string, pos: number): {prelude: string; terminator: '{' | ';' | 'eof'; next: number; blockStart: number} {
  let depth = 0;
  let quote = '';
  for (let i = pos; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') {i++; continue;}
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {quote = c; continue;}
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === '{') return {prelude: text.slice(pos, i), terminator: '{', next: i + 1, blockStart: i};
    else if (depth === 0 && c === ';') return {prelude: text.slice(pos, i), terminator: ';', next: i + 1, blockStart: -1};
  }
  return {prelude: text.slice(pos), terminator: 'eof', next: text.length, blockStart: -1};
}

function readBlock(text: string, start: number): {body: string; end: number} {
  let depth = 0;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') {i++; continue;}
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {quote = c; continue;}
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return {body: text.slice(start + 1, i), end: i + 1};
    }
  }
  return {body: text.slice(start + 1), end: text.length};
}

export function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === '\\') {i++; continue;}
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {quote = c; continue;}
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === delimiter && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function indexOfTopLevel(input: string, target: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {quote = c; continue;}
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === target && depth === 0) return i;
  }
  return -1;
}
