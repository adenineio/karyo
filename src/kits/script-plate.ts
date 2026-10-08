// A `script` plate type (docs/KITS.md "Code in kits"): a plate drawn by a kit's own JavaScript. This is the one place
// Karyo runs code from a kit, and it runs nothing it hasn't been allowed to:
//
//   untrusted  the plate shows a warning panel instead: the kit, where it is from, what running it means, the files it
//              would run with their sha256 (each readable inline), and two buttons, "Trust this version" and "Not now".
//              "Not now" leaves a placeholder that opens the panel again. The script is never loaded.
//   trusted    (the user trusted this exact version, in their home's trust store; or the kit is built into Karyo) the
//              script runs in a sealed frame (src/kits/sandbox.ts), after the page checked that the text it holds is
//              the text that was hashed; and a notice stays on the plate for as long as it runs ("⚠ runs code from kit
//              X · trusted <date> · <where>"), which opens the same panel to review the code or take trust back.
//
// Stills: a script that declares `deterministic` is rendered like any plate (after it has drawn: `build` waits); one
// that doesn't is replaced in stills and lint by a notice saying why. States: `consent`, `consent-source`, `later`
// (untrusted) or `review`, `review-source` (trusted), plus whatever the script keeps in its own `state`.
import { Scene, type Frame, type SceneClass } from '../engine';
import { esc } from '../explainer/template';
import type { Model } from '../model/model';
import type { KitSet } from './registry';
import type { BundledCode, BundledPlate } from './types';
import { KitSandbox, type ScriptCtx } from './sandbox';
import { trustGrant, trustRevoke, trustStatus, verifyCode, type PageTrust } from './trust-client';
import { HIDDEN_CHARS, KIT_CODE_SANDBOX, KIT_CODE_WARNING, KIT_TRUST_WHERE, hiddenCount, hiddenName, localDay, noticeWords } from './warning';

const BAR_H = 34;
const STALE = 'This kit changed on disk after the page loaded: reload the page to review the version that is there now.';
const FRAMED = 'This page is inside another page\'s frame, so it can\'t trust a kit (that page could have steered your click): open Karyo on its own to trust it.';
/** Is this page inside a frame of another origin? Then a click on "Trust" may not be the user's own (clickjacking). */
const framedByOther = () => { try { return window.top !== window && window.top!.location.origin !== location.origin; } catch { return true; } };
const TOKENS = ['bg', 'fg', 'muted', 'line', 'accent', 'accent-2', 'ok', 'card', 'card-border', 'radius', 'shadow', 'font', 'font-display', 'font-mono',
  'cat-1', 'cat-2', 'cat-3', 'cat-4', 'cat-5', 'cat-6', 'cat-7', 'cat-8', 'cat-other'];
const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

type Mode = 'loading' | 'consent' | 'later' | 'running' | 'review' | 'error' | 'skipped';
export interface ScriptPlateState {
  /** The panel shown: the warning (untrusted), the placeholder after "Not now", the review of a running kit, or none. */
  panel?: 'consent' | 'later' | 'review' | null;
  /** The file whose source is open in the panel. */
  source?: string | null;
  /** The script's own view state (what it last emitted). */
  script?: unknown;
}
/** What a page (or a test) can ask a script plate. */
export interface ScriptPlateApi {
  trustView(): { mode: Mode; kit: string; source: string; where: string; trusted: boolean; builtin: boolean; at: string | null; changed: boolean; running: boolean; files: { path: string; sha256: string; bytes: number }[]; notice: string; error: string | null };
  trustThis(): Promise<boolean>;
  notNow(): void;
  review(): void;
  revoke(): Promise<boolean>;
}

/** A little JavaScript (and JSON) highlighting for the source viewer: comments, strings, keywords, numbers. */
export function highlight(src: string): string {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`)|\b(const|let|var|function|return|if|else|for|while|do|of|in|new|class|extends|export|import|from|default|async|await|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|this|switch|case|break|continue|yield|delete|void|fetch|eval|Function|postMessage|parent|top|window|document|location)\b|(\b\d+(?:\.\d+)?\b)/g;
  let out = '', last = 0;
  for (const m of src.matchAll(re)) {
    out += esc(src.slice(last, m.index));
    out += `<span class="${m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : 'n'}">${esc(m[0])}</span>`;
    last = m.index! + m[0].length;
  }
  // characters that change how text reads, or don't show, are shown as what they are (they're not markup: safe here)
  return (out + esc(src.slice(last))).replace(HIDDEN_CHARS, (c) => `<span class="hid" title="${hiddenName(c)}: an invisible or direction-changing character">⟦${hiddenName(c)}⟧</span>`);
}
const kb = (n: number) => (n < 1000 ? `${n} B` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} kB`);

