// Cascade resolution for a single element. Ordering follows CSS cascade
// rules for origin and importance:
//   stylesheet normal < inline normal < stylesheet important < inline important
// then specificity, then source order.

import type {ElementNode} from '../html/dom';
import {removeAttr, setAttr} from '../html/dom';
import type {Declaration} from './stylesheet';

export interface MatchedDeclaration {
  declaration: Declaration;
  inline: boolean;
  specificity: [number, number, number];
  order: number;
}

function compareRank(a: MatchedDeclaration, b: MatchedDeclaration): number {
  const ai = a.declaration.important ? 1 : 0;
  const bi = b.declaration.important ? 1 : 0;
  if (ai !== bi) return ai - bi;
  const al = a.inline ? 1 : 0;
  const bl = b.inline ? 1 : 0;
  if (al !== bl) return al - bl;
  for (let k = 0; k < 3; k++) {
    if (a.specificity[k] !== b.specificity[k]) return a.specificity[k] - b.specificity[k];
  }
  return a.order - b.order;
}

interface Winner {
  declaration: Declaration;
  order: number;
}

export function computeWinningDeclarations(candidates: MatchedDeclaration[]): Declaration[] {
  const winners = new Map<string, {rank: MatchedDeclaration; winner: Winner}>();
  for (const candidate of candidates) {
    const key = candidate.declaration.prop;
    const existing = winners.get(key);
    if (!existing || compareRank(candidate, existing.rank) >= 0) {
      winners.set(key, {
        rank: candidate,
        winner: {declaration: candidate.declaration, order: candidate.order},
      });
    }
  }
  return [...winners.values()]
    .sort((a, b) => a.winner.order - b.winner.order)
    .map(entry => entry.winner.declaration);
}

export function serializeDeclarations(declarations: Declaration[]): string {
  return declarations
    .map(decl => `${decl.prop}: ${decl.value}${decl.important ? ' !important' : ''}`)
    .join('; ');
}

// Writes the resolved declarations back onto the element's style attribute.
// Existing inline declarations keep their relative positions; properties that
// only came from the stylesheet are appended in stylesheet order.
export function applyCascade(
  el: ElementNode,
  inlineDeclarations: Declaration[],
  stylesheetCandidates: MatchedDeclaration[],
): void {
  const candidates: MatchedDeclaration[] = [
    ...inlineDeclarations.map(declaration => ({
      declaration,
      inline: true,
      specificity: [0, 0, 0] as [number, number, number],
      order: declaration.order,
    })),
    ...stylesheetCandidates,
  ];
  const winners = computeWinningDeclarations(candidates);
  if (winners.length === 0) {
    removeAttr(el, 'style');
    return;
  }
  const byProp = new Map(winners.map(decl => [decl.prop, decl]));
  const ordered: Declaration[] = [];
  const emitted = new Set<string>();
  for (const decl of inlineDeclarations) {
    if (emitted.has(decl.prop)) continue;
    const winner = byProp.get(decl.prop);
    if (winner) {
      ordered.push(winner);
      emitted.add(decl.prop);
    }
  }
  for (const decl of winners) {
    if (!emitted.has(decl.prop)) {
      ordered.push(decl);
      emitted.add(decl.prop);
    }
  }
  setAttr(el, 'style', serializeDeclarations(ordered));
}
