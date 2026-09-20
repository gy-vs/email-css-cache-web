import {describe, expect, it} from 'vitest';
import {renderPreview, RenderCancelled} from '../src/server/render';
import {StylesheetCache} from '../src/server/css/cache';

describe('cache separation', () => {
  it('renders the same CSS against different DOMs without leaking matches', async () => {
    const cache = new StylesheetCache(10);
    const css = '.promo{color:red}';
    const first = await renderPreview('<p class="promo">A</p>', css, {cache});
    const second = await renderPreview('<p class="other">B</p>', css, {cache});
    expect(first.html).toBe('<p class="promo" style="color: red">A</p>');
    expect(second.html).toBe('<p class="other">B</p>');
    const stats = cache.stats();
    expect(stats.parses).toBe(1);
    expect(stats.hits).toBe(1);
    // And in the opposite order the results are identical.
    const cache2 = new StylesheetCache(10);
    const secondFirst = await renderPreview('<p class="other">B</p>', css, {cache: cache2});
    const firstSecond = await renderPreview('<p class="promo">A</p>', css, {cache: cache2});
    expect(secondFirst.html).toBe('<p class="other">B</p>');
    expect(firstSecond.html).toBe('<p class="promo" style="color: red">A</p>');
  });

  it('caches only pure data: artifacts are frozen and contain no node references', async () => {
    const cache = new StylesheetCache(10);
    const css = '.promo{color:red}';
    await renderPreview('<p class="promo">A</p>', css, {cache});
    const artifact = cache.get(css, {mode: 'stylesheet'});
    // DOM nodes would form cycles via parent pointers; pure data serializes.
    expect(() => JSON.stringify(artifact)).not.toThrow();
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.rules)).toBe(true);
    expect(() => {
      (artifact as {rules: unknown}).rules = [];
    }).toThrow();
  });

  it('keys the cache by parse options as well as CSS text', async () => {
    const cache = new StylesheetCache(10);
    cache.get('color: red', {mode: 'declarations'});
    cache.get('color: red', {mode: 'stylesheet'});
    cache.get('color: red', {mode: 'declarations'});
    const stats = cache.stats();
    expect(stats.parses).toBe(2);
    expect(stats.hits).toBe(1);
  });

  it('evicts least recently used entries and re-parses correctly', async () => {
    const cache = new StylesheetCache(2);
    await renderPreview('<p class="a">1</p>', '.a{color:red}', {cache});
    await renderPreview('<p class="b">2</p>', '.b{color:green}', {cache});
    // Touch .a so .b becomes the oldest, then insert a third entry.
    await renderPreview('<p class="a">1</p>', '.a{color:red}', {cache});
    await renderPreview('<p class="c">3</p>', '.c{color:blue}', {cache});
    expect(cache.stats().evictions).toBe(1);
    expect(cache.stats().size).toBe(2);
    // .b was evicted; rendering it again still produces correct output.
    const again = await renderPreview('<p class="b">2</p>', '.b{color:green}', {cache});
    expect(again.html).toBe('<p class="b" style="color: green">2</p>');
    expect(cache.stats().evictions).toBe(2);
  });
});

describe('cascade', () => {
  it('resolves specificity and source order', async () => {
    const cache = new StylesheetCache(10);
    const bySpecificity = await renderPreview(
      '<p class="a" id="b">x</p>',
      'p{color:red} .a{color:green} #b{color:blue}',
      {cache},
    );
    expect(bySpecificity.html).toBe('<p class="a" id="b" style="color: blue">x</p>');
    const byOrder = await renderPreview('<p class="a">x</p>', '.a{color:red} .a{color:blue}', {cache});
    expect(byOrder.html).toBe('<p class="a" style="color: blue">x</p>');
  });

  it('keeps an existing inline !important above stylesheet !important', async () => {
    const result = await renderPreview(
      '<p style="color: red !important">x</p>',
      'p{color:blue !important}',
      {cache: new StylesheetCache(10)},
    );
    expect(result.html).toBe('<p style="color: red !important">x</p>');
  });

  it('lets stylesheet !important override a normal inline style', async () => {
    const result = await renderPreview(
      '<p style="color: red">x</p>',
      'p{color:blue !important}',
      {cache: new StylesheetCache(10)},
    );
    expect(result.html).toBe('<p style="color: blue !important">x</p>');
  });

  it('keeps a normal inline style above normal stylesheet rules and merges declarations', async () => {
    const result = await renderPreview(
      '<p style="color: red; font-weight: bold">x</p>',
      'p{color:blue; line-height:1.5}',
      {cache: new StylesheetCache(10)},
    );
    expect(result.html).toBe('<p style="color: red; font-weight: bold; line-height: 1.5">x</p>');
  });
});

