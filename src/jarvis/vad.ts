// A small energy voice-activity detector for wake mode: 16 kHz mono float samples in, finished speech
// segments out. The thresholds follow the noise floor (it falls fast and rises slowly, and only while nobody
// is speaking), a segment starts after 60 ms above the start threshold (with 300 ms of pre-roll so the first
// syllable isn't clipped), ends after a 300 ms hangover below the stop threshold, and is cut at 10 s.
// Pure and deterministic (tests/jarvis.test.ts).

export interface VadOpts {
  sampleRate?: number;
  /** Frame length (ms). */
  frameMs?: number;
  /** Speech starts this far above the floor (ratio of RMS) and stops below `stopRatio` × floor. */
  startRatio?: number;
  stopRatio?: number;
  /** Never below these RMS levels (a silent room would otherwise trigger on a breath). */
  minStart?: number;
  minStop?: number;
  startMs?: number;
  hangoverMs?: number;
  preRollMs?: number;
  maxMs?: number;
  /** Shorter segments (speech time, without pre-roll and hangover) are dropped as clicks. */
  minSpeechMs?: number;
}

export const rms = (x: Float32Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i]! * x[i]!; return Math.sqrt(s / Math.max(1, b - a)); };
/** RMS → 0..1 on a −60…0 dBFS scale (the bar's meter). */
export const levelOf = (r: number) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(r, 1e-6)) + 60) / 60));

export class Vad {
  readonly o: Required<VadOpts>;
  private frame: number;
  private buf: Float32Array;
  private fill = 0;
  /** Noise floor (RMS); NaN until the first frame. */
  floor = NaN;
  speaking = false;
  private above = 0;
  private below = 0;
  private speechFrames = 0;
  private pre: Float32Array[] = [];
  private seg: Float32Array[] = [];
  private segLen = 0;

  constructor(private onSegment: (pcm: Float32Array) => void, opts: VadOpts = {}) {
    this.o = { sampleRate: 16000, frameMs: 20, startRatio: 3, stopRatio: 2, minStart: 0.006, minStop: 0.004, startMs: 60, hangoverMs: 300, preRollMs: 300, maxMs: 10000, minSpeechMs: 200, ...opts };
    this.frame = Math.round((this.o.sampleRate * this.o.frameMs) / 1000);
    this.buf = new Float32Array(this.frame);
  }
  get startThreshold() { return Math.max(this.o.minStart, (Number.isNaN(this.floor) ? 0 : this.floor) * this.o.startRatio); }
  get stopThreshold() { return Math.max(this.o.minStop, (Number.isNaN(this.floor) ? 0 : this.floor) * this.o.stopRatio); }

  push(x: Float32Array) {
    let i = 0;
    while (i < x.length) {
      const n = Math.min(this.frame - this.fill, x.length - i);
      this.buf.set(x.subarray(i, i + n), this.fill);
      this.fill += n; i += n;
      if (this.fill === this.frame) { this.onFrame(this.buf.slice()); this.fill = 0; }
    }
  }
  /** Drop any segment in progress (e.g. push-to-talk took over the mic). */
  reset() { this.speaking = false; this.above = this.below = this.speechFrames = 0; this.pre = []; this.seg = []; this.segLen = 0; this.fill = 0; }

  private frames(ms: number) { return Math.max(1, Math.round(ms / this.o.frameMs)); }
  private onFrame(f: Float32Array) {
    const e = rms(f);
    if (Number.isNaN(this.floor)) this.floor = e;
    if (!this.speaking) {
      // the floor follows the room only while nobody speaks: down fast, up slowly
      this.floor = e < this.floor ? this.floor * 0.7 + e * 0.3 : this.floor * 0.98 + e * 0.02;
      this.pre.push(f);
      if (this.pre.length > this.frames(this.o.preRollMs)) this.pre.shift();
      this.above = e > this.startThreshold ? this.above + 1 : 0;
      if (this.above >= this.frames(this.o.startMs)) {
        this.speaking = true; this.below = 0; this.speechFrames = this.above;
        this.seg = [...this.pre]; this.segLen = this.seg.reduce((a, b) => a + b.length, 0); this.pre = [];
      }
      return;
    }
    this.seg.push(f); this.segLen += f.length;
    if (e < this.stopThreshold) this.below++; else { this.below = 0; this.speechFrames++; }
    const tooLong = this.segLen >= (this.o.sampleRate * this.o.maxMs) / 1000;
    if (this.below >= this.frames(this.o.hangoverMs) || tooLong) this.finish();
  }
  private finish() {
    const speech = this.speechFrames * this.o.frameMs;
    const out = new Float32Array(this.segLen);
    let at = 0;
    for (const f of this.seg) { out.set(f, at); at += f.length; }
    this.speaking = false; this.above = this.below = this.speechFrames = 0; this.seg = []; this.segLen = 0;
    if (speech >= this.o.minSpeechMs) this.onSegment(out);
  }
}
