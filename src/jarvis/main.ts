// Jarvis mode (jarvis.html): one interactive plate filling the window, driven by voice. Hold Space to talk (or,
// with the wake word on, just say it); a local server (integrations/jarvis, `just jarvis`) transcribes with
// Whisper and runs a `claude -p` session that answers in captions and moves the plate through actions.
//   ?scene=<id>          the plate (default layers-stack, a Stack view); ?spec=<path to an explainer .json> loads an explainer
//   &theme=fresh  &mode=dark|light   themes, as on the gallery (else the ⚙ panel's Theme, stored in karyo:theme, else adenine)
//   &ws=<url>            the server (default ws://127.0.0.1:5190/ws)
// window.__karyo is the gallery's renderer API plus `jarvis` (snapshot, run, bar texts) for scripts and tests.
import '../kits/boot';   // first: the page's kits, before any scene is built (docs/KITS.md)
import { mount, setMotion, motion, type Stage, type SceneClass } from '../engine';
import { scenes } from '../scenes';
import { karyoApi } from '../explainer/api';
import { explainerScene } from '../explainer/scene';
import type { ExplainerBundle } from '../explainer/types';
import { PlateAdapter } from './actions';
import { Mic, inputDevices, concat, RATE } from './audio';
import { Vad, rms, levelOf } from './vad';
import { Bar, DEFAULT_SETTINGS, type PageSettings } from './bar';
import { DEFAULT_WS, pcmToBase64, type PageMsg, type ServerMsg, type JarvisSettings } from './protocol';
import { initTheme, themeFontsReady } from '../engine/theme-pick';
import './jarvis.css';

const q = new URLSearchParams(location.search);
const html = document.documentElement;
initTheme(q);
await themeFontsReady();   // the theme's web fonts in before a plate measures its text
const DEFAULT_SCENE = 'layers-stack';   // a plate every checkout has (src/scenes/)
const SCENE = q.get('spec') ? 'explainer' : q.get('scene') || DEFAULT_SCENE;
const WS_URL = q.get('ws') || DEFAULT_WS;
const PTT_MIN_MS = 250;
const SK = 'karyo:jarvis:settings';

declare global { interface Window { __karyo: any } }

