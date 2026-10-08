// Jarvis mode's pure parts: name resolution (fuzzy.ts), the wake-mode VAD (vad.ts), the audio payload (protocol.ts).
import { describe, expect, test } from 'bun:test';
import { best, rank, score, norm } from '../src/jarvis/fuzzy';
import { Vad, rms, levelOf } from '../src/jarvis/vad';
import { pcmToBase64, base64ToPcm } from '../src/jarvis/protocol';

const cands = [
  { kind: 'node', id: 'orders.items', label: 'Order items' },
  { kind: 'node', id: 'pipeline.sessions', label: 'Session store' },
  { kind: 'node', id: 'pipeline.runner', label: 'Pipeline runner' },
  { kind: 'node', id: 'orders.dispatch', label: 'Dispatcher' },
  { kind: 'group', id: 'pipeline', label: 'pipeline' },
  { kind: 'tag', id: 'tag:needs-review', label: 'needs-review' },
  { kind: 'tag', id: 'cat:store', label: 'store' },
];

describe('fuzzy names', () => {
  test('normalizes case, separators and legend prefixes', () => {
    expect(norm('Order.Items')).toBe('order items');
    expect(norm('tag:needs-review')).toBe('needs review');
  });
  test('exact, plural, typo, id and spoken spellings resolve', () => {
    expect(best('order items', cands)?.id).toBe('orders.items');
    expect(best('Order item', cands)?.id).toBe('orders.items');
    expect(best('sesion store', cands)?.id).toBe('pipeline.sessions');
    expect(best('pipeline.runner', cands)?.id).toBe('pipeline.runner');
    expect(best('needs review', cands)?.id).toBe('tag:needs-review');
    expect(best('sessionstore', cands)?.id).toBe('pipeline.sessions');
  });
  test('a word that names a whole entry beats a partial one', () => {
    expect(best('pipeline', cands)?.id).toBe('pipeline');
    expect(best('store', cands)?.id).toBe('cat:store');
  });
  test('unrelated words resolve to nothing', () => {
    expect(best('flux capacitor', cands)).toBeNull();
    expect(best('', cands)).toBeNull();
    expect(score('banana', 'Dispatcher')).toBeLessThan(0.62);
  });
  test('rank is best first and stable for ties', () => {
    const r = rank('pipeline', cands);
    expect(r[0]!.id).toBe('pipeline');
    expect(r.map((x) => x.score)).toEqual([...r.map((x) => x.score)].sort((a, b) => b - a));
  });
});

// ---- VAD: synthetic 16 kHz signals
const SR = 16000;
const noise = (sec: number, amp: number, seed = 1) => { let s = seed; const x = new Float32Array(Math.round(sec * SR)); for (let i = 0; i < x.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = amp * ((s / 0x7fffffff) * 2 - 1); } return x; };
const tone = (sec: number, amp: number) => { const x = new Float32Array(Math.round(sec * SR)); for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR); return x; };
const cat = (...xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((a, x) => a + x.length, 0)); let at = 0; for (const x of xs) { o.set(x, at); at += x.length; } return o; };
/** Feed in 20 ms chunks, like the worklet. */
const run = (x: Float32Array) => { const segs: Float32Array[] = []; const v = new Vad((s) => segs.push(s)); for (let i = 0; i < x.length; i += 320) v.push(x.subarray(i, i + 320)); return { segs, v }; };

describe('wake-mode VAD', () => {
  test('silence and steady room noise give no segments', () => {
    expect(run(noise(3, 0.001)).segs.length).toBe(0);
    expect(run(noise(4, 0.05)).segs.length).toBe(0);          // a loud but steady floor is the floor
  });
  test('one utterance → one segment: pre-roll + speech + hangover', () => {
    const { segs } = run(cat(noise(1, 0.002), tone(1.2, 0.2), noise(1, 0.002)));
    expect(segs.length).toBe(1);
    const sec = segs[0]!.length / SR;
    expect(sec).toBeGreaterThan(1.2);
    expect(sec).toBeLessThan(1.2 + 0.3 + 0.3 + 0.1);
    expect(rms(segs[0]!)).toBeGreaterThan(0.05);
  });
  test('two utterances with a pause → two segments', () => {
    expect(run(cat(noise(0.5, 0.002), tone(0.6, 0.2), noise(0.8, 0.002), tone(0.6, 0.2), noise(0.6, 0.002))).segs.length).toBe(2);
  });
  test('a click is dropped; a pause shorter than the hangover does not split', () => {
    expect(run(cat(noise(0.5, 0.002), tone(0.08, 0.3), noise(0.8, 0.002))).segs.length).toBe(0);
    expect(run(cat(noise(0.5, 0.002), tone(0.5, 0.2), noise(0.2, 0.002), tone(0.5, 0.2), noise(0.8, 0.002))).segs.length).toBe(1);
  });
  test('a segment is cut at 10 s', () => {
    const { segs } = run(cat(noise(0.5, 0.002), tone(12, 0.2), noise(0.6, 0.002)));
    expect(segs.length).toBe(2);
    expect(segs[0]!.length / SR).toBeCloseTo(10, 1);
  });
  test('level meter scale', () => {
    expect(levelOf(0)).toBe(0);
    expect(levelOf(1)).toBe(1);
    expect(levelOf(0.001)).toBeCloseTo(0, 5);
  });
});

describe('audio payload', () => {
  test('float32 little-endian base64 round-trips', () => {
    const x = Float32Array.from([0, 1, -1, 0.5, -0.25, 1e-7, 0.123456]);
    const b = pcmToBase64(x);
    expect(Buffer.from(b, 'base64').length).toBe(x.length * 4);
    expect([...base64ToPcm(b)]).toEqual([...x]);
    expect(Buffer.from(b, 'base64').readFloatLE(4)).toBe(1);
  });
  test('a long buffer (10 s at 16 kHz) encodes', () => {
    const x = tone(10, 0.3);
    expect(base64ToPcm(pcmToBase64(x)).length).toBe(160000);
  });
});
