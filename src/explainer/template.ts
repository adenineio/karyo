// The component template language, markdown-lite, CSS scoping and SVG sanitizing: pure string
// functions shared by the browser plate and the bun/node tooling (no DOM). See docs/EXPLAINERS.md.
//
//   {{prop}}            escaped text (arrays join with ", "; objects render nothing)
//   {{{prop}}}          markdown-lite: escaped first, then formatted (paragraphs, lists, **b**, *i*, `code`, [a](url))
//   {{svg prop}}        an inline <svg> string, sanitized (no scripts, event handlers, foreignObject, javascript: urls)
//   {{#each items}}…{{this}} {{this.x}} {{@index}} {{@number}}…{{/each}}
//   {{#if prop}}…{{else}}…{{/if}}   {{#unless prop}}…{{/unless}}
//   {{#has prop}}…{{else}}…{{/has}}   (is set: any value but missing / null, so 0, false and "" count)
//   {{! a comment }}
// Names resolve against the innermost {{#each}} item first, then outwards to the element's props.

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ------------------------------------------------------------------ markdown-lite

const SAFE_URL = /^(https?:|mailto:|#|\.{0,2}\/|[^:]*$)/i;

/** Inline markdown-lite on already-plain text: escapes, then `code`, **bold**, *em*, _em_, ==mark==, [text](url). */
export function mdInline(src: string): string {
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
      const u = url.replace(/&amp;/g, '&');
      return SAFE_URL.test(u) ? `<a href="${esc(u)}">${text}</a>` : m;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/\s*\n\s*/g, ' ');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${esc(codes[+i]!)}</code>`);
}

/** Block markdown-lite: blank-line separated paragraphs; "- " / "* " bullet and "1. " numbered lists. */
export function mdLite(src: string): string {
  return String(src ?? '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).filter((b) => b.trim()).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => /^[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${mdInline(l.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every((l) => /^\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${mdInline(l.replace(/^\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    return `<p>${mdInline(lines.join('\n'))}</p>`;
  }).join('');
}

// ------------------------------------------------------------------ SVG

/** Keep an inline SVG string, minus anything that runs code. Anything that isn't an <svg> renders nothing. */
export function sanitizeSvg(src: unknown): string {
  const s = String(src ?? '').trim();
  if (!/^<svg[\s>]/i.test(s)) return '';
  return s
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*["']?)\s*javascript:[^"'\s>]*/gi, '$1#');
}

// ------------------------------------------------------------------ templates

type TNode =
  | { k: 'text'; s: string }
  | { k: 'var'; path: string; mode: 'esc' | 'md' | 'svg' }
  | { k: 'each'; path: string; body: TNode[] }
  | { k: 'if'; path: string; neg: boolean; has?: boolean; then: TNode[]; else: TNode[] };

export class TemplateError extends Error {}

const TAG = /\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}/g;
const PATH = /^(?:this|@index|@number|[A-Za-z_$][\w$-]*)(?:\.[A-Za-z_$][\w$-]*|\.\d+)*$/;

const cache = new Map<string, TNode[]>();

/** Parse a template (throws TemplateError on unbalanced blocks or bad tags). */
export function parseTemplate(tpl: string): TNode[] {
  const hit = cache.get(tpl);
  if (hit) return hit;
  const root: TNode[] = [];
  const stack: { node: TNode & { k: 'each' | 'if' }; into: TNode[]; line: number }[] = [];
  let out = root, last = 0;
  const lineAt = (i: number) => tpl.slice(0, i).split('\n').length;
  for (const m of tpl.matchAll(TAG)) {
    const i = m.index!;
    if (i > last) out.push({ k: 'text', s: tpl.slice(last, i) });
    last = i + m[0].length;
    if (m[1] !== undefined) {
      const p = m[1].trim();
      if (!PATH.test(p)) throw new TemplateError(`line ${lineAt(i)}: bad name in {{{${p}}}}`);
      out.push({ k: 'var', path: p, mode: 'md' });
      continue;
    }
    const t = m[2]!.trim();
    if (t.startsWith('!')) continue;
    let mm: RegExpMatchArray | null;
    if ((mm = t.match(/^#(each|if|unless|has)\s+(\S+)$/))) {
      if (!PATH.test(mm[2]!)) throw new TemplateError(`line ${lineAt(i)}: bad name in {{${t}}}`);
      const node: TNode & { k: 'each' | 'if' } = mm[1] === 'each' ? { k: 'each', path: mm[2]!, body: [] } : { k: 'if', path: mm[2]!, neg: mm[1] === 'unless', ...(mm[1] === 'has' ? { has: true } : {}), then: [], else: [] };
      out.push(node);
      stack.push({ node, into: out, line: lineAt(i) });
      out = node.k === 'each' ? node.body : node.then;
    } else if (t === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.node.k !== 'if') throw new TemplateError(`line ${lineAt(i)}: {{else}} outside {{#if}} / {{#unless}} / {{#has}}`);
      out = top.node.else;
    } else if ((mm = t.match(/^\/(each|if|unless|has)$/))) {
      const top = stack.pop();
      const want = mm[1] === 'each' ? 'each' : 'if';
      if (!top || top.node.k !== want) throw new TemplateError(`line ${lineAt(i)}: {{/${mm[1]}}} without a matching {{#${mm[1]}}}`);
      out = top.into;
    } else if ((mm = t.match(/^svg\s+(\S+)$/))) {
      if (!PATH.test(mm[1]!)) throw new TemplateError(`line ${lineAt(i)}: bad name in {{${t}}}`);
      out.push({ k: 'var', path: mm[1]!, mode: 'svg' });
    } else if (PATH.test(t)) {
      out.push({ k: 'var', path: t, mode: 'esc' });
    } else throw new TemplateError(`line ${lineAt(i)}: unknown tag {{${t}}}`);
  }
  if (stack.length) { const top = stack[stack.length - 1]!; throw new TemplateError(`line ${top.line}: {{#${top.node.k === 'each' ? 'each' : top.node.has ? 'has' : top.node.neg ? 'unless' : 'if'} ${top.node.path}}} is never closed`); }
  if (last < tpl.length) out.push({ k: 'text', s: tpl.slice(last) });
  cache.set(tpl, root);
  return root;
}

