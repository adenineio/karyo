#!/usr/bin/env bun
// A model file's history as Stack view slices (src/model/stack.ts): the file as it was at each commit.
//
//   bun scripts/stack-from-git.ts <model.json> [--last N | --commits a,b,c] [--full] -o <out.json>
//
// Reads the file at each commit with `git show <sha>:<path>`. Without --commits, every commit that touched
// the file is used (following renames and moves, `git log --follow`, each read under its name then), or the
// last N of them; with --commits, the file's current path in each, skipping commits that don't have it.
// Slices run oldest first. Each slice keeps what a
// map draws (nodes, edges, checks, project, producers); --full also keeps flows, tours and code.
// Writes { source, slices: [{ id: sha, title: subject, subtitle: "sha · date", model }] }.
import path from 'node:path';
import { formatVersion, type Model, type Fragment } from '../src/model/model';

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const file = argv.find((a, i) => !a.startsWith('-') && !['--last', '--commits', '-o', '--out'].includes(argv[i - 1] ?? ''));
const out = opt('-o') ?? opt('--out');
if (!file || !out) {
  console.error('usage: bun scripts/stack-from-git.ts <model.json> [--last N | --commits a,b,c] [--full] -o <out.json>');
  process.exit(2);
}

const git = (args: string[], cwd: string) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
};
const abs = path.resolve(file);
const top = git(['rev-parse', '--show-toplevel'], path.dirname(abs));
if (!top.ok) { console.error(`not in a git repository: ${file}`); process.exit(1); }
const root = top.out.trim();
const rel = path.relative(root, abs).split(path.sep).join('/');
interface Commit { sha: string; short: string; date: string; subject: string; path: string }
const fmt = '%H%x09%h%x09%cs%x09%s';
const parse = (l: string, path: string): Commit => { const [sha, short, date, ...rest] = l.split('\t'); return { sha: sha!, short: short!, date: date!, subject: rest.join('\t'), path }; };
let commits: Commit[];
const list = opt('--commits');
if (list) {
  commits = list.split(',').map((c) => c.trim()).filter(Boolean).flatMap((c) => {
    const r = git(['log', '-1', `--format=${fmt}`, c], root);
    if (!r.ok) { console.error(`skip ${c}: not a commit`); return []; }
    return [parse(r.out.trim(), rel)];
  });
} else {
  // one record per commit: its header line, then the file's name in that commit (renames followed)
  const r = git(['log', '--follow', '--name-only', `--format=%x00${fmt}`, '--', rel], root);
  if (!r.ok) { console.error(r.err); process.exit(1); }
  commits = r.out.split('\0').filter((x) => x.trim()).map((rec) => {
    const [head, ...names] = rec.split('\n').filter(Boolean);
    return parse(head!, names[names.length - 1] ?? rel);
  }).reverse();                                           // oldest first
  const n = opt('--last');
  if (n) commits = commits.slice(-Math.max(1, +n));
}

const full = argv.includes('--full');
const short = (s: string, n = 64) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const slices: { id: string; title: string; subtitle: string; model: Model }[] = [];
for (const c of commits) {
  const from = c.path, shown = git(['show', `${c.sha}:${from}`], root);
  if (!shown.ok) { console.error(`skip ${c.short}: ${from} not in this commit`); continue; }
  const raw = shown.out;
  let frag: Fragment;
  try { frag = JSON.parse(raw); } catch (e) { console.error(`skip ${c.short}: ${from} is not JSON (${(e as Error).message})`); continue; }
  if (formatVersion(frag) !== 1 || !Array.isArray(frag.nodes) || !Array.isArray(frag.edges)) { console.error(`skip ${c.short}: ${from} is not a version-1 model`); continue; }
  const m = { ...frag, karyo: 1 } as Model;
  const model: Model = full ? m : {
    karyo: 1, project: m.project, producers: m.producers,
    nodes: m.nodes.map(({ code: _c, ...n }) => n), edges: m.edges, flows: [], checks: m.checks,
  };
  slices.push({ id: c.sha, title: short(c.subject), subtitle: `${c.short} · ${c.date}`, model });
  console.error(`${c.short} ${c.date} ${from}: ${m.nodes.length} nodes, ${m.edges.length} edges`);
}
if (!slices.length) { console.error('no commit has the file'); process.exit(1); }
await Bun.write(out, JSON.stringify({ source: rel, slices }, null, 1) + '\n');
console.log(`${out}: ${slices.length} slice(s)`);
