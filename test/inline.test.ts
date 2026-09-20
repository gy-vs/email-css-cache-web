import {describe,expect,it} from 'vitest';
import {inlineCss,StylesheetCache,cacheKeyFor} from '../src/server/inline/inline';

describe('inlineCss',()=>{
  describe('same CSS, different DOMs (parse artifact vs per-DOM match)',()=>{
    const css='p { color: red; }';
    it('does not leak styles from the first DOM into the second',async()=>{
      const cache=new StylesheetCache(10);
      const a=await inlineCss('<p>alpha</p>',css,{cache});
      const b=await inlineCss('<div>beta</div><span>gamma</span>',css,{cache});
      expect(b.cacheHit).toBe(true); // second render reused the parse artifact
      expect(a.html).toBe('<p style="color: red">alpha</p>');
      expect(b.html).toBe('<div>beta</div><span>gamma</span>');
      expect(b.html).not.toContain('color: red');
    });
    it('is order-independent',async()=>{
      const cache=new StylesheetCache(10);
      const b=await inlineCss('<div>beta</div>',css,{cache});
      const a=await inlineCss('<p>alpha</p>',css,{cache});
      expect(b.html).not.toContain('color: red');
      expect(a.html).toContain('color: red');
    });
  });

  describe('concurrent previews',()=>{
    it('isolates working state across interleaved renders',async()=>{
      const cache=new StylesheetCache(100);
      const jobs=Array.from({length:25},(_,i)=>({
        html:`<p class="item-${i}">row ${i}</p>`,
        css:`.item-${i} { color: tone-${i}; }`,
      }));
      const results=await Promise.all(jobs.map(job=>inlineCss(job.html,job.css,{cache})));
      results.forEach((result,i)=>{
        expect(result.html).toBe(`<p class="item-${i}" style="color: tone-${i}">row ${i}</p>`);
      });
    });
    it('shares one artifact across concurrent same-CSS renders on different DOMs',async()=>{
      const cache=new StylesheetCache(10);
      const css='.lead { color: red; }';
      const docs=Array.from({length:10},(_,i)=>(i%2===0?`<p class="lead">doc ${i}</p>`:`<div>doc ${i}</div>`));
      const results=await Promise.all(docs.map(doc=>inlineCss(doc,css,{cache})));
      results.forEach((result,i)=>{
        if(i%2===0)expect(result.html).toContain('color: red');
        else expect(result.html).not.toContain('color: red');
      });
      expect(cache.stats.hits).toBeGreaterThanOrEqual(9);
    });
  });

  describe('media rules',()=>{
    const css='p { color: black; } @media (max-width: 600px) { p { color: blue; } } @media print { p { color: gray; } }';
    it('applies rules only when the media context matches',async()=>{
      const narrow=await inlineCss('<p>x</p>',css,{media:{width:480}});
      expect(narrow.html).toContain('color: blue');
      const wide=await inlineCss('<p>x</p>',css,{media:{width:1024}});
      expect(wide.html).toContain('color: black');
      expect(wide.html).not.toContain('blue');
    });
    it('matches media type and skips media rules without a context',async()=>{
      const print=await inlineCss('<p>x</p>',css,{media:{type:'print'}});
      expect(print.html).toContain('color: gray');
      const none=await inlineCss('<p>x</p>',css,{});
      expect(none.html).toContain('color: black');
      expect(none.diagnostics.filter(d=>d.code==='media_skipped')).toHaveLength(2);
    });
    it('reports unsupported media queries and keeps the rest',async()=>{
      const r=await inlineCss('<p>x</p>','@media (hover: hover) { p { color: red; } } p { color: green; }',{});
      expect(r.html).toContain('color: green');
      expect(r.diagnostics.some(d=>d.code==='unsupported_media_query')).toBe(true);
    });
  });

  describe('unsupported selectors',()=>{
    it('skips pseudo-class rules but keeps valid rules',async()=>{
      const r=await inlineCss('<a href="#">link</a><p>x</p>','a:hover { color: red; } p { color: green; }',{});
      expect(r.html).toContain('<p style="color: green">x</p>');
      expect(r.html).toContain('<a href="#">link</a>');
      expect(r.html).not.toContain('color: red');
      expect(r.diagnostics.some(d=>d.code==='unsupported_selector'&&d.detail==='a:hover')).toBe(true);
    });
    it('a broken rule does not pollute later templates sharing the cache',async()=>{
      const cache=new StylesheetCache(10);
      const css='div > > p { color: red; } p { color: green; }';
      const a=await inlineCss('<p>one</p>',css,{cache});
      expect(a.diagnostics.some(d=>d.code==='unsupported_selector')).toBe(true);
      expect(a.html).toContain('color: green');
      const b=await inlineCss('<div><p>two</p></div>',css,{cache});
      expect(b.cacheHit).toBe(true);
      expect(b.html).toBe('<div><p style="color: green">two</p></div>');
      expect(b.html).not.toContain('color: red');
    });
    it('a malformed declaration does not drop sibling declarations',async()=>{
      const r=await inlineCss('<p>x</p>','p { color: ; background: blue; }',{});
      expect(r.html).toContain('background: blue');
      expect(r.diagnostics.some(d=>d.code==='bad_declaration')).toBe(true);
    });
  });

  describe('cascade: specificity, important, existing style',()=>{
    it('keeps an existing inline !important over stylesheet !important',async()=>{
      const r=await inlineCss('<p style="color: red !important">x</p>','p { color: blue !important; }',{});
      expect(r.html).toBe('<p style="color: red !important">x</p>');
    });
    it('stylesheet !important beats a normal inline style',async()=>{
      const r=await inlineCss('<p style="color: red">x</p>','p { color: blue !important; }',{});
      expect(r.html).toBe('<p style="color: blue !important">x</p>');
    });
    it('a normal inline style beats a normal stylesheet rule',async()=>{
      const r=await inlineCss('<p style="color: red">x</p>','p { color: blue; }',{});
      expect(r.html).toContain('color: red');
      expect(r.html).not.toContain('blue');
    });
    it('higher specificity wins regardless of rule order',async()=>{
      const html='<p id="a" class="b">x</p>';
      const r1=await inlineCss(html,'.b { color: blue; } #a { color: green; }',{});
      const r2=await inlineCss(html,'#a { color: green; } .b { color: blue; }',{});
      expect(r1.html).toContain('color: green');
      expect(r2.html).toContain('color: green');
    });
    it('equal specificity falls back to source order',async()=>{
      const r=await inlineCss('<p class="b">x</p>','.b { color: red; } .b { color: blue; }',{});
      expect(r.html).toContain('color: blue');
    });
    it('merges stylesheet declarations into an existing style attribute',async()=>{
      const r=await inlineCss('<p style="color: red">x</p>','p { font-size: 14px; }',{});
      expect(r.html).toBe('<p style="color: red; font-size: 14px">x</p>');
    });
  });

  describe('cache',()=>{
    it('evicts least recently used entries and stays correct',async()=>{
      const cache=new StylesheetCache(2);
      for(let i=0;i<5;i++){
        const r=await inlineCss('<p>x</p>',`p { color: tone-${i}; }`,{cache});
        expect(r.html).toContain(`color: tone-${i}`);
      }
      expect(cache.size).toBe(2);
      expect(cache.stats.evictions).toBe(3);
      const again=await inlineCss('<p>x</p>','p { color: tone-0; }',{cache});
      expect(again.cacheHit).toBe(false);
      expect(again.html).toContain('color: tone-0');
      const hit=await inlineCss('<p>x</p>','p { color: tone-0; }',{cache});
      expect(hit.cacheHit).toBe(true);
    });
    it('keys entries by parse options as well as CSS text',async()=>{
      const cache=new StylesheetCache(10);
      const css='a:hover { color: red; } p { color: green; }';
      await inlineCss('<p>x</p>',css,{cache,keepUnsupported:true});
      await inlineCss('<p>x</p>',css,{cache,keepUnsupported:false});
      expect(cache.size).toBe(2);
      expect(cache.peek(cacheKeyFor(css,{keepUnsupported:true}))?.skipped).toHaveLength(1);
      expect(cache.peek(cacheKeyFor(css,{keepUnsupported:false}))?.skipped).toHaveLength(0);
    });
    it('stores only DOM-free, frozen artifacts',async()=>{
      const cache=new StylesheetCache(10);
      const css='p.lead { color: red; }';
      await inlineCss('<p class="lead">x</p>',css,{cache});
      const artifact=cache.peek(cacheKeyFor(css));
      expect(artifact).toBeDefined();
      expect(Object.isFrozen(artifact)).toBe(true);
      expect(()=>structuredClone(artifact)).not.toThrow();
      const json=JSON.stringify(artifact);
      expect(json).not.toContain('"kind":"element"');
      expect(json).not.toContain('"parent"');
      expect(json).not.toContain('"children"');
    });
  });

  describe('cancellation',()=>{
    const manyRules=Array.from({length:50},(_,i)=>`.c${i} { color: red; }`).join('\n');
    it('rejects when the signal is already aborted',async()=>{
      const cache=new StylesheetCache(10);
      const controller=new AbortController();
      controller.abort();
      await expect(inlineCss('<p>x</p>','p { color: red; }',{signal:controller.signal,cache})).rejects.toThrow(/aborted/i);
      expect(cache.size).toBe(0);
    });
    it('aborts mid-render and leaves later templates unaffected',async()=>{
      const cache=new StylesheetCache(10);
      const controller=new AbortController();
      const pending=inlineCss('<p class="c7">x</p>',manyRules,{signal:controller.signal,cache});
      controller.abort(); // lands while the render is yielding between rules
      await expect(pending).rejects.toThrow(/aborted/i);
      const ok=await inlineCss('<p class="c7">x</p>',manyRules,{cache});
      expect(ok.cacheHit).toBe(true); // artifact survived; partial cascade state did not
      expect(ok.html).toBe('<p class="c7" style="color: red">x</p>');
    });
  });
});
