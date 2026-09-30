// Jarvis mode's microphone: getUserMedia → a low-pass → an AudioWorklet that downsamples to 16 kHz mono
// float32 and posts 20 ms chunks. Push-to-talk collects chunks while Space is held; wake mode feeds them to the
// energy VAD (vad.ts). The mic opens on the first Space press (or when wake mode is turned on), so the browser
// asks for permission then, and stays open while it's used: a minute after the last push-to-talk (wake mode off)
// it closes again, which also turns off the browser's recording indicator.

/** The worklet, inline (a Blob URL), so dev and the built site load it the same way. Box-filter decimation at the
 *  context's rate → 16 kHz (fractional ratios are fine), channels mixed to mono, 320-sample (20 ms) chunks. */
const WORKLET = /* js */ `
class KaryoDown16k extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.pos = 0; this.acc = 0; this.n = 0; this.out = new Float32Array(320); this.k = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const chs = inp.length, len = inp[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chs; c++) s += inp[c][i];
      this.acc += s / chs; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.out[this.k++] = this.acc / this.n; this.acc = 0; this.n = 0;
        if (this.k === this.out.length) { this.port.postMessage(this.out); this.out = new Float32Array(320); this.k = 0; }
      }
    }
    return true;
  }
}
registerProcessor('karyo-down16k', KaryoDown16k);
`;
let workletUrl: string | null = null;

export const RATE = 16000;

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private opening: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | 0 = 0;
  deviceId = '';
  /** 16 kHz mono chunks (20 ms each) while the mic is open. */
  onChunk: (pcm: Float32Array) => void = () => {};

  get isOpen() { return !!this.node; }

  /** Open the mic (asks for permission the first time). Reopens when the device changed. */
  open(deviceId = this.deviceId): Promise<void> {
    this.keep();
    if (this.node && deviceId === this.deviceId) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = (async () => {
      this.shut();
      this.deviceId = deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(workletUrl);
      const src = ctx.createMediaStreamSource(stream);
      // keep what 16 kHz can carry (below 8 kHz) before the decimation
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7200, Q: 0.707 });
      const node = new AudioWorkletNode(ctx, 'karyo-down16k', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk(e.data);
      const mute = new GainNode(ctx, { gain: 0 });   // pulled by the graph, never heard
      src.connect(lp).connect(node).connect(mute).connect(ctx.destination);
      this.ctx = ctx; this.stream = stream; this.node = node;
    })().finally(() => { this.opening = null; });
    return this.opening;
  }
  /** Something is using the mic: push back the idle close. `ms` = 0 keeps it open until `release()`. */
  keep(ms = 60_000) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = ms ? setTimeout(() => this.shut(), ms) : 0;
  }
  shut() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    this.node?.port.close(); this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.node = null; this.stream = null; this.ctx = null;
  }
}

/** The audio input devices (labels appear once permission was granted). */
export async function inputDevices(): Promise<{ id: string; label: string }[]> {
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    return ds.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch { return []; }
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