interface Scope { v: unknown; i: number; n: number }

function lookup(path: string, scopes: Scope[]): unknown {
  const top = scopes[scopes.length - 1]!;
  if (path === '@index') return top.i;
  if (path === '@number') return top.i + 1;
  const parts = path.split('.');
  let v: unknown;
  if (parts[0] === 'this') { v = top.v; parts.shift(); }
  else {
    const head = parts[0]!;
    const own = (s: Scope) => s.v !== null && typeof s.v === 'object' && !Array.isArray(s.v) && head in (s.v as object);
    const s = [...scopes].reverse().find(own);
    v = s ? s.v : undefined;
  }
  for (const p of parts) { if (v === null || v === undefined || typeof v !== 'object') return undefined; v = (v as Record<string, unknown>)[p]; }
  return v;
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0));
const str = (v: unknown): string => (v === undefined || v === null ? '' : Array.isArray(v) ? v.map(str).join(', ') : typeof v === 'object' ? '' : String(v));

function run(nodes: TNode[], scopes: Scope[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.k === 'text') out += n.s;
    else if (n.k === 'var') {
      const v = lookup(n.path, scopes);
      out += n.mode === 'esc' ? esc(str(v)) : n.mode === 'md' ? (v === undefined || v === null ? '' : mdLite(str(v))) : sanitizeSvg(v);
    } else if (n.k === 'each') {
      const v = lookup(n.path, scopes);
      if (Array.isArray(v)) v.forEach((item, i) => { out += run(n.body, [...scopes, { v: item, i, n: v.length }]); });
    } else {
      const v = lookup(n.path, scopes);
      const ok = n.has ? v !== undefined && v !== null : truthy(v) !== n.neg;
      out += run(ok ? n.then : n.else, scopes);
    }
  }
  return out;
}