// ---------------------------------------------------------------- settings (per browser)
function loadSettings(): PageSettings {
  try { const v = JSON.parse(localStorage.getItem(SK) ?? 'null'); if (v && typeof v === 'object') return { ...DEFAULT_SETTINGS, ...v }; } catch { /* storage unavailable */ }
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(s: PageSettings) { try { localStorage.setItem(SK, JSON.stringify(s)); } catch { /* not persisted */ } }
let settings = loadSettings();
const wire = (s: PageSettings): JarvisSettings => ({ wakeWord: s.wakeWord, wakeEnabled: s.wakeEnabled });

// ---------------------------------------------------------------- page
const root = document.getElementById('jv')!;
const area = root.querySelector<HTMLElement>('.jv-stage')!;
const bar = new Bar(root, settings);
const applyMotion = () => { setMotion(settings.motion ? 1 : 0); root.classList.toggle('is-still', motion() === 0); };
applyMotion();

async function sceneClass(): Promise<SceneClass> {
  const spec = q.get('spec');
  if (spec) {
    const r = await fetch(`/__karyo/bundle?spec=${encodeURIComponent(spec)}`);
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
    return explainerScene(j as ExplainerBundle);
  }
  const Cls = scenes[SCENE];
  if (!Cls) throw new Error(`no scene "${SCENE}". Open one with ?scene=<id> (interactive plates here: ${Object.keys(scenes).filter((k) => scenes[k]!.interactive).join(', ') || 'none'}) or an explainer with ?spec=<path to a .explainer.json>`);
  return Cls;
}

let stage: Stage | null = null;
let adapter: PlateAdapter | null = null;
const stages: Record<string, Stage> = {};

// ---- the plate fills the space above the bar: laid out for it (the theater's `fit`), or at its page layout
let theater = true;
const PAD = 16;
function sizePlate() {
  if (!stage?.isReady) return;
  const r = area.getBoundingClientRect();
  const space = { w: Math.max(200, r.width - 2 * PAD), h: Math.max(150, r.height - 2 * PAD) };
  // laid out for the space (with room for the chrome floor's larger chrome: docs/ENGINE.md "Chrome floor")
  const fitted = stage.fitScene(theater ? space : null, Math.min(space.w, stage.W));
  stage.resize(fitted?.w ?? stage.Cls.width, fitted?.h ?? stage.Cls.height);
  let w = Math.min(space.w, space.h * (stage.W / stage.H));
  if (!theater) w = Math.min(w, stage.W);            // the page layout never grows past its own size
  stage.viewport.style.width = `${Math.floor(w)}px`;
  stage.root.style.setProperty('--plate-w', `${Math.floor(w)}px`);
  stage.redraw();
}
function setTheater(on: boolean) {
  if (on === theater) return;
  theater = on;
  sizePlate();
  queueView();
}
new ResizeObserver(() => sizePlate()).observe(area);
// the pinned inspector (docs/ENGINE.md "Pinned inspector") docks to the window's side above the bar; the plate's area
// gives it that side, and the plate re-fits into what is left (the ResizeObserver above)
function layoutDock() {
  const d = stage?.dock;
  if (!d) return;
  d.sync();
  const r = d.reserve();
  area.style.left = r && d.side === 'left' ? `${r}px` : '';
  area.style.right = r && d.side === 'right' ? `${r}px` : '';
}
addEventListener('resize', () => layoutDock());

// ---------------------------------------------------------------- server connection
let ws: WebSocket | null = null;
let backoff = 1000;
let retryTimer: ReturnType<typeof setTimeout> | 0 = 0;
let retryAt = 0;
let lastView = '';
const log: { dir: 'out' | 'in'; msg: unknown }[] = [];

function send(m: PageMsg) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(m));
  log.push({ dir: 'out', msg: m.type === 'audio' ? { ...m, pcm: `<${m.pcm.length} b64>` } : m });
  if (log.length > 200) log.shift();
  return true;
}
function connect() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
  bar.setConn(bar.conn === 'down' || bar.conn === 'elsewhere' ? bar.conn : 'connecting');
  let sock: WebSocket;
  try { sock = new WebSocket(WS_URL); } catch { return retry(); }
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    bar.setConn('up');
    bar.setMic(bar.mic === 'listening' ? 'listening' : 'idle');
    send({ type: 'hello', scene: SCENE, vocab: adapter?.vocab() ?? [], settings: wire(settings) });
    lastView = '';
    sendView();
  };
  sock.onmessage = (e) => { try { onServer(JSON.parse(String(e.data)) as ServerMsg); } catch (err) { console.error('[jarvis] bad message', err, e.data); } };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    // 4000: another tab connected and the server took it over; stay quiet until asked ("Use this tab")
    if (e.code === 4000) { bar.setConn('elsewhere'); if (bar.mic !== 'listening') bar.setMic('idle'); return; }
    retry();
  };
  sock.onerror = () => { /* onclose follows */ };
}
function retry() {
  const wait = backoff;
  backoff = Math.min(backoff * 2, 15000);
  retryAt = performance.now() + wait;
  bar.setConn('down', wait);
  if (bar.mic !== 'listening') bar.setMic('idle');
  retryTimer = setTimeout(connect, wait);
}
// the countdown in the hint
setInterval(() => { if (bar.conn === 'down' && retryTimer) bar.setConn('down', Math.max(0, retryAt - performance.now())); }, 1000);

// ---- what's on screen, debounced: sent when it changed
let viewTimer: ReturnType<typeof setTimeout> | 0 = 0;
function queueView() { if (!viewTimer) viewTimer = setTimeout(() => { viewTimer = 0; sendView(); }, 180); }
function sendView() {
  const snap = adapter?.snapshot();
  if (!snap) return;
  const j = JSON.stringify(snap);
  if (j === lastView) return;
  if (send({ type: 'view', snapshot: snap })) lastView = j;
}

