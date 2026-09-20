// Cache for reusable parse artifacts. Keys cover everything that affects
// parsing (the CSS text plus parse options); values are frozen pure data.
// Crucially, nothing per-DOM ever enters this cache: no element references,
// no match results, no render state. Those live in the render pipeline's
// per-call working set and are discarded when the render finishes.

import {createHash} from 'node:crypto';
import type {ParsedStylesheet, ParseOptions} from './stylesheet';
import {parseCss} from './stylesheet';

export interface CacheStats {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  parses: number;
  evictions: number;
}

function normalizeOptions(options: ParseOptions): Required<ParseOptions> {
  return {mode: options.mode ?? 'stylesheet'};
}

export function cacheKey(css: string, options: ParseOptions = {}): string {
  return createHash('sha256')
    .update(JSON.stringify([css, normalizeOptions(options)]))
    .digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class StylesheetCache {
  readonly maxEntries: number;
  private readonly entries = new Map<string, ParsedStylesheet>();
  private hits = 0;
  private misses = 0;
  private parses = 0;
  private evictions = 0;

  constructor(maxEntries = 100) {
    if (maxEntries < 1) throw new Error('maxEntries must be >= 1');
    this.maxEntries = maxEntries;
  }

  get(css: string, options: ParseOptions = {}): ParsedStylesheet {
    const key = cacheKey(css, options);
    const hit = this.entries.get(key);
    if (hit) {
      this.hits++;
      // LRU touch: re-insert at the tail.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    this.misses++;
    this.parses++;
    const parsed = deepFreeze(parseCss(css, options));
    this.entries.set(key, parsed);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.evictions++;
    }
    return parsed;
  }

  stats(): CacheStats {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      parses: this.parses,
      evictions: this.evictions,
    };
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.parses = 0;
    this.evictions = 0;
  }
}
