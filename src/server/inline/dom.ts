// Minimal HTML DOM for the inliner. Nodes are per-render working state and
// are never cached; only the CSS parse artifact is shared (see cache.ts).

export type Root = {kind: 'root'; parent: null; children: Node[]};
export type Element = {kind: 'element'; tag: string; attrs: Map<string, string>; parent: Parent; children: Node[]};
export type Text = {kind: 'text'; parent: Parent; text: string};
export type Raw = {kind: 'raw'; parent: Parent; html: string}; // doctype, comments — kept verbatim
export type Node = Element | Text | Raw;
export type Parent = Root | Element;

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

export function parseHtml(html: string): Root {
  const root: Root = {kind: 'root', parent: null, children: []};
  let current: Parent = root;
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        const stop = end === -1 ? n : end + 3;
        current.children.push({kind: 'raw', parent: current, html: html.slice(i, stop)});
        i = stop;
        continue;
      }
      if (html[i + 1] === '!' || html[i + 1] === '?') {
        const end = html.indexOf('>', i + 2);
        const stop = end === -1 ? n : end + 1;
        current.children.push({kind: 'raw', parent: current, html: html.slice(i, stop)});
        i = stop;
        continue;
      }
      if (html[i + 1] === '/') {
        const end = html.indexOf('>', i + 2);
        const stop = end === -1 ? n : end + 1;
        const name = html.slice(i + 2, end === -1 ? n : end).trim().toLowerCase();
        let p: Parent | null = current as Parent; // `as Parent` breaks a circular flow-narrowing dependency
        let found: Element | null = null;
        while (p && p.kind === 'element') {
          if (p.tag === name) {found = p; break;}
          p = p.parent;
        }
        if (found) current = found.parent ?? root;
        i = stop;
        continue;
      }
      const open = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i));
      if (!open) {
        current.children.push({kind: 'text', parent: current, text: '<'});
        i++;
        continue;
      }
      const tag = open[1].toLowerCase();
      let j = i + open[0].length;
      const attrs = new Map<string, string>();
      let selfClosing = false;
      while (j < n) {
        while (j < n && /\s/.test(html[j])) j++;
        if (j >= n) break;
        if (html[j] === '>') {j++; break;}
        if (html[j] === '/' && html[j + 1] === '>') {selfClosing = true; j += 2; break;}
        let name = '';
        while (j < n && !/[\s=/>]/.test(html[j])) {name += html[j]; j++;}
        if (!name) {j++; continue;}
        while (j < n && /\s/.test(html[j])) j++;
        let value = '';
        if (html[j] === '=') {
          j++;
          while (j < n && /\s/.test(html[j])) j++;
          if (html[j] === '"' || html[j] === "'") {
            const q = html[j];
            const end = html.indexOf(q, j + 1);
            value = end === -1 ? html.slice(j + 1) : html.slice(j + 1, end);
            j = end === -1 ? n : end + 1;
          } else {
            let v = '';
            while (j < n && !/[\s>]/.test(html[j])) {v += html[j]; j++;}
            value = v;
          }
        }
        attrs.set(name.toLowerCase(), value);
      }
      const el: Element = {kind: 'element', tag, attrs, parent: current, children: []};
      current.children.push(el);
      i = j;
      if (RAW_TEXT_ELEMENTS.has(tag)) {
        const close = html.toLowerCase().indexOf('</' + tag, i);
        const textEnd = close === -1 ? n : close;
        if (textEnd > i) el.children.push({kind: 'text', parent: el, text: html.slice(i, textEnd)});
        if (close === -1) i = n;
        else {
          const gt = html.indexOf('>', close);
          i = gt === -1 ? n : gt + 1;
        }
      } else if (!selfClosing && !VOID_ELEMENTS.has(tag)) {
        current = el;
      }
      continue;
    }
    const next = html.indexOf('<', i);
    const stop = next === -1 ? n : next;
    current.children.push({kind: 'text', parent: current, text: html.slice(i, stop)});
    i = stop;
  }
  return root;
}

export function serialize(root: Root): string {
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.kind === 'text') {
      out.push(node.text); // kept verbatim so existing entities round-trip
    } else if (node.kind === 'raw') {
      out.push(node.html);
    } else {
      const attrs = [...node.attrs]
        .map(([k, v]) => (v === '' ? k : `${k}="${v.replace(/"/g, '&quot;')}"`))
        .join(' ');
      out.push('<' + node.tag + (attrs ? ' ' + attrs : '') + '>');
      if (!VOID_ELEMENTS.has(node.tag)) {
        node.children.forEach(walk);
        out.push(`</${node.tag}>`);
      }
    }
  };
  root.children.forEach(walk);
  return out.join('');
}

export function* allElements(parent: Parent): Generator<Element> {
  for (const child of parent.children) {
    if (child.kind === 'element') {
      yield child;
      yield* allElements(child);
    }
  }
}

export function previousElementSibling(el: Element): Element | null {
  const siblings = el.parent?.children ?? [];
  const index = siblings.indexOf(el);
  for (let i = index - 1; i >= 0; i--) {
    if (siblings[i].kind === 'element') return siblings[i] as Element;
  }
  return null;
}
