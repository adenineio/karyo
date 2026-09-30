// The sealed frame a kit's script runs in (docs/KITS.md "Code in kits", "The sandbox"). Only src/kits/script-plate.ts
// makes one, and only after the user trusted that exact version of the kit (or it is built in).
//
//   <iframe sandbox="allow-scripts" srcdoc="…">   no allow-same-origin: the frame has an opaque origin, so it can't
//                                                  reach this page's DOM, storage, cookies or the dev server's token;
//                                                  no allow-forms / -popups / -top-navigation / -modals
//   Content-Security-Policy (in the frame, and     default-src 'none'; connect-src 'none' (no fetch, XHR, WebSocket,
//   required by the iframe's csp attribute)        beacon); images and fonts from data: only; scripts: the bootstrap
//                                                  (by nonce) and the kit's module (a blob: URL it makes itself). The
//                                                  csp attribute makes the browser refuse to show any other document
//                                                  in the frame that doesn't take on the same policy (a script that
//                                                  navigates its frame away gets an error page, and is then removed)
//
// Data goes in and events come out by messages, nothing else:
//   frame → host  { k: 'karyo-kit', type: 'hello' }            once, by window.postMessage: the bootstrap is ready
//   host → frame  { k: 'karyo-host', type: 'run', source, ctx } by window.postMessage, handing over a MessagePort;
//                 then { type: 'update', ctx } | { type: 'dispose' } on that port
//   frame → host  { type: 'rendered' | 'state' | 'status' | 'error', data } on that port only: a document that
//                 replaced the bootstrap's (the frame navigated) has no port and is not heard
// Every message from the frame is untrusted input: only these types are read, sizes are capped, text is shown as text.

export interface ScriptCtx {
  /** The model the plate is drawn from (its kit kinds' default categories filled in). */
  model: unknown;
  flow?: unknown;
  tour?: unknown;
  plate: { id: string; title: string; kit: string; options: Record<string, unknown> };
  /** The theme's colours and fonts by short name (bg, fg, muted, line, accent, accent2, ok, card, cardBorder, radius,
   *  font, fontDisplay, fontMono, cat: [8], catOther); the frame's :root also carries them as --pl-* variables. */
  theme: Record<string, unknown>;
  vars: Record<string, string>;
  size: { w: number; h: number };
  state: unknown;
}

export interface SandboxHooks {
  onState(s: unknown): void;
  onStatus(t: string): void;
  onError(msg: string): void;
}

const MAX_STATE = 100_000, MAX_STATUS = 300, MAX_ERROR = 2000;

const cspOf = (nonce: string) => [
  "default-src 'none'", `script-src 'nonce-${nonce}' blob:`, "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "worker-src 'none'", "media-src 'none'", "object-src 'none'", "manifest-src 'none'",
].join('; ');

/** The frame's page: a strict CSP and the bootstrap that loads the kit's module and calls it. */
function srcdoc(nonce: string): string {
  const csp = cspOf(nonce);
  const boot = `(() => {
  const host = document.getElementById('host');
  let mod = null, ctx = null, port = null;
  const send = (type, data) => { if (port) port.postMessage({ type, data }); };
  const emit = (type, data) => {
    if (type === 'state') { let d; try { d = JSON.parse(JSON.stringify(data === undefined ? null : data)); } catch { return; } send('state', d); }
    else if (type === 'status') send('status', String(data == null ? '' : data).slice(0, ${MAX_STATUS}));
  };
  const apply = (c) => {
    const r = document.documentElement.style;
    for (const [k, v] of Object.entries(c.vars || {})) if (/^--pl-[a-z0-9-]+$/.test(k)) r.setProperty(k, String(v));
    host.style.width = c.size.w + 'px'; host.style.height = c.size.h + 'px';
  };
  const api = (c) => Object.freeze({ ...c, emit });
  const fail = (e) => send('error', String((e && (e.stack || e.message)) || e).slice(0, ${MAX_ERROR}));
  addEventListener('error', (e) => fail(e.error || e.message));
  addEventListener('unhandledrejection', (e) => fail(e.reason));
  const onHost = async (m) => {
    try {
      if (m.type === 'run' && !mod) {
        ctx = m.ctx; apply(ctx);
        const url = URL.createObjectURL(new Blob([m.source], { type: 'text/javascript' }));
        mod = await import(url);
        if (typeof mod.render !== 'function') throw new Error('the script exports no render(host, ctx) function');
        await mod.render(host, api(ctx));
        send('rendered');
      } else if (m.type === 'update' && mod) {
        ctx = { ...ctx, ...m.ctx }; apply(ctx);
        if (typeof mod.update === 'function') await mod.update(host, api(ctx));
        else { host.replaceChildren(); await mod.render(host, api(ctx)); }
        send('rendered');
      } else if (m.type === 'dispose' && mod) {
        if (typeof mod.dispose === 'function') await mod.dispose(host);
      }
    } catch (err) { fail(err); }
  };
  // the host answers hello once, with the port every later message goes through
  const first = (e) => {
    const m = e.data;
    if (e.source !== parent || !m || m.k !== 'karyo-host' || m.type !== 'run' || !e.ports[0] || port) return;
    removeEventListener('message', first);
    port = e.ports[0];
    port.onmessage = (ev) => { if (ev.data && typeof ev.data === 'object') onHost(ev.data); };
    onHost(m);
  };
  addEventListener('message', first);
  parent.postMessage({ k: 'karyo-kit', type: 'hello' }, '*');
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;color:var(--pl-fg);font-family:var(--pl-font)}#host{position:relative;overflow:hidden}</style>`
    + `</head><body><div id="host"></div><script nonce="${nonce}">${boot}</script></body></html>`;
}

