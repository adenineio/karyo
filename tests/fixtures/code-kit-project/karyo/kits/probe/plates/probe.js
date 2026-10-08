// A test kit's script (tests/kit-scripts.test.ts). If it runs, it says so everywhere it can
// (PROBE RAN on its plate, a status line), then tries what a hostile kit script might and writes down each outcome.
// It must never run before the user trusted this version; once trusted, every attempt below must fail.
export async function render(host, ctx) {
  const at = typeof ctx.plate.options.target === 'string' ? ctx.plate.options.target : (location.ancestorOrigins && location.ancestorOrigins[0]) || 'http://localhost';
  host.innerHTML = '';
  const title = document.createElement('div');
  title.id = 'probe-ran';
  title.style.cssText = 'font: 600 20px var(--pl-font); color: var(--pl-fg); padding: 24px 28px 8px';
  title.textContent = `PROBE RAN · ${ctx.model.nodes.length} nodes: ${ctx.model.nodes.map((n) => n.label).join(', ')}`;
  host.append(title);
  ctx.emit('status', 'PROBE RAN');
  const splice = { karyo: 'splice/1', id: 'pwned', title: 'pwned', base: { model: 'karyo.model.json', commit: null }, created: '2030-04-29T00:00:00.000Z', updated: '2030-04-29T00:00:00.000Z', ops: [] };
  const url = `${at}/__karyo/splice?file=${encodeURIComponent('karyo/splices/pwned.splice.json')}`;
  const results = {};
  // "blocked": it threw. "no error": it didn't throw, which doesn't mean it got through (a beacon or a form the browser
  // drops says nothing), so a test also has to check that nothing reached the server.
  const attempt = async (name, fn) => { try { results[name] = `no error: ${await fn()}`; } catch (e) { results[name] = `blocked (${(e && e.name) || e})`; } };
  await attempt('fetch POST splice', async () => (await fetch(url, { method: 'POST', body: JSON.stringify(splice) })).status);
  await attempt('fetch no-cors POST splice', async () => (await fetch(url, { method: 'POST', mode: 'no-cors', body: JSON.stringify(splice) })).type);
  await attempt('fetch POST trust', async () => (await fetch(`${at}/__karyo/trust`, { method: 'POST', body: '{}' })).status);
  await attempt('XMLHttpRequest POST', () => new Promise((ok, fail) => { const x = new XMLHttpRequest(); x.open('POST', url); x.onload = () => ok(x.status); x.onerror = () => fail(new Error('network error')); try { x.send(JSON.stringify(splice)); } catch (e) { fail(e); } }));
  await attempt('sendBeacon', () => { if (!navigator.sendBeacon(url, JSON.stringify(splice))) throw new Error('refused'); return 'queued (the frame\u2019s CSP drops it)'; });
  await attempt('WebSocket', () => new Promise((ok, fail) => { try { const w = new WebSocket(at.replace(/^http/, 'ws')); w.onopen = () => ok('open'); w.onerror = () => fail(new Error('error')); } catch (e) { fail(e); } }));
  await attempt('read the page', () => parent.document.title);
  await attempt('read the token', () => parent.document.querySelector('meta[name="karyo-token"]').content);
  await attempt('localStorage', () => String(localStorage.length));
  await attempt('cookies', () => JSON.stringify(document.cookie));
  await attempt('navigate the page', () => { top.location.href = `${at}/?pwned=1`; return 'set'; });
  await attempt('open a window', () => { const w = window.open(`${at}/?pwned=1`); if (!w) throw new Error('no window'); return 'opened'; });
  await attempt('submit a form', () => { const f = document.createElement('form'); f.method = 'POST'; f.action = url; document.body.append(f); f.submit(); return 'submitted (the sandbox drops it)'; });
  await attempt('image beacon', () => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => fail(new Error('error')); i.src = `${at}/favicon.ico?pwned=1`; }));
  const pre = document.createElement('pre');
  pre.id = 'probe-results';
  pre.style.cssText = 'margin: 0 28px; font: 12px/1.5 var(--pl-font-mono); color: var(--pl-muted)';
  pre.textContent = Object.entries(results).map(([k, v]) => `${k.padEnd(28)} ${v}`).join('\n');
  host.append(pre);
  ctx.emit('status', 'PROBE RAN · attempts done');
}
