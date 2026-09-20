// Selector compilation and matching. Compiled selectors are pure data (no DOM
// references, no closures over nodes) so they are safe to cache and reuse
// across documents. Anything we deliberately do not support (pseudo-classes,
// pseudo-elements, escapes, ...) raises UnsupportedSelectorError so the caller
// can skip just that rule.

import type {ElementNode} from '../html/dom';
import {classList, getAttr, previousElementSibling} from '../html/dom';

export class UnsupportedSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSelectorError';
  }
}

export type Combinator = ' ' | '>' | '+' | '~';

export type SimpleSelector =
  | {kind: 'universal'}
  | {kind: 'type'; name: string}
  | {kind: 'class'; name: string}
  | {kind: 'id'; name: string}
  | {kind: 'attr'; name: string; op?: string; value?: string; flag?: string};

export interface SelectorPart {
  // Combinator connecting this part to the previous (left-hand) part.
  combinator: Combinator | null;
  simples: SimpleSelector[];
}

export interface CompiledSelector {
  parts: SelectorPart[];
  specificity: [number, number, number];
}

const IDENT_RE = /^[-_a-zA-Z0-9\u0080-\uF7FF]+/;

function splitSelectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

function parseAttrSelector(inner: string): SimpleSelector {
  const match = /^\s*([-_a-zA-Z0-9\u0080-\uF7FF]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*([isIS])?\s*)?$/.exec(inner);
  if (!match) throw new UnsupportedSelectorError(`unsupported attribute selector "[${inner}]"`);
  const [, name, op, dq, sq, bare, flag] = match;
  return {
    kind: 'attr',
    name: name.toLowerCase(),
    op: op || undefined,
    value: dq ?? sq ?? bare,
    flag: flag ? flag.toLowerCase() : undefined,
  };
}

function compileComplexSelector(text: string): CompiledSelector {
  const parts: SelectorPart[] = [];
  let simples: SimpleSelector[] = [];
  let pending: Combinator | null = null;
  let i = 0;

  const flush = () => {
    if (simples.length === 0) return;
    parts.push({combinator: parts.length === 0 ? null : pending ?? ' ', simples});
    simples = [];
    pending = null;
  };

  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (simples.length > 0 && pending === null) pending = ' ';
      continue;
    }
    if (c === '>' || c === '+' || c === '~') {
      flush();
      if (parts.length === 0) throw new UnsupportedSelectorError(`selector cannot start with "${c}"`);
      if (pending !== null) throw new UnsupportedSelectorError('doubled combinator');
      pending = c;
      i++;
      continue;
    }
    if (pending !== null && parts.length > 0 && simples.length > 0) flush();
    if (c === '*') {
      simples.push({kind: 'universal'});
      i++;
      continue;
    }
    if (c === '#') {
      const m = IDENT_RE.exec(text.slice(i + 1));
      if (!m) throw new UnsupportedSelectorError('bad id selector');
      simples.push({kind: 'id', name: m[0]});
      i += 1 + m[0].length;
      continue;
    }
    if (c === '.') {
      const m = IDENT_RE.exec(text.slice(i + 1));
      if (!m) throw new UnsupportedSelectorError('bad class selector');
      simples.push({kind: 'class', name: m[0]});
      i += 1 + m[0].length;
      continue;
    }
    if (c === '[') {
      let end = i + 1;
      let quote: string | null = null;
      while (end < text.length) {
        const ch = text[end];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ']') break;
        end++;
      }
      if (end >= text.length) throw new UnsupportedSelectorError('unterminated attribute selector');
      simples.push(parseAttrSelector(text.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    if (c === ':') {
      throw new UnsupportedSelectorError('pseudo-classes and pseudo-elements are not supported');
    }
    const m = IDENT_RE.exec(text.slice(i));
    if (m) {
      if (simples.length > 0) throw new UnsupportedSelectorError('type selector must come first in a compound selector');
      simples.push({kind: 'type', name: m[0].toLowerCase()});
      i += m[0].length;
      continue;
    }
    throw new UnsupportedSelectorError(`unexpected character "${c}" in selector`);
  }
  flush();
  if (parts.length === 0) throw new UnsupportedSelectorError('empty selector');
  if (pending !== null) throw new UnsupportedSelectorError('selector cannot end with a combinator');

  let a = 0;
  let b = 0;
  let cCount = 0;
  for (const part of parts) {
    for (const simple of part.simples) {
      if (simple.kind === 'id') a++;
      else if (simple.kind === 'class' || simple.kind === 'attr') b++;
      else if (simple.kind === 'type') cCount++;
    }
  }
  return {parts, specificity: [a, b, cCount]};
}

export function compileSelectorList(selectorText: string): CompiledSelector[] {
  const list = splitSelectorList(selectorText);
  if (list.length === 0) throw new UnsupportedSelectorError('empty selector');
  return list.map(compileComplexSelector);
}

function matchAttr(el: ElementNode, simple: Extract<SimpleSelector, {kind: 'attr'}>): boolean {
  const actual = getAttr(el, simple.name);
  if (actual === undefined) return false;
  if (!simple.op) return true;
  const expected = simple.value ?? '';
  const a = simple.flag === 'i' ? actual.toLowerCase() : actual;
  const v = simple.flag === 'i' ? expected.toLowerCase() : expected;
  switch (simple.op) {
    case '=':
      return a === v;
    case '~=':
      return a.split(/\s+/).includes(v);
    case '|=':
      return a === v || a.startsWith(v + '-');
    case '^=':
      return a.startsWith(v);
    case '$=':
      return a.endsWith(v);
    case '*=':
      return a.includes(v);
    default:
      return false;
  }
}

function matchCompound(el: ElementNode, simples: SimpleSelector[]): boolean {
  for (const simple of simples) {
    switch (simple.kind) {
      case 'universal':
        break;
      case 'type':
        if (el.tag !== simple.name) return false;
        break;
      case 'class':
        if (!classList(el).includes(simple.name)) return false;
        break;
      case 'id':
        if (getAttr(el, 'id') !== simple.name) return false;
        break;
      case 'attr':
        if (!matchAttr(el, simple)) return false;
        break;
    }
  }
  return true;
}

function matchPart(el: ElementNode, parts: SelectorPart[], index: number): boolean {
  if (!matchCompound(el, parts[index].simples)) return false;
  if (index === 0) return true;
  const combinator = parts[index].combinator;
  if (combinator === '>') {
    const parent = el.parent;
    return !!parent && parent.type === 'element' && matchPart(parent, parts, index - 1);
  }
  if (combinator === '+') {
    const sibling = previousElementSibling(el);
    return !!sibling && matchPart(sibling, parts, index - 1);
  }
  if (combinator === '~') {
    let sibling = previousElementSibling(el);
    while (sibling) {
      if (matchPart(sibling, parts, index - 1)) return true;
      sibling = previousElementSibling(sibling);
    }
    return false;
  }
  let node = el.parent;
  while (node) {
    if (node.type === 'element' && matchPart(node, parts, index - 1)) return true;
    node = node.parent;
  }
  return false;
}

export function matchesCompiled(el: ElementNode, selector: CompiledSelector): boolean {
  return matchPart(el, selector.parts, selector.parts.length - 1);
}
