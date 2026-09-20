import {describe, expect, it} from 'vitest';
import {PreviewCoordinator} from '../src/client/previewCoordinator';

describe('PreviewCoordinator', () => {
  it('attributes each preview request to a template revision', () => {
    const coordinator = new PreviewCoordinator();
    const stale = coordinator.begin('alpha', 3);
    const current = coordinator.begin('alpha', 4);
    expect(coordinator.isCurrent(stale, {id: 'alpha', revision: 4})).toBe(false);
    expect(coordinator.isCurrent(current, {id: 'alpha', revision: 4})).toBe(true);
  });

  it('rejects a request whose revision no longer matches the loaded template', () => {
    const coordinator = new PreviewCoordinator();
    const token = coordinator.begin('alpha', 3);
    // A save bumped the revision while the request was in flight.
    expect(coordinator.isCurrent(token, {id: 'alpha', revision: 4})).toBe(false);
    // Or the user switched templates entirely.
    expect(coordinator.isCurrent(token, {id: 'beta', revision: 5})).toBe(false);
    // Or nothing is loaded.
    expect(coordinator.isCurrent(token, null)).toBe(false);
  });

  it('invalidates in-flight requests when navigating away', () => {
    const coordinator = new PreviewCoordinator();
    const token = coordinator.begin('alpha', 3);
    coordinator.invalidate();
    expect(coordinator.isCurrent(token, {id: 'alpha', revision: 3})).toBe(false);
  });

  it('a stale request failure cannot clear a newer preview', () => {
    // Simulate the component flow: request 1 (rev 3) starts, then the
    // template is saved (rev 4) and request 2 starts. Request 2 succeeds,
    // then request 1 fails late.
    const coordinator = new PreviewCoordinator();
    let preview: string | null = null;
    let error: string | null = null;
    const loaded = {id: 'alpha', revision: 4};

    const first = coordinator.begin('alpha', 3);
    const second = coordinator.begin('alpha', 4);

    // Request 2 succeeds and applies.
    if (coordinator.isCurrent(second, loaded)) {
      preview = '<p style="color: red">new</p>';
      error = null;
    }
    expect(preview).not.toBeNull();

    // Request 1 fails late: guarded out, newer preview untouched.
    if (coordinator.isCurrent(first, loaded)) {
      preview = null;
      error = 'network_error';
    }
    expect(preview).toBe('<p style="color: red">new</p>');
    expect(error).toBeNull();

    // And a stale success cannot overwrite either.
    if (coordinator.isCurrent(first, loaded)) {
      preview = '<p>old</p>';
    }
    expect(preview).toBe('<p style="color: red">new</p>');
  });
});
