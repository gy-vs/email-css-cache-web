// Minimal HTML parser/serializer for the render pipeline.
// Parsed values (text, attribute values) are kept in their raw source form so
// serialization round-trips; only values written via setAttr are escaped.

export type HtmlNode = DocumentNode | ElementNode | TextNode | CommentNode | DoctypeNode;

export interface Attr {
  name: string;
  value: string;
}

export interface DocumentNode {
  type: 'document';
  children: HtmlNode[];
  parent: null;
}

export interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Attr[];
  children: HtmlNode[];
  parent: DocumentNode | ElementNode | null;
}

export interface TextNode {
  type: 'text';
  text: string;
  parent: DocumentNode | ElementNode | null;
}

export interface CommentNode {
  type: 'comment';
  text: string;
  parent: DocumentNode | ElementNode | null;
}

export interface DoctypeNode {
  type: 'doctype';
  text: string;
  parent: DocumentNode | ElementNode | null;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

// Walks up from `current` to the nearest open element with this tag and
// closes it (anything left unclosed inside is implicitly closed). Stray
// close tags without a matching open element are ignored.
function closeElement(
  current: DocumentNode | ElementNode,
  doc: DocumentNode,
  name: string,
): DocumentNode | ElementNode {
  let node: DocumentNode | ElementNode | null = current;
  while (node !== null) {
    if (node.type === 'element' && node.tag === name) return node.parent ?? doc;
    node = node.parent;
  }
  return current;
}

export function parseHtml(html: string): DocumentNode {
  const doc: DocumentNode = {type: 'document', children: [], parent: null};
  let current: DocumentNode | ElementNode = doc;
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const text = next === -1 ? html.slice(i) : html.slice(i, next);
      current.children.push({type: 'text', text, parent: current});
      i = next === -1 ? n : next;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const text = end === -1 ? html.slice(i + 4) : html.slice(i + 4, end);
      current.children.push({type: 'comment', text, parent: current});
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      const text = end === -1 ? html.slice(i + 2) : html.slice(i + 2, end);
      if (html[i + 1] === '!') {
        current.children.push({type: 'doctype', text: text.trim(), parent: current});
      }
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[i + 1] === '/') {
      const end = html.indexOf('>', i);
      if (end === -1) break;
      const name = html.slice(i + 2, end).trim().toLowerCase();
      current = closeElement(current, doc, name);
      i = end + 1;
      continue;
    }
    const tagMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(i));
    if (!tagMatch) {
      current.children.push({type: 'text', text: '<', parent: current});
      i++;
      continue;
    }
    const tag = tagMatch[1].toLowerCase();
    let j = i + tagMatch[0].length;
    const attrs: Attr[] = [];
    while (j < n) {
      while (j < n && /\s/.test(html[j])) j++;
      if (html[j] === '>') {
        j++;
        break;
      }
      if (html[j] === '/' && html[j + 1] === '>') {
        j += 2;
        break;
      }
      if (j >= n) break;
      const nameMatch = /^[^\s=/>]+/.exec(html.slice(j));
      if (!nameMatch) {
        j++;
        continue;
      }
      const name = nameMatch[0].toLowerCase();
      j += nameMatch[0].length;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = end === -1 ? html.slice(j + 1) : html.slice(j + 1, end);
          j = end === -1 ? n : end + 1;
        } else {
          const valueMatch = /^[^\s>]*/.exec(html.slice(j));
          value = valueMatch ? valueMatch[0] : '';
          j += value.length;
        }
      }
      if (!attrs.some(attr => attr.name === name)) attrs.push({name, value});
    }
    const el: ElementNode = {type: 'element', tag, attrs, children: [], parent: current};
    current.children.push(el);
    i = j;
    if (VOID_ELEMENTS.has(tag)) continue;
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const lower = html.toLowerCase();
      const close = lower.indexOf('</' + tag, j);
      const text = close === -1 ? html.slice(j) : html.slice(j, close);
      if (text) el.children.push({type: 'text', text, parent: el});
      if (close === -1) {
        i = n;
      } else {
        const end = html.indexOf('>', close);
        i = end === -1 ? n : end + 1;
      }
      continue;
    }
    current = el;
  }
  return doc;
}

export function serializeHtml(node: HtmlNode): string {
  switch (node.type) {
    case 'document':
      return node.children.map(serializeHtml).join('');
    case 'text':
      return node.text;
    case 'comment':
      return `<!--${node.text}-->`;
    case 'doctype':
      return `<!${node.text}>`;
    case 'element': {
      const attrs = node.attrs
        .map(attr => (attr.value === '' ? attr.name : `${attr.name}="${attr.value}"`))
        .join(' ');
      const open = attrs ? `<${node.tag} ${attrs}>` : `<${node.tag}>`;
      if (VOID_ELEMENTS.has(node.tag)) return open;
      return open + node.children.map(serializeHtml).join('') + `</${node.tag}>`;
    }
  }
}

export function getAttr(el: ElementNode, name: string): string | undefined {
  const found = el.attrs.find(attr => attr.name === name.toLowerCase());
  return found?.value;
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function setAttr(el: ElementNode, name: string, value: string): void {
  const key = name.toLowerCase();
  const found = el.attrs.find(attr => attr.name === key);
  const escaped = escapeAttr(value);
  if (found) found.value = escaped;
  else el.attrs.push({name: key, value: escaped});
}

export function removeAttr(el: ElementNode, name: string): void {
  const key = name.toLowerCase();
  el.attrs = el.attrs.filter(attr => attr.name !== key);
}

export function removeFromParent(el: ElementNode): void {
  const parent = el.parent;
  if (!parent) return;
  const index = parent.children.indexOf(el);
  if (index !== -1) parent.children.splice(index, 1);
  el.parent = null;
}

export function walkElements(root: DocumentNode | ElementNode, visit: (el: ElementNode) => void): void {
  for (const child of root.children) {
    if (child.type !== 'element') continue;
    visit(child);
    walkElements(child, visit);
  }
}

export function classList(el: ElementNode): string[] {
  const value = getAttr(el, 'class');
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

export function previousElementSibling(el: ElementNode): ElementNode | null {
  const parent = el.parent;
  if (!parent) return null;
  const index = parent.children.indexOf(el);
  for (let i = index - 1; i >= 0; i--) {
    const sibling = parent.children[i];
    if (sibling.type === 'element') return sibling;
  }
  return null;
}