function onServer(m: ServerMsg) {
  log.push({ dir: 'in', msg: m });
  if (log.length > 200) log.shift();
  switch (m.type) {
    case 'status': bar.setMic(m.state, m.detail ?? ''); break;
    case 'transcript':
      bar.fadeCaption();
      bar.setTranscript(m.text, m.accepted, !!m.wake);
      if (m.accepted) bar.setMic('thinking');
      else if (bar.mic === 'transcribing') bar.setMic('idle');
      break;
    case 'activity': bar.setActivity(m.text); break;
    case 'caption': bar.setCaption(m.text, m.final); break;
    case 'error': bar.setActivity(m.message, true); if (bar.mic !== 'listening') bar.setMic('idle'); break;
    case 'action': {
      // most actions answer at once; saving, listing and opening splices read or write files first
      void Promise.resolve(adapter ? adapter.run(m.name, m.args ?? {}) : { ok: false, error: 'no plate is mounted' }).then((r) => {
        send({ type: 'action_result', id: m.id, ok: r.ok, ...(r.state ? { state: r.state } : {}), ...(r.error ? { error: r.error } : {}) });
        queueView();
      });
      break;
    }
  }
}

// ---------------------------------------------------------------- audio: push-to-talk and wake mode
const mic = new Mic();
mic.deviceId = settings.deviceId;
let ptt: { t0: number; chunks: Float32Array[] } | null = null;
let segLevelHold = 0;
const vad = new Vad((seg) => {
  if (!settings.wakeEnabled || ptt) return;
  bar.fadeCaption();
  sendAudio(seg, 'wake');
});
mic.onChunk = (c) => {
  const lvl = levelOf(rms(c));
  if (ptt) { ptt.chunks.push(c); bar.setLevel(lvl); return; }
  if (settings.wakeEnabled) {
    vad.push(c);
    // the meter moves while a segment is being heard, and rests on the floor otherwise
    if (vad.speaking) segLevelHold = 6;
    bar.setLevel(segLevelHold-- > 0 ? lvl : 0);
  }
};
const notSent = () => (bar.conn === 'elsewhere' ? 'not sent: Jarvis is connected in another tab (Use this tab takes it back)' : 'not sent: the server is not running (just jarvis)');
function sendAudio(pcm: Float32Array, mode: 'ptt' | 'wake') {
  if (!send({ type: 'audio', mode, sampleRate: RATE, pcm: pcmToBase64(pcm) })) {
    bar.setActivity(notSent(), true);
    bar.setMic('idle');
    return;
  }
  if (mode === 'ptt') bar.setMic('transcribing');
}
async function micError(e: unknown) {
  const name = (e as { name?: string })?.name ?? '';
  bar.setActivity(name === 'NotAllowedError' ? 'microphone blocked: allow it in the browser’s site settings' : name === 'NotFoundError' ? 'no microphone found' : `microphone: ${e instanceof Error ? e.message : String(e)}`, true);
  bar.setMic('idle');
}
async function refreshDevices() { bar.setDevices(await inputDevices()); }
function pttDown() {
  if (ptt) return;
  bar.fadeCaption();
  ptt = { t0: performance.now(), chunks: [] };
  vad.reset();
  bar.setTranscript('', true);
  bar.setMic('listening', 'release Space to send');
  mic.open(settings.deviceId).then(() => { mic.keep(settings.wakeEnabled ? 0 : 60_000); void refreshDevices(); }, micError);
}
function pttUp() {
  const p = ptt;
  if (!p) return;
  ptt = null;
  bar.setLevel(0);
  const held = performance.now() - p.t0;
  const pcm = concat(p.chunks);
  if (held < PTT_MIN_MS || pcm.length < (RATE * PTT_MIN_MS) / 1000 / 2) {
    bar.setMic('idle', held < PTT_MIN_MS ? 'hold Space a little longer' : mic.isOpen ? '' : 'waiting for the microphone');
    return;
  }
  sendAudio(pcm, 'ptt');
}
async function applyWake() {
  bar.setWake(settings.wakeEnabled);
  vad.reset();
  if (settings.wakeEnabled) {
    try { await mic.open(settings.deviceId); mic.keep(0); void refreshDevices(); } catch (e) { void micError(e); }
  } else if (mic.isOpen) mic.keep(60_000);
}