const STYLE = /* css */ `
  .ks-bar { position: absolute; left: 0; right: 0; top: 0; height: ${BAR_H}px; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid var(--pl-line); background: color-mix(in srgb, var(--pl-accent-2) 7%, var(--pl-bg)); z-index: 5; }
  .ks-notice { all: unset; box-sizing: border-box; cursor: pointer; min-width: 0; flex: 0 1 auto; font: 500 12px/1 var(--pl-font-mono); color: var(--pl-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 6px 8px; border-radius: 4px; }
  .ks-notice .w { color: var(--pl-accent-2); }
  .ks-notice:hover, .ks-notice:focus-visible { background: color-mix(in srgb, var(--pl-accent-2) 14%, transparent); outline: 2px solid var(--pl-accent); outline-offset: -2px; }
  .ks-status { margin-left: auto; min-width: 0; font: 12px/1 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ks-body { position: absolute; left: 0; right: 0; top: ${BAR_H}px; bottom: 0; }
  .ks-stage { position: absolute; inset: 0; }
  .ks-over { position: absolute; inset: 0; display: none; background: var(--pl-bg); z-index: 4; }
  .ks-over.is-on { display: block; }
  .ks-panel { position: absolute; left: 28px; right: 28px; top: 16px; max-height: calc(100% - 32px); box-sizing: border-box; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--pl-card-border); border-left: 4px solid var(--pl-accent-2); border-radius: var(--pl-radius); background: var(--pl-card); color: var(--pl-fg); font: 13.5px/1.45 var(--pl-font); overflow: hidden; }
  .ks-panel.is-src { bottom: 16px; }
  .ks-panel > * { flex-shrink: 0; }
  .ks-panel.is-src .ks-note { display: none; }
  .ks-panel h2 { margin: 0; display: flex; gap: 10px; align-items: baseline; font: 700 19px/1.25 var(--pl-font-display); }
  .ks-panel h2 .w { color: var(--pl-accent-2); font-size: 20px; }
  .ks-panel h2 span:last-child { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ks-from { margin: -4px 0 0 30px; font: 12.5px/1.35 var(--pl-font-mono); color: var(--pl-muted); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .ks-from b { color: var(--pl-fg); font-weight: 600; }
  .ks-when { margin: -6px 0 0 30px; font: 12.5px/1.3 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ks-file .p .chg { margin-left: 8px; padding: 1px 5px; border-radius: 3px; font-weight: 600; font-size: 11px; color: var(--pl-bg); background: var(--pl-accent-2); }
  .ks-panel p { margin: 0; }
  .ks-what { font-size: 14.5px; line-height: 1.45; }
  .ks-note { font-size: 12.5px; color: var(--pl-muted); }
  .ks-changed { font-weight: 600; color: var(--pl-accent-2); }
  .ks-k { font: 500 11px/1 var(--pl-font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--pl-muted); margin-top: 2px; }
  .ks-files { display: grid; gap: 4px; }
  .ks-file { display: grid; grid-template-columns: minmax(0, 1fr) 60px 474px 112px; gap: 12px; align-items: center; font: 12px/1.2 var(--pl-font-mono); }
  .ks-file .p { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ks-file .z { color: var(--pl-muted); text-align: right; white-space: nowrap; }
  .ks-file .h { font-size: 11px; color: var(--pl-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ks-btn { font: 600 12.5px/1 var(--pl-font); color: var(--pl-fg); background: var(--pl-bg); border: 1px solid var(--pl-card-border); border-radius: min(var(--pl-radius), 6px); padding: 8px 12px; cursor: pointer; white-space: nowrap; }
  .ks-btn:hover { border-color: var(--pl-accent); }
  .ks-btn:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
  .ks-btn[aria-expanded="true"] { border-color: var(--pl-accent); color: var(--pl-accent); }
  .ks-btn.trust { border-color: var(--pl-accent-2); color: var(--pl-accent-2); }
  .ks-btn:disabled { opacity: 0.5; cursor: default; }
  .ks-file .ks-btn { padding: 5px 8px; font-size: 12px; }
  .ks-src { flex: 1 1 auto; min-height: 60px; display: flex; flex-direction: column; border: 1px solid var(--pl-line); border-radius: min(var(--pl-radius), 6px); background: var(--pl-bg); overflow: hidden; }
  .ks-src-h { display: flex; gap: 10px; align-items: center; padding: 5px 10px; border-bottom: 1px solid var(--pl-line); font: 11.5px/1.2 var(--pl-font-mono); color: var(--pl-muted); white-space: nowrap; }
  .ks-src-h b { color: var(--pl-fg); flex: none; }
  .ks-src-h span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .ks-src-h .ks-btn { margin-left: auto; flex: none; padding: 3px 8px; font-size: 11.5px; }
  .ks-code { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; display: flex; }
  .ks-code pre { margin: 0; padding: 6px 10px; font: 12px/1.45 var(--pl-font-mono); white-space: pre; tab-size: 2; }
  .ks-code .ln { color: var(--pl-muted); text-align: right; user-select: none; border-right: 1px solid var(--pl-line); position: sticky; left: 0; background: var(--pl-bg); }
  .ks-code .c { color: var(--pl-muted); font-style: italic; }
  .ks-code .s { color: var(--pl-accent-2); }
  .ks-code .k { color: var(--pl-accent); font-weight: 600; }
  .ks-code .n { color: var(--pl-ok); }
  .ks-code .hid { color: var(--pl-bg); background: var(--pl-accent-2); border-radius: 2px; font-weight: 700; }
  .ks-file .p .hidc { margin-left: 8px; padding: 1px 5px; border-radius: 3px; font-weight: 600; font-size: 11px; color: var(--pl-accent-2); border: 1px solid var(--pl-accent-2); }
  .ks-code:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: -2px; }
  .ks-grow { flex: 1 1 auto; }
  .ks-acts { display: flex; gap: 10px; align-items: center; }
  .ks-acts .ks-err { color: var(--pl-accent-2); font-size: 12.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ks-later { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 560px; box-sizing: border-box; padding: 22px 24px; display: grid; gap: 12px; justify-items: start; border: 1px dashed var(--pl-card-border); border-left: 4px solid var(--pl-accent-2); border-radius: var(--pl-radius); background: var(--pl-card); color: var(--pl-fg); font: 13.5px/1.45 var(--pl-font); }
  .ks-later h2 { margin: 0; font: 700 17px/1.3 var(--pl-font-display); }
  .ks-later h2 .w { color: var(--pl-accent-2); }
  .ks-later p { margin: 0; color: var(--pl-muted); }
`;

