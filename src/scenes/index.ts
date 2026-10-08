// Scene registry: every module in this folder (except files starting with _) is a scene, keyed by file name.
// Default export: a class extending Scene. Scenes in an optional local dev/scenes/ folder join the gallery when
// it exists; without it the second pattern matches nothing.
import type { SceneClass } from '../engine';

const mods = import.meta.glob<{ default: SceneClass }>(
  ['./*.ts', '!./index.ts', '!./_*.ts', '../../dev/scenes/*.ts', '!../../dev/scenes/_*.ts'],
  { eager: true },
);
export const scenes: Record<string, SceneClass> = Object.fromEntries(
  Object.entries(mods).map(([path, m]) => [path.slice(path.lastIndexOf('/') + 1, -3), m.default]),
);
