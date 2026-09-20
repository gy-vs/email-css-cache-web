// Selector matching and specificity. Pure functions over the parse artifact
// and a per-render DOM — nothing here is cached.

import type {ComplexSelector, CompoundSelector} from './css';
import {previousElementSibling, type Element} from './dom';

// [inline, ids, classes+attributes, types] — inline is 0 for stylesheet rules.
export type Specificity = [number, number, number, number];

export function specificityOf(sel: ComplexSelector): Specificity {
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const compound of sel.compounds) {
    if (compound.id) ids++;
    classes += compound.classes.length + compound.attrs.length;
    if (compound.tag) tags++;
  }
  return [0, ids, classes, tags];
}

export function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function matchesSelector(el: Element, sel: ComplexSelector): boolean {
  return matchAt(el, sel, sel.compounds.length - 1);
}

function matchAt(el: Element, sel: ComplexSelector, index: number): boolean {
  if (!matchCompound(el, sel.compounds[index])) return false;
  if (index === 0) return true;
  const combinator = sel.combinators[index - 1];
  if (combinator === '>') {
    return el.parent?.kind === 'element' && matchAt(el.parent, sel, index - 1);
  }
  if (combinator === ' ') {
    let p = el.parent;
    while (p && p.kind === 'element') {
      if (matchAt(p, sel, index - 1)) return true;
      p = p.parent;
    }
    return false;
  }
  if (combinator === '+') {
    const prev = previousElementSibling(el);
    return !!prev && matchAt(prev, sel, index - 1);
  }
  let prev = previousElementSibling(el);
  while (prev) {
    if (matchAt(prev, sel, index - 1)) return true;
    prev = previousElementSibling(prev);
  }
  return false;
}

function matchCompound(el: Element, compound: CompoundSelector): boolean {
  if (compound.tag && el.tag !== compound.tag) return false;
  if (compound.id && el.attrs.get('id') !== compound.id) return false;
  for (const cls of compound.classes) {
    const value = el.attrs.get('class');
    if (!value || !value.split(/\s+/).includes(cls)) return false;
  }
  for (const attr of compound.attrs) {
    const value = el.attrs.get(attr.name);
    if (value === undefined) return false;
    if (attr.value !== undefined && value !== attr.value) return false;
  }
  return true;
}
