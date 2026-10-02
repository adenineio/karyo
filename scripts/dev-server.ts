// A dev server of this checkout's own for scripts that drive pages (render.ts, the dev smoke and shot scripts).
// `--url` given: that server is used as is. Otherwise a private, no-HMR Vite server is started in this checkout on a
// free port and stopped on exit. Never the default 5180 / 5190: those are the maintainer's own servers, and a script run
// from a worktree would otherwise test main's code (and the splice smoke tests would write through them).
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

export async function reachable(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

/** A port for a private server: 5400–5799, never one ending in 81 or 13. */
export function freePort(): number {
  for (;;) {
    const p = 5400 + Math.floor(Math.random() * 400);
    if (!/(81|13)$/.test(String(p))) return p;
  }
}

export async function devServer(url?: string): Promise<{ url: string; stop: () => void }> {
  if (url) return { url, stop: () => {} };
  const port = freePort();
  const proc = Bun.spawn(['bunx', 'vite', '--port', String(port), '--strictPort'], { cwd: ROOT, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, KARYO_NO_HMR: '1' } });
  const stop = () => { try { proc.kill(); } catch {} };
  process.on('exit', stop);
  const u = `http://localhost:${port}`;
  for (let i = 0; i < 200 && !(await reachable(u)); i++) await Bun.sleep(100);
  if (!(await reachable(u))) { stop(); throw new Error(`started a private Vite server on ${port}, but it didn't answer within 20 s`); }
  return { url: u, stop };
}
