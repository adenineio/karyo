// The voice bar along the bottom of jarvis.html: mic state and level, the live transcript, the answer as a
// caption (≤ 3 lines, fades on the next utterance), a one-line activity log, a text field fallback, settings,
// and the connection state. DOM only; main.ts decides what it shows.
import type { MicState } from './protocol';
import { currentTheme, pickTheme, themeOptionsHtml } from '../engine/theme-pick';

export interface PageSettings { wakeWord: string; wakeEnabled: boolean; deviceId: string; motion: boolean }
export const DEFAULT_SETTINGS: PageSettings = { wakeWord: 'adenine', wakeEnabled: false, deviceId: '', motion: true };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** `elsewhere`: the server took another tab's connection over this one (close code 4000); no auto-reconnect. */
export type Conn = 'connecting' | 'up' | 'down' | 'elsewhere';
const LABEL: Record<string, string> = { idle: 'Idle', listening: 'Listening', transcribing: 'Transcribing', thinking: 'Thinking', acting: 'Acting' };

export class Bar {
  readonly el: HTMLElement;
  private q: {
    label: HTMLElement; detail: HTMLElement; meter: HTMLElement; transcript: HTMLElement; caption: HTMLElement;
    activity: HTMLElement; input: HTMLInputElement; gear: HTMLButtonElement; pop: HTMLElement;
    wake: HTMLInputElement; wakeOn: HTMLInputElement; device: HTMLSelectElement; motion: HTMLInputElement; theme: HTMLSelectElement;
  };
  mic: MicState = 'idle';
  conn: Conn = 'connecting';
  /** The caption as shown (cumulative text), and whether it is final. */
  captionText = '';
  captionFinal = true;
  onText: (text: string) => void = () => {};
  onSettings: (s: PageSettings) => void = () => {};
  onOpenSettings: () => void = () => {};
  /** "Use this tab" after another tab took the connection. */
  onReclaim: () => void = () => {};

  constructor(private root: HTMLElement, private settings: PageSettings) {
    const bar = this.el = document.createElement('div');
    bar.className = 'jv-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Voice control');
    bar.innerHTML = `
      <div class="jv-col jv-left">
        <div class="jv-state"><i class="jv-dot" aria-hidden="true"></i><span class="jv-label" aria-live="polite">Idle</span></div>
        <div class="jv-meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><i></i></div>
        <div class="jv-detail"></div>
      </div>
      <div class="jv-mid">
        <div class="jv-transcript" aria-live="polite"></div>
        <div class="jv-caption" aria-live="polite"></div>
      </div>
      <div class="jv-col jv-right">
        <div class="jv-row">
          <input class="jv-input" type="text" placeholder="Type a command · Enter sends" aria-label="Command" autocomplete="off" spellcheck="false">
          <button type="button" class="jv-btn jv-gear" aria-label="Settings" aria-expanded="false" aria-controls="jv-pop" title="Settings">⚙</button>
        </div>
        <div class="jv-activity" aria-live="polite"></div>
      </div>`;
    const pop = document.createElement('div');
    pop.className = 'jv-pop';
    pop.id = 'jv-pop';
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Settings');
    pop.innerHTML = `
      <h2>Settings</h2>
      <label>Theme<select class="jv-theme">${themeOptionsHtml()}</select></label>
      <label>Wake word<input type="text" class="jv-wake" autocomplete="off" spellcheck="false"></label>
      <label class="jv-check"><input type="checkbox" class="jv-wake-on"> Listen for the wake word</label>
      <label>Input device<select class="jv-device"><option value="">System default</option></select></label>
      <label class="jv-check"><input type="checkbox" class="jv-motion"> Animate transitions</label>
      <p class="jv-note">Hold <kbd>Space</kbd> to talk, let go to send. With the wake word on, the mic stays open and each thing you say is checked for the word; everything stays on this machine.</p>`;
    root.append(bar, pop);
    const $ = <T extends HTMLElement>(s: string, r: ParentNode = bar) => r.querySelector<T>(s)!;
    this.q = {
      label: $('.jv-label'), detail: $('.jv-detail'), meter: $('.jv-meter'), transcript: $('.jv-transcript'), caption: $('.jv-caption'),
      activity: $('.jv-activity'), input: $<HTMLInputElement>('.jv-input'), gear: $<HTMLButtonElement>('.jv-gear'), pop,
      wake: $<HTMLInputElement>('.jv-wake', pop), wakeOn: $<HTMLInputElement>('.jv-wake-on', pop), device: $<HTMLSelectElement>('.jv-device', pop), motion: $<HTMLInputElement>('.jv-motion', pop),
      theme: $<HTMLSelectElement>('.jv-theme', pop),
    };
    this.syncSettings();
    this.hint();

