// `karyo docket …`: the commands. cli/karyo.ts parses the arguments and hands them here; this file turns them
// into format.ts changes applied through store.ts, and prints for people or (--json) for tools.
import { spawnSync } from 'node:child_process';
import {
  addItem, closeItem, editItem, find, items, KINDS, maxId, milestonesNote, oneLine, parseId, reopenItem, SECTION, title,
  type Docket, type Edit, type Kind, type Located,
} from './format';
import { commitHandEdits, DocketError, ensureFile, load, locate, paths, session, today, update, type Loaded, type Place, type Sidecar } from './store';

export { DocketError } from './store';

type Flags = Record<string, string | true>;

export const DOCKET_HELP = `karyo docket: the per-project sheet of things that need you (decisions, reviews, come-back-tos)

usage: karyo docket <command> [args] [--repo <dir>] [--json]

  add "<summary>" [--kind decision|review|later] [--why "<text>"] [--before "<milestone>"]
      [--ref file:line] [--session <name>]
                                  add an item (default kind: decision); prints its id and the file
  list [--all] [--kind decision|review|later|closed] [--before "<milestone>"]
                                  open items grouped as in the file (--all: closed ones too)
  show D-14                       one item, with everything recorded about it
  close D-14 "<resolution>"       close it with what was decided or done
  reopen D-14                     back to its section, resolution dropped
  edit D-14 [--summary …] [--kind …] [--before …] [--why …] [--ref …]
                                  change fields ("" clears before / why / ref); a new kind moves it
  milestones                      the distinct "before" values, with open counts
  path                            the docket file's path
  open                            open the file in $VISUAL / $EDITOR (then commit your edits), else the OS opener

  --repo <dir>                    the repository whose docket to use (default: the current directory)
  --json                          one JSON document on stdout, errors as {"error": …}

One docket per repository, shared by every worktree, branch and clone: $KARYO_HOME/dockets/<repo>-<root sha8>.md
($KARYO_HOME defaults to ~/.adenine/karyo, a git repo that gets one commit per change). Format: docs/DOCKET.md.`;

const str = (f: Flags, k: string) => (typeof f[k] === 'string' ? (f[k] as string) : f[k] === true ? '' : undefined);

function kindFlag(f: Flags, allowClosed = false): Kind | 'closed' | undefined {
  const k = str(f, 'kind');
  if (k === undefined) return undefined;
  const v = k.toLowerCase();
  if ((KINDS as string[]).includes(v) || (allowClosed && v === 'closed')) return v as Kind | 'closed';
  throw new DocketError(`--kind is one of ${KINDS.join(', ')}${allowClosed ? ', closed' : ''} (got "${k}")`);
}

function idArg(s: string | undefined, usage: string): number {
  const n = parseId(s);
  if (n === null) throw new DocketError(s ? `"${s}" isn't a docket id (like D-14)` : `usage: karyo docket ${usage}`);
  return n;
}

function need(d: Docket, n: number): Located {
  const l = find(d, n);
  if (!l) throw new DocketError(`no D-${n} on this docket`);
  return l;
}

// ---------------------------------------------------------------- JSON shapes

export function itemJson(l: Located, side: Sidecar) {
  const it = l.item;
  const x = side.items[`D-${it.n}`] ?? {};
  const from = it.from ? /^(.*?)\s*@\s*(\S+)$/.exec(it.from) : null;
  return {
    id: `D-${it.n}`,
    n: it.n,
    status: l.status,
    kind: l.kind,
    section: l.section,
    summary: it.summary,
    why: it.why ?? null,
    before: it.before ?? null,
    from: it.from ?? null,
    branch: from ? from[1] || null : null,
    sha: from ? from[2]! : it.from ?? null,
    worktree: it.worktree ?? null,
    worktreePath: x.worktreePath ?? null,
    session: it.session ?? null,
    sessionId: x.sessionId ?? null,
    ref: it.ref ?? null,
    date: it.date ?? null,
    resolution: it.resolution ?? null,
    closed: it.closed ?? null,
    closedSession: it.closedSession ?? null,
    closedSessionId: x.closedSessionId ?? null,
    extra: Object.fromEntries(it.extra),
    notes: it.notes,
  };
}

const docketJson = (l: Loaded) => ({ name: l.place.name, title: title(l.docket), key: l.place.key, root: l.place.root, git: l.place.git, path: l.md, exists: l.exists });

// ---------------------------------------------------------------- printing

function metaLine(l: Located): string {
  const it = l.item;
  const parts: string[] = [];
  if (it.before) parts.push(`before ${it.before}`);
  if (it.from) parts.push(`from ${it.from}`);
  if (it.worktree) parts.push(`worktree ${it.worktree}`);
  if (it.session) parts.push(`session ${it.session}`);
  if (it.ref) parts.push(`ref ${it.ref}`);
  if (it.date) parts.push(it.date);
  return parts.join(' · ');
}

