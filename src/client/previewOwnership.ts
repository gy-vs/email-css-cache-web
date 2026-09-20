// Ownership for preview requests. Every preview request is tagged with the
// template id + revision it was issued for; results — and failures — are
// applied only while that tag still owns the preview pane. A stale request
// (older revision, another template) can neither overwrite nor clear the
// current preview.

export type PreviewOwner = {id: string; revision: number};

export function isSameOwner(a: PreviewOwner | null, b: PreviewOwner | null): boolean {
  return a !== null && b !== null && a.id === b.id && a.revision === b.revision;
}

export class PreviewTracker {
  #current: PreviewOwner | null = null;

  setCurrent(owner: PreviewOwner | null): void {
    this.#current = owner;
  }

  isCurrent(owner: PreviewOwner): boolean {
    return isSameOwner(this.#current, owner);
  }
}