describe('robustness', () => {
  it('skips pseudo-class rules with a diagnostic and keeps inlining the rest', async () => {
    const result = await renderPreview(
      '<p>x</p><a href="#">y</a>',
      'a:hover{color:red} p{color:blue}',
      {cache: new StylesheetCache(10)},
    );
    expect(result.html).toBe('<p style="color: blue">x</p><a href="#">y</a>');
    expect(result.diagnostics.some(d => d.code === 'unsupported_selector')).toBe(true);
  });

  it('contains a failing rule so it cannot pollute later templates', async () => {
    const cache = new StylesheetCache(10);
    const broken = await renderPreview(
      '<p class="ok">a</p>',
      '@keyframes spin{from{opacity:0}to{opacity:1}} .broken{color:} .ok{color:teal}',
      {cache},
    );
    expect(broken.html).toBe('<p class="ok" style="color: teal">a</p>');
    expect(broken.diagnostics.some(d => d.code === 'unsupported_at_rule')).toBe(true);
    expect(broken.diagnostics.some(d => d.code === 'parse_error')).toBe(true);
    const clean = await renderPreview('<p class="ok">b</p>', '.ok{color:teal}', {cache});
    expect(clean.html).toBe('<p class="ok" style="color: teal">b</p>');
    expect(clean.diagnostics).toEqual([]);
  });

  it('inlines <style> blocks from the document and removes them', async () => {
    const result = await renderPreview(
      '<html><head><style>.a{color:red}</style></head><body><p class="a">x</p></body></html>',
      '',
      {cache: new StylesheetCache(10)},
    );
    expect(result.html).toBe('<html><head></head><body><p class="a" style="color: red">x</p></body></html>');
  });
});

describe('media rules', () => {
  const css =
    'p{color:blue} @media (max-width: 600px){p{font-size:14px}} @media print{p{color:black}} @media (min-width: 900px){p{font-size:20px}}';

  it('applies rules only when the media context matches', async () => {
    const cache = new StylesheetCache(10);
    const narrow = await renderPreview('<p>x</p>', css, {cache, media: {type: 'screen', width: 500}});
    expect(narrow.html).toBe('<p style="color: blue; font-size: 14px">x</p>');
    const wide = await renderPreview('<p>x</p>', css, {cache, media: {type: 'screen', width: 950}});
    expect(wide.html).toBe('<p style="color: blue; font-size: 20px">x</p>');
    const print = await renderPreview('<p>x</p>', css, {cache, media: {type: 'print', width: 500}});
    expect(print.html).toBe('<p style="font-size: 14px; color: black">x</p>');
    // Same CSS text across all contexts: parsed once, matched per render.
    expect(cache.stats().parses).toBe(1);
  });

  it('skips unsupported media queries without failing the render', async () => {
    const result = await renderPreview(
      '<p>x</p>',
      '@media (orientation: landscape){p{color:red}} p{color:blue}',
      {cache: new StylesheetCache(10)},
    );
    expect(result.html).toBe('<p style="color: blue">x</p>');
    expect(result.diagnostics.some(d => d.code === 'unsupported_media_query')).toBe(true);
  });
});

describe('concurrency and cancellation', () => {
  it('isolates working state across concurrent renders', async () => {
    const cache = new StylesheetCache(10);
    const jobs = Array.from({length: 20}, (_, k) => {
      const even = k % 2 === 0;
      const css = even ? '.x{color:blue}' : 'a:hover{color:red} .x{color:green}';
      const html = `<div>${Array.from({length: 300}, (_, i) => `<p class="x">${k}-${i}</p>`).join('')}</div>`;
      return renderPreview(html, css, {cache}).then(result => ({k, even, result}));
    });
    const results = await Promise.all(jobs);
    for (const {k, even, result} of results) {
      expect(result.html).toContain(`${k}-0`);
      expect(result.html).toContain(even ? 'color: blue' : 'color: green');
      expect(result.html).not.toContain('hover');
      const hasDiagnostic = result.diagnostics.some(d => d.code === 'unsupported_selector');
      expect(hasDiagnostic).toBe(!even);
    }
  });

  it('cancels a render via AbortSignal and leaves the cache consistent', async () => {
    const cache = new StylesheetCache(10);
    const bigHtml = `<div>${Array.from({length: 5000}, (_, i) => `<p class="x">${i}</p>`).join('')}</div>`;
    const ac = new AbortController();
    const pending = renderPreview(bigHtml, '.x{color:red}', {cache, signal: ac.signal});
    setTimeout(() => ac.abort(), 0);
    await expect(pending).rejects.toBeInstanceOf(RenderCancelled);
    // The cache still serves correct renders afterwards.
    const after = await renderPreview('<p class="x">y</p>', '.x{color:red}', {cache});
    expect(after.html).toBe('<p class="x" style="color: red">y</p>');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      renderPreview('<p>x</p>', 'p{color:red}', {signal: ac.signal, cache: new StylesheetCache(10)}),
    ).rejects.toBeInstanceOf(RenderCancelled);
  });
});