function printItem(l: Located) {
  const it = l.item;
  const id = `D-${it.n}`.padEnd(6);
  const head = it.done && it.resolution ? `${it.summary} — ${it.resolution}` : it.summary;
  console.log(`  ${id} ${head}`);
  const meta = metaLine(l);
  if (meta) console.log(`         ${meta}`);
  if (it.done && it.closed) console.log(`         closed ${it.closed}${it.closedSession ? ` · session ${it.closedSession}` : ''}`);
}

// ---------------------------------------------------------------- commands

export async function runDocket(pos: string[], flags: Flags, json: boolean): Promise<number> {
  const sub = pos[0];
  if (!sub || sub === 'help' || flags.help === true || flags.h === true) { console.log(DOCKET_HELP); return 0; }
  const place = locate(str(flags, 'repo') || process.cwd());
  const warnings = [...place.warnings];
  const warn = () => { if (!json) for (const w of warnings) console.error(`karyo docket: warning: ${w}`); };
  const emit = (o: Record<string, unknown>) => console.log(JSON.stringify({ ...o, warnings }, null, 2));
  const rest = pos.slice(1);

  switch (sub) {
    case 'add': {
      const summary = oneLine(rest.join(' '));
      if (!summary) throw new DocketError('usage: karyo docket add "<summary>" [--kind decision|review|later] [--why …] [--before …] [--ref …]');
      const kind = (kindFlag(flags) ?? 'decision') as Kind;
      const who = session(str(flags, 'session'));
      const r = update(place, (l) => {
        const n = Math.max(l.sidecar.lastId, maxId(l.docket)) + 1;
        const it = addItem(l.docket, n, {
          summary, kind,
          before: oneLine(str(flags, 'before') ?? '') || undefined,
          from: place.git ? (place.branch ? `${place.branch} @ ${place.sha}` : place.sha) : undefined,
          worktree: place.worktree,
          session: who.name,
          ref: oneLine(str(flags, 'ref') ?? '') || undefined,
          date: today(),
          why: oneLine(str(flags, 'why') ?? '') || undefined,
        });
        l.sidecar.lastId = n;
        l.sidecar.items[`D-${n}`] = { worktreePath: place.worktreePath, sessionId: who.id };
        return { result: { l, it }, message: `docket: add D-${n} · ${place.name}` };
      });
      warnings.push(...r.warnings);
      const { l, it } = r.result!;
      if (json) emit({ id: `D-${it.n}`, path: l.md, commit: r.commit, docket: docketJson({ ...l, exists: true }), item: itemJson(need(l.docket, it.n), l.sidecar) });
      else { warn(); console.log(`D-${it.n} · ${SECTION[kind]}\n${l.md}`); }
      return 0;
    }

    case 'list': {
      const l = load(place);
      const kind = kindFlag(flags, true);
      const before = str(flags, 'before');
      const all = flags.all === true || kind === 'closed';
      const pick = items(l.docket).filter((x) => {
        if (kind === 'closed') { if (x.status !== 'closed') return false; }
        else if (!all && x.status !== 'open') return false;
        else if (kind && x.kind !== kind) return false;
        return before === undefined || (x.item.before ?? '').toLowerCase() === before.trim().toLowerCase();
      });
      if (json) { emit({ docket: docketJson(l), items: pick.map((x) => itemJson(x, l.sidecar)) }); return 0; }
      warn();
      const open = items(l.docket).filter((x) => x.status === 'open').length;
      console.log(`Docket · ${title(l.docket) ?? place.name} · ${open} open${l.exists ? '' : ' (no file yet)'}\n${l.md}`);
      if (!pick.length) { console.log('\n  (nothing here)'); return 0; }
      let section: string | null | undefined;
      for (const x of pick) {
        if (x.section !== section) { section = x.section; console.log(`\n${section ?? '(before any section)'}`); }
        printItem(x);
      }
      return 0;
    }

    case 'show': {
      const n = idArg(rest[0], 'show D-14');
      const l = load(place);
      const x = need(l.docket, n);
      if (json) { emit({ docket: docketJson(l), item: itemJson(x, l.sidecar) }); return 0; }
      warn();
      const j = itemJson(x, l.sidecar);
      const rows: [string, string | null][] = [
        ['summary', j.summary], ['status', j.status], ['section', j.section], ['why', j.why], ['before', j.before],
        ['from', j.from], ['worktree', j.worktreePath ? `${j.worktree} (${j.worktreePath})` : j.worktree],
        ['session', j.sessionId ? `${j.session ?? ''} (${j.sessionId})`.trim() : j.session], ['ref', j.ref], ['added', j.date],
        ['resolution', j.resolution], ['closed', j.closed ? `${j.closed}${j.closedSession ? ` · session ${j.closedSession}` : ''}` : null],
        ...Object.entries(j.extra) as [string, string][],
      ];
      console.log(j.id);
      for (const [k, v] of rows) if (v) console.log(`  ${(k + ':').padEnd(12)}${v}`);
      for (const note of j.notes) console.log(`  ${note.trim()}`);
      return 0;
    }

    case 'close': {
      const n = idArg(rest[0], 'close D-14 "<resolution>"');
      const resolution = oneLine(rest.slice(1).join(' ') || str(flags, 'resolution') || '');
      const who = session(str(flags, 'session'));
      const r = update(place, (l) => {
        const x = need(l.docket, n);
        if (x.status === 'closed') throw new DocketError(`D-${n} is already closed (reopen D-${n} first)`);
        const it = closeItem(l.docket, n, { resolution, date: today(), session: who.name });
        const side = (l.sidecar.items[`D-${n}`] ??= {});
        if (who.id) side.closedSessionId = who.id;
        return { result: { l, it }, message: `docket: close D-${n} · ${place.name}` };
      });
      return done(r, 'closed');
    }

    case 'reopen': {
      const n = idArg(rest[0], 'reopen D-14');
      const r = update(place, (l) => {
        const x = need(l.docket, n);
        if (x.status === 'open') throw new DocketError(`D-${n} is already open`);
        const it = reopenItem(l.docket, n);
        delete l.sidecar.items[`D-${n}`]?.closedSessionId;
        return { result: { l, it }, message: `docket: reopen D-${n} · ${place.name}` };
      });
      return done(r, 'reopened');
    }

    case 'edit': {
      const n = idArg(rest[0], 'edit D-14 [--summary …] [--kind …] [--before …] [--why …] [--ref …]');
      const e: Edit = {};
      const kind = kindFlag(flags);
      if (kind) e.kind = kind as Kind;
      for (const k of ['summary', 'before', 'why', 'ref'] as const) { const v = str(flags, k); if (v !== undefined) e[k] = v; }
      if (!Object.keys(e).length) throw new DocketError('nothing to change: pass --summary, --kind, --before, --why or --ref');
      if (e.summary !== undefined && !oneLine(e.summary)) throw new DocketError('--summary can\'t be empty');
      const r = update(place, (l) => {
        need(l.docket, n);
        const it = editItem(l.docket, n, e);
        return { result: { l, it }, message: `docket: edit D-${n} · ${place.name}` };
      });
      return done(r, 'edited');
    }

    case 'milestones': {
      const l = load(place);
      const m = new Map<string, { before: string | null; open: number; closed: number }>();
      for (const x of items(l.docket)) {
        const b = x.item.before ?? null;
        const k = b === null ? '\u0000' : b.toLowerCase();
        const e = m.get(k) ?? { before: b, open: 0, closed: 0 };
        e[x.status]++;
        m.set(k, e);
      }
      const list = [...m.values()].sort((a, b) => (a.before === null ? 1 : b.before === null ? -1 : 0));
      const note = milestonesNote(l.docket);
      if (json) { emit({ docket: docketJson(l), note, milestones: list }); return 0; }
      warn();
      if (note) console.log(`Milestones: ${note}\n`);
      const shown = list.filter((x) => x.open > 0 || flags.all === true);
      if (!shown.length) console.log('  (no open items)');
      for (const x of shown) console.log(`  ${String(x.open).padStart(3)} open  ${x.before ?? '(no milestone)'}${x.closed ? `  · ${x.closed} closed` : ''}`);
      return 0;
    }

    case 'path': {
      const p = paths(place);
      if (json) emit({ path: p.md, sidecar: p.side, key: place.key, name: place.name, root: place.root, git: place.git });
      else { warn(); console.log(p.md); }
      return 0;
    }

    case 'open': {
      const p = paths(place);
      const e = ensureFile(place);
      warnings.push(...e.warnings);
      const editor = (process.env.VISUAL || process.env.EDITOR || '').trim();
      let commit: string | null = null;
      if (editor) {
        const q = `'${p.md.replace(/'/g, `'\\''`)}'`;
        const r = spawnSync('/bin/sh', ['-c', `${editor} ${q}`], { stdio: json ? ['inherit', 'ignore', 'inherit'] : 'inherit' });
        if (r.status !== 0) warnings.push(`${editor} exited with ${r.status ?? r.signal}`);
        const c = commitHandEdits(place);
        commit = c.commit; warnings.push(...c.warnings);
      } else {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        spawnSync(opener, [p.md], { stdio: 'ignore' });
      }
      if (json) emit({ path: p.md, created: e.created, editor: editor || null, commit });
      else { warn(); console.log(p.md); }
      return 0;
    }

    default:
      throw new DocketError(`unknown docket command "${sub}" (karyo docket --help lists them)`);
  }

  function done(r: { result: { l: Loaded; it: { n: number } } | null; commit: string | null; warnings: string[] }, verb: string): number {
    warnings.push(...r.warnings);
    const { l, it } = r.result!;
    const x = need(l.docket, it.n);
    if (json) emit({ id: `D-${it.n}`, path: l.md, commit: r.commit, item: itemJson(x, l.sidecar) });
    else { warn(); console.log(`D-${it.n} ${verb} · ${x.section ?? ''}`.trimEnd()); }
    return 0;
  }
}