export interface ScriptPlateOpts { title?: string; flow?: string; tour?: string }

/** The scene for a `script` plate type over `model`. */
export function scriptPlate(kits: KitSet, plate: BundledPlate, model0: Model, o: ScriptPlateOpts = {}): SceneClass {
  const model = kits.decorate(model0);
  const kit = kits.bundle.kits.find((k) => k.name === plate.kit);
  const code: BundledCode | undefined = kit?.code;
  const script = plate.script ?? '';
  const W = plate.size?.w && plate.size.w >= 320 ? Math.round(plate.size.w) : 960;
  const H = plate.size?.h && plate.size.h >= 240 ? Math.round(plate.size.h) : 600;
  const builtin = plate.source === 'builtin';
  const where = code?.where ?? (builtin ? 'built into Karyo' : plate.source);
  const flow = plate.from === 'flow' ? model.flows.find((f) => f.id === (o.flow ?? model.flows[0]?.id)) : undefined;
  const tour = plate.from === 'tour' ? (model.tours ?? []).find((t) => t.id === (o.tour ?? model.tours?.[0]?.id)) : undefined;

  return class ScriptPlate extends Scene implements ScriptPlateApi {
    static title = o.title ?? `${plate.title}: ${model.project ?? 'the model'}`;
    static width = W;
    static height = H;
    static duration = 0.3;
    static interactive = true;
    static fx = 'under' as const;

    private mode: Mode = 'loading';
    private trust: PageTrust = { trusted: false };
    private src: string | null = null;
    private err: string | null = null;
    private panelErr: string | null = null;
    private busy = false;
    private sandbox: KitSandbox | null = null;
    private scriptState: unknown = null;
    private waiting: Promise<unknown> | null = null;
    private mo: MutationObserver | null = null;
    private themeQueued = false;
    private el!: { notice: HTMLButtonElement; status: HTMLElement; stage: HTMLElement; over: HTMLElement };

    build(dom: HTMLElement) {
      dom.innerHTML = `<style>${STYLE}</style>
        <div class="ks-bar"><button type="button" class="ks-notice" id="ks-notice"></button><span class="ks-status" id="ks-status" aria-live="polite"></span></div>
        <div class="ks-body"><div class="ks-stage" id="ks-stage"></div><div class="ks-over" id="ks-over" role="region" aria-label="kit code"></div></div>`;
      const $ = <T extends HTMLElement>(s: string) => dom.querySelector<T>(s)!;
      this.el = { notice: $('#ks-notice'), status: $('#ks-status'), stage: $('#ks-stage'), over: $('#ks-over') };
      this.el.notice.addEventListener('click', () => this.review());
      this.el.over.addEventListener('click', (e) => this.onPanelClick(e));
      return this.boot();
    }

    private async boot() {
      if (!code || !script || typeof code.sources[script] !== 'string') { this.fail(`kit ${plate.kit} has no script "${script}" in this page`); return; }
      this.trust = await trustStatus(code, plate.source);
      if (this.trust.trusted) await this.run();
      else { this.show('consent'); if (this.trust.stale || framedByOther()) { this.panelErr = this.trust.stale ? STALE : FRAMED; this.paint(); } }
    }

    /** Run the script: only ever called once this version is trusted (or built in). */
    private async run() {
      if (!code || !this.trust.trusted) return;
      if (!(await verifyCode(code))) { this.fail('the code this page received does not match its hashes, so nothing ran; reload the page'); return; }
      if (this.stage.isExport && !plate.deterministic) { this.show('skipped'); return; }
      this.mode = 'running';
      this.paint();
      this.sandbox = new KitSandbox(this.el.stage, code.sources[script]!, this.ctx(), {
        onState: (s) => { this.scriptState = s; void this.redraw({ state: s }); },
        onStatus: (t) => { this.el.status.textContent = t; },
        onError: (m) => { this.err = `the kit's script failed: ${m.split('\n')[0]}`; console.error(`[karyo kits] ${plate.kit}/${script}:`, m); this.paint(); },
      });
      this.waiting = this.sandbox.rendered;
      try { await this.sandbox.rendered; } catch (e) { this.err = `the kit's script failed: ${(e as Error).message.split('\n')[0]}`; }
      this.waiting = null;
      this.watchTheme();
      this.paint();
    }

    private ctx(): ScriptCtx {
      const cs = getComputedStyle(this.stage.dom);
      const vars: Record<string, string> = {};
      const theme: Record<string, unknown> = {};
      for (const t of TOKENS) { const v = cs.getPropertyValue(`--pl-${t}`).trim(); vars[`--pl-${t}`] = v; if (!t.startsWith('cat-')) theme[camel(t)] = v; }
      theme.cat = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => vars[`--pl-cat-${i}`]);
      theme.catOther = vars['--pl-cat-other'];
      return {
        model: JSON.parse(JSON.stringify(model)), ...(flow ? { flow: JSON.parse(JSON.stringify(flow)) } : {}), ...(tour ? { tour: JSON.parse(JSON.stringify(tour)) } : {}),
        plate: { id: plate.id, title: plate.title, kit: plate.kit, options: plate.options ?? {} },
        theme, vars, size: { w: this.stage.W, h: this.stage.H - BAR_H }, state: this.scriptState,
      };
    }
    private redraw(c: Partial<ScriptCtx>) {
      if (!this.sandbox) return Promise.resolve();
      const p = this.sandbox.update(c).catch((e: Error) => { this.err = `the kit's script failed: ${e.message.split('\n')[0]}`; this.paint(); });
      this.waiting = p;
      return p;
    }
    /** The theme changed (the ⚙ menu, the system's dark mode): hand the script the new colours. */
    private watchTheme() {
      if (this.mo) return;
      const again = () => {
        if (this.themeQueued) return;
        this.themeQueued = true;
        requestAnimationFrame(() => { this.themeQueued = false; const c = this.ctx(); void this.redraw({ theme: c.theme, vars: c.vars }); });
      };
      this.mo = new MutationObserver(again);
      this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-plate-theme', 'class', 'style'] });
      this.mo.observe(this.stage.root, { attributes: true, attributeFilter: ['data-theme', 'data-plate-theme'] });
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', again);
    }

    private fail(msg: string) { this.err = msg; this.mode = 'error'; this.paint(); }
    private show(m: Mode) { this.mode = m; this.panelErr = null; this.paint(); }

    // ------------------------------------------------------------ what the plate shows
    private paint() {
      const running = this.mode === 'running' || this.mode === 'review';
      const n = this.el.notice;
      if (running || this.mode === 'skipped') {
        n.innerHTML = `<span class="w">⚠</span> ${esc(noticeWords(plate.kit, plate.source, where, this.trust.at ?? null).replace(/^⚠ /, ''))}`;
        n.title = 'Review the code this plate runs, or take trust back';
        n.setAttribute('aria-label', `${noticeWords(plate.kit, plate.source, where, this.trust.at ?? null)}. Review the code.`);
      } else {
        const t = `kit ${plate.kit} has code that has not run · ${this.trust.changed ? 'changed since you trusted it' : 'not trusted'} · ${where}`;
        n.innerHTML = `<span class="w">⚠</span> ${esc(t)}`;
        n.title = 'Review the kit\'s code';
        n.setAttribute('aria-label', `${t}. Review the code.`);
      }
      if (this.sandbox) this.sandbox.frame.style.visibility = this.mode === 'running' && !this.err ? 'visible' : this.mode === 'review' ? 'visible' : 'hidden';
      const o = this.el.over;
      if (this.mode === 'running' && !this.err) { o.classList.remove('is-on'); o.innerHTML = ''; return; }
      o.classList.add('is-on');
      if (this.mode === 'consent' || this.mode === 'review') o.innerHTML = this.panelHTML();
      else if (this.mode === 'later') o.innerHTML = `<div class="ks-later"><h2><span class="w">⚠</span> Kit “${esc(plate.kit)}” wants to run its own code</h2><p>You chose Not now, so it hasn't run and this plate stays empty. The kit comes from ${esc(where)}.</p><button type="button" class="ks-btn" data-act="review">Review the kit's code…</button></div>`;
      else if (this.mode === 'skipped') o.innerHTML = `<div class="ks-later"><h2>Not drawn in stills</h2><p>Kit “${esc(plate.kit)}” doesn't declare its plate <code>deterministic</code>, so stills and lint show this notice instead of what its script draws.</p></div>`;
      else if (this.mode === 'error' || this.err) o.innerHTML = `<div class="ks-later"><h2><span class="w">⚠</span> Kit “${esc(plate.kit)}” couldn't draw this plate</h2><p>${esc(this.err ?? '')}</p>${code ? '<button type="button" class="ks-btn" data-act="review">Review the kit\'s code…</button>' : ''}</div>`;
      else o.innerHTML = '';
    }

    private panelHTML(): string {
      const review = this.mode === 'review';
      const at = this.trust.at ? localDay(this.trust.at) : null;
      const title = review ? `Kit “${plate.kit}” runs its own code on this plate`
        : this.trust.changed ? `Kit “${plate.kit}” changed since you trusted it` : `Kit “${plate.kit}” wants to run its own code here`;
      const from = `from <b>${esc(where)}</b>`;
      const when = review ? (builtin ? 'ships with Karyo: trusted automatically' : at ? `you trusted this version on ${at}` : '') : '';
      const changed = new Set(this.trust.changedFiles ?? []);
      const files = code?.files ?? [];
      const open = this.src && code?.sources[this.src] !== undefined ? this.src : null;
      const lines = open ? code!.sources[open]!.split('\n') : [];
      const shown = lines;   // all of it: what isn't shown still runs
      const longest = lines.reduce((a, l) => Math.max(a, l.length), 0);
      const hidden = files.map((f) => ({ f: f.path, n: hiddenCount(code?.sources[f.path] ?? '') })).filter((x) => x.n > 0);
      return `<div class="ks-panel${open ? ' is-src' : ''}" role="group" aria-labelledby="ks-h">
        <h2 id="ks-h"><span class="w" aria-hidden="true">⚠</span><span>${esc(title)}</span></h2>
        <div class="ks-from" data-pl-clip>${from}</div>
        ${when ? `<div class="ks-when">${esc(when)}</div>` : ''}
        ${this.trust.changed && !review ? `<p class="ks-changed">${changed.size ? `${changed.size === 1 ? 'A file' : `${changed.size} files`} changed (marked below)` : 'A file changed'} since you trusted an earlier version, so Karyo asks again before running it.</p>` : ''}
        ${hidden.length ? `<p class="ks-changed">⚠ ${esc(hidden.map((x) => `${x.f} has ${x.n} invisible or direction-changing character${x.n === 1 ? '' : 's'}`).join('; '))}: code can read differently from what runs. The source view marks them ⟦U+…⟧.</p>` : ''}
        <p class="ks-what">${esc(builtin && review ? KIT_CODE_WARNING.replace('Only trust kits whose code you have read or whose author you trust.', 'This one is part of Karyo itself, so Karyo trusts it for you.') : KIT_CODE_WARNING)}</p>
        <p class="ks-note">${esc(KIT_CODE_SANDBOX)}</p>
        <div class="ks-k">${review ? 'Files it runs' : 'Files it would run'}</div>
        <div class="ks-files">${files.map((f) => `<div class="ks-file"><span class="p" title="${esc(f.path)}">${esc(f.path)}${changed.has(f.path) && !review ? '<span class="chg">changed</span>' : ''}${hiddenCount(code?.sources[f.path] ?? '') ? '<span class="hidc">hidden characters</span>' : ''}</span><span class="z">${kb(f.bytes)}</span><span class="h" title="sha256 ${f.sha256}">sha256 ${f.sha256}</span><button type="button" class="ks-btn" data-act="src" data-file="${esc(f.path)}" aria-expanded="${open === f.path}" aria-controls="ks-src">${open === f.path ? 'Hide source' : 'View source'}</button></div>`).join('')}</div>
        ${open ? `<div class="ks-src" id="ks-src"><div class="ks-src-h"><b>${esc(open)}</b><span>read-only · ${lines.length} line${lines.length === 1 ? '' : 's'}${longest > 160 ? ` · long lines (up to ${longest} characters): scroll right` : ''}</span><button type="button" class="ks-btn" data-act="src" data-file="${esc(open)}">Close</button></div>
          <div class="ks-code" data-pl-clip tabindex="0" aria-label="source of ${esc(open)}"><pre class="ln" aria-hidden="true">${shown.map((_, i) => i + 1).join('\n')}</pre><pre><code>${highlight(shown.join('\n'))}</code></pre></div></div>` : ''}
        ${review ? '' : `<p class="ks-note">${esc(KIT_TRUST_WHERE)}</p>`}
        <div class="ks-acts">${review
          ? `${builtin ? '' : '<button type="button" class="ks-btn trust" data-act="revoke">Take trust back</button>'}<button type="button" class="ks-btn" data-act="close">Close</button>`
          : `<button type="button" class="ks-btn trust" data-act="trust"${this.busy || this.trust.stale || framedByOther() ? ' disabled' : ''}>Trust this version</button><button type="button" class="ks-btn" data-act="later">Not now</button>`}
          ${this.panelErr ? `<span class="ks-err" role="alert" title="${esc(this.panelErr)}">${esc(this.panelErr)}</span>` : ''}</div>
      </div>`;
    }

    private onPanelClick(e: MouseEvent) {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      e.stopPropagation();
      const act = b.dataset.act!;
      if (act === 'src') { this.src = this.src === b.dataset.file ? null : b.dataset.file!; this.paint(); this.focus(`[data-act="src"][data-file="${CSS.escape(b.dataset.file!)}"]`); }
      else if (act === 'trust') void this.trustThis();
      else if (act === 'later') this.notNow();
      else if (act === 'review') this.review();
      else if (act === 'close') { this.src = null; this.show('running'); this.el.notice.focus(); }
      else if (act === 'revoke') void this.revoke();
    }
    private focus(sel: string) { this.el.over.querySelector<HTMLElement>(sel)?.focus(); }

    // ------------------------------------------------------------ API
    async trustThis(): Promise<boolean> {
      if (!code || this.busy || this.mode !== 'consent' || this.trust.stale) return false;
      if (framedByOther()) { this.panelErr = FRAMED; this.paint(); return false; }
      this.busy = true; this.paint();
      const r = await trustGrant(code);
      this.busy = false;
      if (!r.ok) { this.panelErr = r.changed ? STALE : r.error ?? 'Karyo could not record trust'; if (r.changed) this.trust = { ...this.trust, stale: true }; this.paint(); return false; }
      this.trust = { trusted: true, at: r.at };
      this.src = null;
      await this.run();
      this.el.notice.focus();
      return true;
    }
    notNow() {
      if (this.mode !== 'consent') return;
      this.src = null;
      this.show('later');
      this.focus('[data-act="review"]');
    }
    review() {
      if (this.mode === 'running') this.show('review');
      else if (this.mode === 'later' || this.mode === 'error') this.show(this.trust.trusted && this.sandbox ? 'review' : 'consent');
      else return;
      this.focus('.ks-btn');
    }
    async revoke(): Promise<boolean> {
      if (!code || builtin || !this.trust.trusted) return false;
      const r = await trustRevoke(code);
      if (!r.ok) { this.panelErr = r.error ?? 'Karyo could not take trust back'; this.paint(); return false; }
      this.sandbox?.dispose();
      this.sandbox = null;
      this.scriptState = null;
      this.el.status.textContent = '';
      this.trust = { trusted: false };
      this.show('consent');
      this.focus('.ks-btn');
      return true;
    }
    trustView() {
      return {
        mode: this.mode, kit: plate.kit, source: plate.source, where, trusted: !!this.trust.trusted, builtin, at: this.trust.at ?? null, changed: !!this.trust.changed,
        running: !!this.sandbox && (this.mode === 'running' || this.mode === 'review'), files: (code?.files ?? []).map((f) => ({ ...f })),
        notice: this.el.notice.textContent ?? '', error: this.err ?? this.panelErr,
      };
    }

    // ------------------------------------------------------------ an interactive plate
    update(_f: Frame) {}
    onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return false;
      if (this.src) { const f = this.src; this.src = null; this.paint(); this.focus(`[data-act="src"][data-file="${CSS.escape(f)}"]`); return true; }
      if (this.mode === 'review') { this.show('running'); this.el.notice.focus(); return true; }
      if (this.mode === 'consent') { this.notNow(); return true; }
      return false;
    }
    getState(): ScriptPlateState {
      const panel = this.mode === 'consent' || this.mode === 'later' || this.mode === 'review' ? this.mode : null;
      return { panel, source: this.src, script: this.scriptState };
    }
    setState(s0: unknown) {
      const s = (s0 ?? {}) as ScriptPlateState;
      if (s.source !== undefined) this.src = typeof s.source === 'string' && code?.sources[s.source] !== undefined ? s.source : null;
      if (s.panel !== undefined) {
        if (this.mode === 'running' || this.mode === 'review') this.mode = s.panel === 'review' ? 'review' : 'running';
        else if (this.mode === 'consent' || this.mode === 'later') this.mode = s.panel === 'later' ? 'later' : 'consent';
      }
      this.paint();
      if (s.script !== undefined && this.sandbox) { this.scriptState = s.script; void this.redraw({ state: s.script }); }
    }
    settled() { return this.waiting; }
    states() {
      const first = code?.files.find((f) => f.path !== 'kit.json')?.path ?? 'kit.json';
      return this.trust.trusted
        ? [{ name: 'rest', state: { panel: null, source: null } }, { name: 'review', state: { panel: 'review', source: null } }, { name: 'review-source', state: { panel: 'review', source: first } }]
        : [{ name: 'consent', state: { panel: 'consent', source: null } }, { name: 'consent-source', state: { panel: 'consent', source: first } }, { name: 'later', state: { panel: 'later', source: null } }];
    }
  };
}
