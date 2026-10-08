// Dev server only (vite.config.ts): what a project has for Karyo to draw, for the project view (project.html,
// `karyo view`). The project is $KARYO_PROJECT, any folder: nothing here assumes a language or a layout.
//   models      *.model.json files holding a Karyo model ({ karyo: 1, nodes: [...] }), each with the team layout
//               (karyo.layout.json) beside it when there is one
//   explainers  *.explainer.json specs
//   fragments   .karyo/*.karyo.json (scans and recorded runs, merged by `karyo model build`)
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export interface ProjectModel { rel: string; title: string; nodes: number; edges: number; flows: { id: string; title: string; spans: number }[]; tours: number; checks: number; layout: string | null }
export interface ProjectExplainer { rel: string; abs: string; title: string; steps: number }
export interface ProjectIndex { dir: string; name: string; models: ProjectModel[]; explainers: ProjectExplainer[]; fragments: string[]; truncated: boolean }

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '__pycache__', 'out', 'target', '.next', '.cache']);
const MAX_DEPTH = 6, MAX_ENTRIES = 20000, MAX_JSON = 20_000_000;

export async function indexProject(dir: string): Promise<ProjectIndex> {
  const idx: ProjectIndex = { dir, name: basename(dir), models: [], explainers: [], fragments: [], truncated: false };
  let seen = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || idx.truncated) return;
    let names: string[];
    try { names = (await readdir(d)).sort(); } catch { return; }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) { idx.truncated = true; return; }
      const abs = join(d, name);
      if (name === '.karyo') { await fragments(abs); continue; }
      if (SKIP.has(name) || name.startsWith('.')) continue;
      let st; try { st = await stat(abs); } catch { continue; }
      if (st.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!st.isFile() || st.size > MAX_JSON) continue;
      if (name.endsWith('.explainer.json')) {
        const j = await json(abs);
        if (j && typeof j === 'object') idx.explainers.push({ rel: rel(abs), abs, title: String(j.title ?? name), steps: Array.isArray(j.steps) && j.steps.length ? j.steps.length : 1 });
      } else if (name.endsWith('.model.json')) {
        const j = await json(abs);
        if (j?.karyo === 1 && Array.isArray(j.nodes)) {
          const layout = join(dirname(abs), 'karyo.layout.json');
          idx.models.push({
            // what the board draws: modules and import edges are the extracted skeleton, not cards and wires
            rel: rel(abs), title: String(j.project ?? basename(dirname(abs))), nodes: j.nodes.filter((n: any) => n?.kind !== 'module').length,
            edges: (Array.isArray(j.edges) ? j.edges : []).filter((e: any) => e?.kind !== 'imports').length,
            flows: (Array.isArray(j.flows) ? j.flows : []).map((f: any) => ({ id: String(f.id), title: String(f.title ?? f.id), spans: Array.isArray(f.spans) ? f.spans.length : 0 })),
            tours: Array.isArray(j.tours) ? j.tours.length : 0, checks: Array.isArray(j.checks) ? j.checks.length : 0,
            layout: (await isFile(layout)) ? rel(layout) : null,
          });
        }
      }
    }
  };
  const fragments = async (d: string) => {
    try { for (const n of (await readdir(d)).sort()) if (n.endsWith('.karyo.json')) idx.fragments.push(rel(join(d, n))); } catch {}
  };
  const rel = (abs: string) => relative(dir, abs).split(sep).join('/');
  await walk(dir, 0);
  // the model at the project root first, then by path
  idx.models.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel));
  return idx;
}

/** A project-relative path to one of the index's JSON files (a model or its layout), or null when it isn't one. */
export async function projectJson(dir: string, relPath: string): Promise<unknown | null> {
  if (!/\.(model|layout)\.json$/.test(relPath) || relPath.split('/').some((s) => s === '..' || s === '' || s.startsWith('.'))) return null;
  const abs = resolve(dir, relPath), r = relative(dir, abs);
  if (!r || r.startsWith('..') || r.includes(`..${sep}`)) return null;
  return json(abs);
}

async function json(file: string): Promise<any> { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }
async function isFile(f: string) { try { return (await stat(f)).isFile(); } catch { return false; } }
