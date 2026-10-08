// The page's kits (docs/KITS.md): an entry point imports this first, so every plate built after it (at module load,
// a scene file's boardScene(model)) draws kit kinds with them. A scene that draws a project of its own binds that
// project's kits to its model instead (`useKits(model, kits)`, with `kits` from `virtual:karyo-kits/<its folder>`).
// It also hands the page's key to Karyo's local server to the page's own requests (src/kits/devtoken.ts).
import bundle from 'virtual:karyo-kits';
import { setDefaultKits } from './registry';
import { installDevToken } from './devtoken';

installDevToken();
setDefaultKits(bundle);