const nonce = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); };

/** A kit script running in a sealed frame inside `parent`. `rendered` settles on its first drawing (or its error). */
export class KitSandbox {
  readonly frame: HTMLIFrameElement;
  private pending: { ok: () => void; fail: (e: Error) => void } | null = null;
  private disposed = false;
  private started = false;
  private loads = 0;
  private port: MessagePort | null = null;
  /** The frame's hello, the one window message read from it: answered once, with the port and the kit's source. */
  private onMsg = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow || this.started) return;
    const m = e.data as { k?: unknown; type?: unknown } | null;
    if (!m || typeof m !== 'object' || m.k !== 'karyo-kit' || m.type !== 'hello') return;
    this.started = true;
    removeEventListener('message', this.onMsg);
    const ch = new MessageChannel();
    this.port = ch.port1;
    this.port.onmessage = (ev) => this.onPort(ev.data);
    this.frame.contentWindow?.postMessage({ k: 'karyo-host', type: 'run', source: this.source, ctx: this.ctx }, '*', [ch.port2]);
  };
  private onPort = (m0: unknown) => {
    const m = m0 as { type?: unknown; data?: unknown } | null;
    if (!m || typeof m !== 'object' || this.disposed) return;
    switch (m.type) {
      case 'rendered': this.settle(); break;
      case 'state': { let s = ''; try { s = JSON.stringify(m.data ?? null); } catch { break; } if (s.length <= MAX_STATE) this.hooks.onState(JSON.parse(s)); break; }
      case 'status': this.hooks.onStatus(String(m.data ?? '').slice(0, MAX_STATUS)); break;
      case 'error': { const msg = String(m.data ?? '').slice(0, MAX_ERROR); this.hooks.onError(msg); this.settle(new Error(msg)); break; }
    }
  };

  constructor(parent: HTMLElement, private source: string, private ctx: ScriptCtx, private hooks: SandboxHooks, timeoutMs = 10_000) {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('title', `drawn by kit ${ctx.plate.kit}'s own code`);
    f.className = 'ks-frame';
    Object.assign(f.style, { width: `${ctx.size.w}px`, height: `${ctx.size.h}px`, border: '0', display: 'block', background: 'transparent', colorScheme: 'normal' });
    this.frame = f;
    this.rendered = new Promise<void>((ok, fail) => { this.pending = { ok, fail }; });
    this.rendered.catch(() => {});
    setTimeout(() => this.settle(new Error(`the kit's script didn't draw within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    addEventListener('message', this.onMsg);
    // the frame loads its page once; another load means the script navigated it away (and out of its CSP): stop it
    f.addEventListener('load', () => {
      if (++this.loads < 2 || this.disposed) return;
      const msg = 'the kit\'s script tried to leave its frame (it navigated it elsewhere); Karyo stopped it';
      this.hooks.onError(msg);
      this.settle(new Error(msg));
      this.dispose();
    });
    const n = nonce();
    // the policy the frame must keep: the browser refuses to show a document there that doesn't take it on
    f.setAttribute('csp', cspOf(n));
    f.srcdoc = srcdoc(n);
    parent.append(f);
  }
  readonly rendered: Promise<void>;

  private settle(err?: Error) { const p = this.pending; if (!p) return; this.pending = null; if (err) p.fail(err); else p.ok(); }
  private post(m: unknown) { if (!this.disposed) this.port?.postMessage(m); }

  /** New inputs (the theme, the state, the size): the script draws again. Resolves once it has. */
  update(ctx: Partial<ScriptCtx>): Promise<void> {
    this.ctx = { ...this.ctx, ...ctx };
    if (ctx.size) Object.assign(this.frame.style, { width: `${ctx.size.w}px`, height: `${ctx.size.h}px` });
    const p = new Promise<void>((ok, fail) => {
      const prev = this.pending;
      this.pending = { ok: () => { prev?.ok(); ok(); }, fail: (e) => { prev?.fail(e); fail(e); } };
    });
    p.catch(() => {});
    this.post({ type: 'update', ctx });
    setTimeout(() => this.settle(new Error('the kit\'s script didn\'t redraw')), 10_000);
    return p;
  }

  dispose() {
    if (this.disposed) return;
    this.post({ type: 'dispose' });
    this.disposed = true;
    removeEventListener('message', this.onMsg);
    this.port?.close();
    this.settle();
    this.frame.remove();
  }
}