// Space is for talking on this page, except while typing in a text field
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable); };
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault(); e.stopPropagation();
  if (!e.repeat) pttDown();
}, true);
addEventListener('keyup', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (!ptt && typing(e.target)) return;
  e.preventDefault(); e.stopPropagation();
  pttUp();
}, true);
// letting go of Space outside the window still ends the recording
addEventListener('blur', () => pttUp());

bar.onText = (text) => {
  bar.fadeCaption();
  bar.setTranscript(text, true);
  if (send({ type: 'text', text })) bar.setMic('thinking');
  else bar.setActivity(notSent(), true);
};
bar.onSettings = (s) => {
  const wakeChanged = s.wakeEnabled !== settings.wakeEnabled || s.deviceId !== settings.deviceId;
  const wireChanged = s.wakeWord !== settings.wakeWord || s.wakeEnabled !== settings.wakeEnabled;
  settings = s;
  saveSettings(s);
  bar.setSettings(s);
  applyMotion();
  if (s.deviceId !== mic.deviceId && mic.isOpen) { mic.shut(); }
  mic.deviceId = s.deviceId;
  if (wakeChanged) void applyWake();
  if (wireChanged) send({ type: 'settings', settings: wire(s) });
};
bar.onOpenSettings = () => { void refreshDevices(); };
bar.onReclaim = () => { backoff = 1000; connect(); };

// ---------------------------------------------------------------- boot
try {
  const Cls = await sceneClass();
  if (!Cls.interactive) throw new Error(`"${SCENE}" is a clip, not an interactive plate: Jarvis mode drives boards, trace boards, tours, Stack views and explainers`);
  document.title = `${Cls.title || SCENE} · Jarvis · Karyo`;
  const host = document.createElement('div');
  host.dataset.scene = SCENE;
  area.append(host);
  // not `fill`: the page sizes the plate itself, so the space it fits is the window less the bar
  stage = mount(host, Cls, { theater: false, bench: false });
  stages[SCENE] = stage;
  adapter = new PlateAdapter(stage, { theater: () => theater, setTheater });
  if (stage.dock) { stage.dock.place(root, true); stage.onDock(() => { layoutDock(); queueView(); }); layoutDock(); }
  // the `?` card (docs/ENGINE.md "Key help"): this page's keys first; Space is for talking here, so the plate's Space goes
  stage.keyHelp.setPage({
    omit: ['Space', 'Space + drag'],
    keys: () => [
      { group: 'Jarvis', keys: 'Space', does: 'hold to talk, let go to send' },
      { group: 'Jarvis', gesture: true, keys: `say “${settings.wakeWord}”`, does: 'talk without a key', ...(settings.wakeEnabled ? {} : { off: true, when: 'with the wake word on (⚙ Settings)' }) },
      { group: 'Jarvis', keys: 'Enter', does: 'send a typed command', when: 'in the command box' },
      { group: 'Jarvis', keys: 'Esc', does: 'leave the command box (or close ⚙ Settings)', when: 'in the command box' },
    ],
  });
  // a splice that adds cards re-lays the plate out: this page sizes it (above the bar)
  stage.onRefit(() => sizePlate());
  await stage.ready;
  sizePlate();
  stage.onFrame(() => queueView());
  stage.viewport.focus({ preventScroll: true });
} catch (e) {
  area.innerHTML = `<p class="jv-msg">Could not open the plate: ${String(e instanceof Error ? e.message : e).replace(/</g, '&lt;')}</p>`;
  console.error(e);
}
if (settings.wakeEnabled) void applyWake();
connect();

window.__karyo = karyoApi(stages, {
  jarvis: {
    scene: SCENE,
    snapshot: () => adapter?.snapshot() ?? null,
    run: (name: string, args?: Record<string, unknown>) => adapter?.run(name, args ?? {}),
    bar: () => bar.texts,
    conn: () => (ws?.readyState === WebSocket.OPEN ? 'up' : bar.conn),
    settings: () => ({ ...settings }),
    theater: () => theater,
    log: () => log.slice(),
    micOpen: () => mic.isOpen,
  },
});
