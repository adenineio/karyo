// A Stack view that isn't history: one page load seen at four network layers, top (HTTP) to
// bottom (IP). Each layer is a small hand-written model over the same cast, so every box keeps its
// place and the legend shows what each layer adds or loses compared with the one above it.
import { stackView, type StackSlice } from '../model/stack';
import type { Model, MNode, MEdge } from '../model/model';

const node = (id: string, label: string, kind: MNode['kind'], group: string, category: string, summary: string): MNode =>
  ({ id, label, kind, group, category, summary, sources: ['declared'] });
const CAST: Record<string, MNode> = {
  browser: { ...node('browser', 'Browser', 'actor', 'you', 'client', 'the page asking for /index.html') },
  router: node('router', 'Home router', 'service', 'you', 'network', 'NAT and the first hop'),
  isp: node('isp', 'ISP routers', 'service', 'internet', 'network', 'a handful of hops you never see'),
  edge: node('edge', 'CDN edge', 'service', 'provider', 'edge', 'terminates TLS, caches, forwards'),
  app: node('app', 'App server', 'service', 'provider', 'server', 'renders the page'),
  db: node('db', 'Database', 'store', 'provider', 'server', 'rows the page is built from'),
};
// a hop every layer knows is there (declared and seen, so it draws solid)
const hop = (from: string, to: string): MEdge => ({ from, to, kind: 'calls', sources: ['declared', 'observed'] });
const model = (ids: string[], edges: MEdge[]): Model => ({ karyo: 1, project: 'page-load', nodes: ids.map((id) => CAST[id]!), edges, flows: [] });

const slices: StackSlice[] = [
  { id: 'http', title: 'HTTP: who asks whom', subtitle: 'application layer', model: model(['browser', 'edge', 'app'], [hop('browser', 'edge'), hop('edge', 'app')]) },
  { id: 'tls', title: 'TLS: what is encrypted', subtitle: 'the edge ends your session', model: model(['browser', 'edge', 'app'], [hop('browser', 'edge')]) },
  { id: 'tcp', title: 'TCP: which connections exist', subtitle: 'transport layer', model: model(['browser', 'edge', 'app', 'db'], [hop('browser', 'edge'), hop('edge', 'app'), hop('app', 'db')]) },
  { id: 'ip', title: 'IP: every hop on the way', subtitle: 'network layer', model: model(['browser', 'router', 'isp', 'edge', 'app', 'db'], [hop('browser', 'router'), hop('router', 'isp'), hop('isp', 'edge'), hop('edge', 'app'), hop('app', 'db')]) },
];

export default stackView(slices, { title: 'One page load, layer by layer', summary: 'Layers · top to bottom', noun: 'layer' });