    this.q.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        const t = this.q.input.value.trim();
        if (t) { this.q.input.value = ''; this.onText(t); }
        e.preventDefault();
      } else if (e.key === 'Escape') { this.q.input.blur(); e.preventDefault(); }
      e.stopPropagation();   // typing never reaches the plate's keys
    });
    this.q.gear.addEventListener('click', () => this.togglePop());
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.togglePop(false); this.q.gear.focus(); e.preventDefault(); } e.stopPropagation(); });
    document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target as Node) && !this.q.gear.contains(e.target as Node)) this.togglePop(false); });
    const changed = () => {
      this.settings = { wakeWord: this.q.wake.value.trim() || 'adenine', wakeEnabled: this.q.wakeOn.checked, deviceId: this.q.device.value, motion: this.q.motion.checked };
      this.onSettings({ ...this.settings });
    };
    this.q.wake.addEventListener('change', changed);
    for (const x of [this.q.wakeOn, this.q.device, this.q.motion]) x.addEventListener('change', changed);
    // the theme is page-wide (src/engine/theme-pick.ts, localStorage karyo:theme), not a voice setting
    this.q.theme.addEventListener('change', () => pickTheme(this.q.theme.value));
  }

  get input() { return this.q.input; }
  get popOpen() { return !this.q.pop.hidden; }
  togglePop(on = this.q.pop.hidden) {
    this.q.pop.hidden = !on;
    this.q.gear.setAttribute('aria-expanded', String(on));
    if (on) { this.syncSettings(); this.onOpenSettings(); this.q.wake.focus(); }
  }
  private syncSettings() {
    this.q.wake.value = this.settings.wakeWord;
    this.q.wakeOn.checked = this.settings.wakeEnabled;
    this.q.motion.checked = this.settings.motion;
    this.q.device.value = this.settings.deviceId;
    this.q.theme.value = currentTheme() ?? '';
  }
  setSettings(s: PageSettings) { this.settings = { ...s }; this.syncSettings(); this.hint(); }
  setDevices(ds: { id: string; label: string }[]) {
    const cur = this.settings.deviceId;
    this.q.device.innerHTML = `<option value="">System default</option>${ds.filter((d) => d.id && d.id !== 'default').map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')}`;
    this.q.device.value = ds.some((d) => d.id === cur) ? cur : '';
  }

  /** The placeholder line under the transcript when nothing was said yet. */
  private hint() {
    this.q.transcript.dataset.hint = this.mic === 'listening' ? 'Listening…' : `Hold Space to talk${this.settings.wakeEnabled ? `, or say “${this.settings.wakeWord}”` : ''}`;
  }

  setMic(state: MicState | string, detail = '') {
    this.mic = (LABEL[state] ? state : 'idle') as MicState;
    this.root.dataset.mic = this.mic;
    this.q.label.textContent = LABEL[state] ?? state;
    this.hint();
    this.setDetail(detail);
    if (this.mic !== 'listening' && !this.root.classList.contains('is-wake')) this.setLevel(0);
  }
  private detailText = '';
  setDetail(text: string) { this.detailText = text; this.renderDetail(); }
  private renderDetail() {
    const t = this.conn === 'down' ? 'server offline' : this.conn === 'elsewhere' ? 'in another tab' : this.detailText || (this.conn === 'connecting' ? 'connecting…' : this.settings.wakeEnabled ? `wake word: ${this.settings.wakeWord}` : 'push-to-talk');
    if (this.q.detail.textContent !== t) this.q.detail.textContent = t;
  }
  setLevel(k: number) {
    const v = Math.max(0, Math.min(1, k));
    this.q.meter.style.setProperty('--lvl', v.toFixed(3));
    this.q.meter.setAttribute('aria-valuenow', v.toFixed(2));
  }
  setWake(on: boolean) { this.root.classList.toggle('is-wake', on); this.hint(); this.renderDetail(); }

  setConn(conn: Conn, retryIn = 0) {
    const was = this.conn;
    this.conn = conn;
    this.root.dataset.conn = conn;
    this.renderDetail();
    if (conn === 'down') {
      this.q.caption.className = 'jv-caption is-hint';
      this.q.caption.innerHTML = `Server not running — start it with <code>just jarvis</code>${retryIn ? ` · retrying in ${Math.ceil(retryIn / 1000)} s` : ''}`;
      this.captionText = ''; this.captionFinal = true;
    } else if (conn === 'elsewhere') {
      this.q.caption.className = 'jv-caption is-hint';
      this.q.caption.innerHTML = 'Jarvis is connected in another tab (one page at a time). <button type="button" class="jv-link" data-reclaim>Use this tab</button>';
      this.q.caption.querySelector('[data-reclaim]')!.addEventListener('click', () => this.onReclaim());
      this.captionText = ''; this.captionFinal = true;
    } else if ((was === 'down' || was === 'elsewhere') && conn === 'up') {
      this.q.caption.className = 'jv-caption'; this.q.caption.textContent = '';
    }
  }

  setTranscript(text: string, accepted: boolean, wake = false) {
    this.q.transcript.textContent = text;
    this.q.transcript.classList.toggle('is-faint', !accepted);
    // why it was set aside (wake mode): no wake word, or the wake word with nothing after it
    if (accepted || !text) delete this.q.transcript.dataset.why;
    else this.q.transcript.dataset.why = wake ? 'wake word only — say the command after it' : 'no wake word';
    this.q.transcript.title = text;
  }
  /** A new utterance began: the last answer fades (and is gone once the new one arrives). */
  fadeCaption() {
    if (this.conn === 'down' || this.conn === 'elsewhere' || !this.captionText) return;
    this.q.caption.classList.add('is-old');
    this.captionFinal = true;
  }
  /** Caption text streams in: every message carries the whole text so far, so it replaces what is shown (a turn
   *  may close several blocks with `final`; the last one stays). */
  setCaption(text: string, final: boolean) {
    const next = text;
    this.captionText = next; this.captionFinal = final;
    this.q.caption.className = `jv-caption${final ? '' : ' is-partial'}`;
    this.q.caption.textContent = next;
    this.q.caption.title = next;
  }
  /** One line per thing done; a refused action (`couldn't <name>: …`) reads as an error. */
  setActivity(text: string, error = /^couldn['’]t /i.test(text)) {
    this.q.activity.textContent = text;
    this.q.activity.title = text;
    this.q.activity.classList.toggle('is-error', error);
  }
  get texts() {
    return { mic: this.mic, label: this.q.label.textContent, transcript: this.q.transcript.textContent, faint: this.q.transcript.classList.contains('is-faint'), caption: this.q.caption.textContent, captionOld: this.q.caption.classList.contains('is-old'), activity: this.q.activity.textContent, conn: this.conn, detail: this.q.detail.textContent };
  }
}