/** Render a component template with an element's props. Pure; throws TemplateError on a malformed template. */
export function renderTemplate(tpl: string, props: Record<string, unknown>): string {
  return run(parseTemplate(tpl), [{ v: props ?? {}, i: 0, n: 1 }]);
}

/** Props a template tweens: `data-k-num="prop"` and both sides of `data-k-scale="value/max"`. */
export function tweenProps(tpl: string): string[] {
  const out = new Set<string>();
  for (const m of tpl.matchAll(/data-k-num\s*=\s*"([^"]+)"/g)) out.add(m[1]!.trim());
  for (const m of tpl.matchAll(/data-k-scale\s*=\s*"([^"]+)"/g)) for (const p of m[1]!.split('/')) if (!/^[\d.]+$/.test(p.trim())) out.add(p.trim());
  return [...out];
}

// ------------------------------------------------------------------ CSS scoping

/**
 * Scope a component's stylesheet under `.kc-<name>` (the element's wrapper). Every selector is
 * prefixed: `.title` → `.kc-name .title`. `:host` (or a leading `&`) is the wrapper itself:
 * `:host` → `.kc-name`, `:host(.is-lit)` → `.kc-name.is-lit`, `&:hover` → `.kc-name:hover`.
 * @media / @supports / @container blocks are scoped inside; @keyframes, @font-face and @import are
 * dropped (the engine owns time; fonts come from the page). `host` replaces `.kc-<name>` (a kit kind's sections
 * are scoped to `.ks-<name>`, docs/KITS.md).
 */
export function scopeCss(css: string, name: string, host = `.kc-${name}`): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const prefix = (sel: string) => sel.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.startsWith(':host')) return s.replace(/^:host\(([^)]*)\)/, `${host}$1`).replace(/^:host/, host);
    if (s.startsWith('&')) return host + s.slice(1);
    return `${host} ${s}`;
  }).join(', ');
  const block = (s: string, i: number): [string, number] => {
    // s[i] is just after "{": return the inner text and the index after the matching "}"
    let depth = 1, j = i, q: string | null = null;
    for (; j < s.length; j++) {
      const c = s[j]!;
      if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    return [s.slice(i, j), j + 1];
  };
  const walk = (s: string): string => {
    let out = '', i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      const semi = s.indexOf(';', i);
      if (open < 0) break;
      const head0 = s.slice(i, open);
      // a statement at-rule (@import …;) before the next block
      if (semi >= 0 && semi < open && /^\s*@/.test(s.slice(i, semi))) { i = semi + 1; continue; }
      const head = head0.trim();
      const [inner, next] = block(s, open + 1);
      i = next;
      if (head.startsWith('@')) {
        if (/^@(media|supports|container|layer)\b/.test(head)) out += `${head} {\n${walk(inner)}}\n`;
        // @keyframes, @font-face, @page, …: dropped
      } else if (head) out += `${prefix(head)} {${inner}}\n`;
    }
    return out;
  };
  return walk(src);
}

/** Problems in a component stylesheet the engine would fight or drop. */
export function cssProblems(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  if (/(^|[;{\s])(transition|animation)(-[a-z-]+)?\s*:/m.test(src)) out.push('uses transition/animation: the engine owns every change over time (they are disabled inside plates)');
  if (/@keyframes/.test(src)) out.push('declares @keyframes (dropped: the engine owns time)');
  if (/@import|@font-face/.test(src)) out.push('uses @import/@font-face (dropped: fonts come from the page)');
  if (/url\(\s*["']?(https?:)?\/\//i.test(src)) out.push('loads a remote url(): explainers must work offline');
  if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(src)) out.push('hard-codes colours: use the theme tokens var(--pl-*) so every theme works');
  return out;
}
