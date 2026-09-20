// Tracks which preview request is allowed to update the UI. Every preview
// request is attributed to a template id + revision at the moment it is
// issued; only the most recently begun request whose attribution still
// matches the currently loaded template may apply its result (or its
// failure). A stale request — superseded, from another template, or from an
// older revision — is ignored entirely, so a late failure can never clear a
// newer preview.

export interface PreviewToken {
  readonly id: string;
  readonly revision: number;
  readonly seq: number;
}

export interface TemplateRef {
  id: string;
  revision: number;
}

export class PreviewCoordinator {
  private seq = 0;
  private active: PreviewToken | null = null;

  begin(id: string, revision: number): PreviewToken {
    const token: PreviewToken = {id, revision, seq: ++this.seq};
    this.active = token;
    return token;
  }

  // Called when the user navigates away from the template: nothing in flight
  // may apply afterwards.
  invalidate(): void {
    this.active = null;
  }

  isCurrent(token: PreviewToken, current: TemplateRef | null): boolean {
    return (
      this.active === token &&
      current !== null &&
      current.id === token.id &&
      current.revision === token.revision
    );
  }
}
