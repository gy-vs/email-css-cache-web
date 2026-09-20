import {describe,expect,it} from 'vitest';
import {PreviewTracker,isSameOwner} from '../src/client/previewOwnership';

describe('preview ownership (per template revision)',()=>{
  it('accepts results only for the current owner',()=>{
    const tracker=new PreviewTracker();
    tracker.setCurrent({id:'alpha',revision:3});
    expect(tracker.isCurrent({id:'alpha',revision:3})).toBe(true);
    expect(tracker.isCurrent({id:'alpha',revision:2})).toBe(false); // stale revision
    expect(tracker.isCurrent({id:'beta',revision:3})).toBe(false); // other template
  });
  it('a stale request failure must not clear the new preview',()=>{
    const tracker=new PreviewTracker();
    tracker.setCurrent({id:'alpha',revision:3});
    const staleRequest={id:'alpha',revision:3};
    // a save bumps the revision while the old preview request is in flight
    tracker.setCurrent({id:'alpha',revision:4});
    expect(tracker.isCurrent(staleRequest)).toBe(false); // its failure is ignored
    expect(tracker.isCurrent({id:'alpha',revision:4})).toBe(true);
  });
  it('drops ownership when the selection changes',()=>{
    const tracker=new PreviewTracker();
    tracker.setCurrent({id:'alpha',revision:3});
    tracker.setCurrent(null); // user switched templates, row not loaded yet
    expect(tracker.isCurrent({id:'alpha',revision:3})).toBe(false);
  });
  it('isSameOwner treats null as no owner',()=>{
    expect(isSameOwner(null,null)).toBe(false);
    expect(isSameOwner({id:'a',revision:1},null)).toBe(false);
    expect(isSameOwner(null,{id:'a',revision:1})).toBe(false);
    expect(isSameOwner({id:'a',revision:1},{id:'a',revision:1})).toBe(true);
  });
});
