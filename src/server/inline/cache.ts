// LRU cache for parsed stylesheets.
//
// The cache key is the CSS text plus every option that affects parsing. The
// cached value is the reusable parse artifact only — per-DOM match results
// and node references are never stored here. Artifacts are deep-frozen on
// entry so concurrent renders can share them safely.

import type {ParsedStylesheet, ParseOptions} from './css';

export function cacheKeyFor(css: string, options: ParseOptions = {}): string {
  return JSON.stringify({keepUnsupported: !!options.keepUnsupported}) + '\n' + css;
}

export class StylesheetCache {
  #entries = new Map<string, ParsedStylesheet>();
  readonly stats = {hits: 0, misses: 0, evictions: 0};

  constructor(readonly maxEntries = 50) {
    if (maxEntries < 1) throw new RangeError('maxEntries must be >= 1');
  }

  get(key: string): ParsedStylesheet | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    this.#entries.delete(key);
    this.#entries.set(key, value); // refresh recency
    return value;
  }

  set(key: string, value: ParsedStylesheet): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    while (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
      this.stats.evictions++;
    }
    this.#entries.set(key, deepFreeze(value));
  }

  /** Read without affecting recency — for tests and inspection. */
  peek(key: string): ParsedStylesheet | undefined {
    return this.#entries.get(key);
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
