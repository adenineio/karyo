# The Karyo model: code that describes itself

Karyo can draw a project from a **model file** that the code itself produces. Any language can write it; Python and Go SDKs are included. The same file drives two generic scenes, a **structure map** and a **flow replay**, so the visuals show how the code actually fits together rather than how someone once drew it.

```
  Python code ──┐  annotations + import scan + recorded runs
                ├──►  fragments (*.karyo.json) ──► merge + reconcile ──► model.json ──► Karyo scenes
  Go code ──────┘                                    (warnings)                      (map, flow replay)
```

It's the compiler shape: language front-ends, one neutral format, then renderers. The same split is what lets OpenTelemetry support many languages with small SDKs. The SDKs never render anything. They only describe, which keeps each new language cheap.

## Three kinds of truth

| source | how | answers |
|---|---|---|
| **declared** | comment directives you write: `# karyo:node ...` in Python, `//karyo:node ...` in Go | what the design is meant to be |
| **extracted** | static scan: the directives and Python imports (via `tokenize` + `ast`), Go imports (via `go list`); in [automatic mode](#automatic-mode), every class and public function as a node and the static call graph | what the code can call |
| **observed** | recorded runs (`python -m karyo record`, or `karyo.watch()` when `KARYO_RECORD` asks): every call between the project's functions (Python's `sys.monitoring` recorder), or spans around the marked functions; joined across processes by a trace id | what the code does call, in what order, and what never ran |

The three cover each other's gaps. The static layer is complete with no run (every module, class and function, and every call it can resolve for certain), but a registry, a list of callbacks or a `getattr` hides calls from it. A recording sees those, but only what the run happened to exercise. Declarations and a [curation file](#curation) say what matters and how it's grouped. After a recording that watched whole packages, what never ran is marked [not exercised](#coverage), so a partial run never reads as a complete one.

Reconciling them produces **warnings** (never failures, by default). The merge tool prints them, and the scenes show them as badges. **Errors** are different: they mean the model itself can't be drawn truthfully (see [Identity](#identity)), and `build` and `check` fail on them.

| code | meaning |
|---|---|
| `undeclared-call` | a run observed A → B, but no annotation declares it (and, in automatic mode, static analysis didn't find it: a dynamic call) |
| `unobserved-call` | an annotation declares A → B, but no recorded run exercised it (info: may just be an untested path) |
| `no-import` | A → B is declared or observed across modules of the same language, but A's module never imports B's, no other module imports both, A's module imports none that imports B's, and static analysis didn't find the call |
| `wired` | A → B crosses modules without an import, but the call is plausibly indirect. Some module imports both (a composition root: dependency injection, a plugin registry, an `app.py` that assembles the parts). Or A's module imports one that imports B's (a typed container: a handler given a `Services` whose attributes are typed with B's class). Or static analysis resolved the call through the types A's code names (the chain of imports is named). Info |
| `unknown-node` | a span, an edge or a flow's `entry` names a node nobody declared (an edge's missing end becomes a stub node, drawn dashed, "declared nowhere") |
| `orphan` | a declared node has no edges at all |
| `tour-unresolved` | a [tour](#tours) no longer matches the code or the recorded runs: a symbol, file, line range, node, focus string or span it names can't be found, a flow it's bound to wasn't recorded, or a node's captured code differs from the file now |
| `tour-invalid` | a tour file is malformed (not JSON; no id, title or steps; a step with no id or title) or a `--tours` glob matches nothing |
| `directive-invalid` | a `karyo:` directive is malformed: an unknown verb or key (with a "did you mean"), a bad id, kind or value, a missing `id=`, a `node` / `span` directive with no def or class right under it, a `span` naming a node nobody declares, or a node declared twice. The directive is ignored, and the SDK scan prints the warning too, so a typo never passes silently |
| `category-conflict` | two declarations of the same node give different `category` values; the richest declaration's is kept (the same whatever the fragment order) |
| `name-variant` | two spellings of one tag or category (`Hot-Path`, `hot path`): the legend would show two entries |
| `edge-kind` | an edge with a kind the format doesn't have (`kind=call`); read as `calls` |
| `coverage` | info: after a recording that watched whole packages, how many nodes and relationships in them ran, and how many never did (not exercised) |
| `monitor-capped` | info: the sys.monitoring recorder kept only its first calls as spans (`KARYO_MAX_SPANS`); the rest are counted on their relationships, so coverage is still complete |
| `curation-unresolved` | a [curation](#curation) entry names a node the model doesn't have (a rename in the code, usually); with a did-you-mean. Never silently ignored: the next refresh fixes it |
| `curation-invalid` | a curation file (or one of its entries) is malformed, or asks to fold a node that has no parent; that part is skipped |
| `curation-kept` | info: the curation hides a node a recorded run reached; it is kept, so no recorded call goes missing |
| `id-conflict` | **error**: two things claim one id (ids that differ only in case or punctuation, a node named like a module, a relationship ending at a module) |
| `invariant` | **error**: the engine broke its own rules ([Identity](#identity)); a bug to report |

## Format (version 1)

One JSON document. Fragments from each language use the same shape and are merged by node id. Schema: [`spec/karyo-model.schema.json`](../spec/karyo-model.schema.json).

```jsonc
{
  "karyo": 1,
  "project": "orders",
  "producers": [{ "name": "karyo-py", "lang": "python", "version": "0.1.0", "at": "2030-04-28T22:10:00Z" }],
  "nodes": [
    {
      "id": "orders.api.checkout",          // stable, dotted; the join key across languages
      "kind": "service",                    // service | function | type | store | queue | external | actor | module
      "label": "Checkout API",
      "summary": "Validates the cart and takes payment.",
      "group": "orders",                    // drawn as a frame around its members (default: top-level package)
      "category": "api",                    // optional: one declared word views can color or filter by
      "tags": ["hot-path"],                 // optional: declared free-form labels
      "module": "orders.api",               // code module/package containing it (for import checks)
      "lang": "python",
      "ref": { "file": "orders/api.py", "line": 14, "symbol": "checkout" },
      "code": { "file": "orders/api.py", "start": 12, "end": 31, "lang": "python", "text": "# karyo:node id=orders.api.checkout kind=service …\ndef checkout(cart):\n    …" },
      "sources": ["declared", "observed"]
      // optional: "parent": "orders.db.Store" (the node it is part of), "fold": true (drawn folded into it),
      //           "exercised": true | false (set after a recording that watched it in full: did it run)
    }
  ],
  "edges": [
    { "from": "orders.api.checkout", "to": "payments.charge", "kind": "calls", "label": "POST /charge", "sources": ["declared", "observed"], "count": 1 },
    { "from": "orders.inventory.reserve", "to": "orders.db.stock", "kind": "reads", "kinds": ["reads", "writes"], "sources": ["declared", "observed"], "count": 2 }
    // kind: calls | reads | writes | publishes | subscribes | imports (module → module)
    // one edge per ordered pair: `kinds` (only when several) lists them all, `kind` is the first
  ],
  "flows": [
    {
      "id": "checkout",                     // flow name given where the trace starts
      "title": "A checkout request",
      "trace": "4f1c…",                     // spans from every process with this trace id belong here
      "entry": "user",                      // optional actor node the first call comes from
      "spans": [
        { "id": "a1", "parent": null, "node": "orders.api.checkout", "label": "checkout(cart)", "start": 1790000000000000000, "end": 1790000000031000000, "status": "ok", "lang": "python" },
        { "id": "b7", "parent": "a1", "node": "payments.charge", "label": "charge 42.00", "start": 1790000000012000000, "end": 1790000000029000000, "status": "ok", "lang": "go" }
      ]
    }
  ],
  "groups": [ { "id": "storage", "label": "Storage", "parent": "core" } ],   // optional: from a curation file
  "coverage": [ { "scope": ["orders"], "by": "karyo-py monitor", "sample": 0.01 } ],   // optional: what recordings watched in full
  "checks": [ { "level": "warn", "code": "undeclared-call", "message": "…", "subject": "orders.api.checkout->orders.db.write" } ],
  "tours": [ /* resolved tours, see Tours below */ ]
}
```

- **Version key.** `"karyo": 1` marks format version 1.
- **Spans, not edges, are recorded.** A span is one call of one node. Its caller is the parent span's node, or the flow's `entry` for a root span. Observed edges are derived from spans at merge time.
- **Times** are Unix nanoseconds, so spans from different processes line up.
- **Cross-process traces:** a process that starts a child passes `KARYO_TRACE` and `KARYO_PARENT` in the child's environment (the SDKs do this for you with `span.env()` / `model.Env(ctx)`). For requests, send them as `karyo-trace` / `karyo-parent` (and optionally `karyo-flow`) keys: HTTP headers, or any other request metadata (an RPC's metadata, an MCP request's `_meta`), which works the same way. The merge joins spans by trace id, so one flow can cross Python → Go → Python.
- **Category and tags are declared.** `category` is one word per node (`api`, `store`, `stage`, …; keep a project to a handful) that views can color or filter by; `tags` are free-form labels (`hot-path`, `on-every-request`). Both come from `category=` / `tags=` in a directive (Python or Go) or the decorator. The merge takes the union of tags and keeps the richest declaration's category; a different category for the same node is a `category-conflict` warning, and two spellings of one tag or category a `name-variant` warning.
- **Checks travel too.** A fragment may carry `checks` (the SDK scan's `directive-invalid` warnings); the merge keeps them next to its own, and `check` keeps them when it reconciles a built model again.
- **Code travels with the node.** `code` is the declaration's source, read from the code itself: Python from the `# karyo:node` directive line through the end of the `def` or `class` (decorators included; the scan with `tokenize` + `ast`, the recorder the same way at import time; the decorator form: from the first decorator, at runtime with `inspect`), Go from `//karyo:node` (the scan, the doc comment through the end of the func or type). `text` is lines `start`..`end` of `file`, verbatim (indentation kept, `file` relative to the root). It's capped at 80 lines: a longer declaration keeps its first 80, `truncated: true`, and `end` is the last line kept. `external()`, `edge()` and extracted modules have no code. When two fragments carry code for the same node, the merge keeps the longer one.
- **Edges are relationships, one per ordered pair** (see [Identity](#identity)). `count` is how many recorded calls were attributed to it.
- **Node ids are the contract.** Keep them stable and dotted. The same id declared in two languages is the same node (e.g. Python declares `payments.charge` as `external`, Go declares it as a `service` with a file ref: the merge keeps the richer declaration).

## Identity

One real relationship is one thing everywhere. The rule lives in `src/model/model.ts` and nothing else builds a key from an id: merge, reconcile, `checksFor`, tours and every view (map, flow replay, structure board, trace board, tour diagrams) go through it.

- **A node is its id**, exactly: the same id from any language, source or record is one node. Ids match `^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$`. Two ids that differ only in case or punctuation (`orders.Store`, `orders.store`) are an `id-conflict` error, not two nodes. Module names (from the import scans) share the namespace: a node named like a module, or a relationship ending at a module, is an `id-conflict` too.
- **A relationship is its ordered pair** `from → to` (`pairKey`: `"from->to"`, also every pair check's `subject`). Whatever kinds the code declares for a pair (A `reads` and `writes` B; A `calls` and `reads` B), they are one edge carrying all of them (`kinds`), with their sources, labels and counts added up. Views draw one wire per pair. `imports` edges (module → module) are a separate layer, keyed by pair too, and never fold into a relationship.
- **A recorded call confirms a relationship, not a kind** (`attributeCall`). A run only ever sees calls, so a call A → B confirms the pair's declared relationship whatever its kinds; `calls` is added only when nothing was declared. A call from a queue to its subscriber (B → A) confirms a declared `A subscribes B`. The flow replay and trace board walk spans with the same function, so a hop always travels the wire it was counted on.
- **A verdict per relationship** (`verdict`): `confirmed` (declared or extracted, seen), `unseen` (declared, not seen: dashed), `extracted` (static analysis found it in the code, nobody declared it, not seen: dashed), `unexercised` (declared or extracted, and a recording that watched both ends in full never saw it: `exercised: false`, drawn dotted and faint, the `idle` style), `undeclared` (seen, neither declared nor extracted: the warning colour, and the `undeclared-call` check), `entry` (an actor calling in, seen: solid, no warning). A static call, like a recorded one, confirms a pair's declared kinds instead of adding `calls` (A declared as `writes` B, and the code calls B: one relationship, `writes`, declared + extracted). Views take style and wording from it; reconcile takes its checks from it, and `proposed` (only a [splice](#splices) says so: `wireStyle` gives it its own style, `'proposed'`, never mistaken for code).
- **`proposed` is a fourth source**, for [splices](#splices) only: a node or relationship whose one source is `proposed` (`isProposed`) is an intention, not code. `reconcile` never checks it for drift (no `unknown-node`, `orphan`, `no-import` or `name-variant` for it), and `invariants` accept it under the same identity rules, plus three of its own: a proposal is never mixed with real sources, never recorded (no span of a proposed node, no `count`) and never an import or a module.
- **Order doesn't matter.** Fragments merge to the same model (up to array order) in any order: node records fold richest first with ties broken by content, flows are named by start time (`run`, `run#2`).
- **Invariants** (`invariants`) run at the end of every merge and in `check`: one edge per identity, every edge end and span node is a node, `exercised` (when set) says what the sources say (`observed` or not), every recorded call has an observed relationship with a count covering it, flow and span ids unique, and every node nobody declared has an `unknown-node` check. A violation is a level `error` check (`invariant`, or `id-conflict`), printed first; `build` and `check` exit 1 on any error, with or without `--strict`. Warnings are drift between code and docs, which the picture shows honestly; an error means the picture itself would be wrong.
- **A model that repeats a pair** (a declared `reads` and an observed `calls` as two edges) is read as one edge (`normalize`): the views and `check` fold them, and `check` notes it (`normalized`). Rebuild to rewrite the file.

Tests: `tests/model.test.ts`.

## Automatic mode

A codebase can be drawn with no annotations at all. The scan makes every module, class and public function a node (ids are stable and derived from the code: `module.qualname`), its package the group, its code and ref as for a declared node, and adds the **static call graph** as `extracted` relationships (kind `calls`; imports stay the separate `imports` layer). **Directives add meaning on top of it:** a directive on a def refines that def's automatic node. It doesn't add a second one: what the directive says wins (id, label, kind, category, tags), what it doesn't say stays automatic (kind, label, group, the type a method folds into), and its `calls=` are declared relationships next to the extracted ones (to an external, say). Without `id=` the node keeps its automatic id, so curation, tours and recordings keep naming it. The model format is the same for any language; what a language's scan can resolve is up to its SDK (Python's: [below](#automatic-mode-in-python)).

### Fold

A board of every function would be unreadable, so the model says what is drawn as its own card:

- **`parent`** is the node a node is part of (a method's type), and **`fold: true`** draws it folded into that parent. Automatic mode folds methods into their type; a [curation file](#curation) unfolds (`top`) or folds nodes.
- **The fold view** (`foldView` in `src/model/model.ts`, what the structure board draws): every folded node is drawn as its nearest unfolded ancestor. Its relationships and recorded calls roll up onto that card (one wire per pair as always, counts and sources added up, a folded call inside its own type's call collapsed into it), its checks move with it, and the card's details list what it folds (`parts`). The folded view is a valid model: the invariants hold (property-tested in `tests/auto.test.ts`).

### Coverage

A recording that watches every call inside some packages (Python's sys.monitoring recorder) says so in its fragment (`coverage: [{ scope, by, sample? }]`, scopes being module, package or id prefixes). The merge then marks, for everything in scope that a recording can see run (functions, services, stores, queues; not types, which may be constructed by code that isn't their own, and not modules, externals or actors), whether it ran: `exercised: true | false` on nodes, and on relationships between two such nodes. `exercised: false` is **not exercised**: in the code, and the recorded runs that watched it never ran it. Without coverage nothing is marked, and the words stay "not seen in a recorded run", since a run that didn't watch everything can't say what didn't happen.

- Views: a not-exercised relationship is drawn dotted and faint (`idle`), the wire card says "not exercised: recorded runs that watched both ends never made this call", a not-exercised card has a dotted border, and the legend has **not exercised** (cards whose code never ran) and **partly exercised** (cards that ran but fold parts that never did, e.g. a type some of whose methods ran). The wire legend adds "not exercised by the recorded runs" (with "(sampled)" when only a share of flows was recorded).
- The fold view combines marks: a card ran if any of its parts ran, and is not exercised only if every part a recording could see is; a rolled-up relationship is not exercised only if every relationship it rolls up is (one that nobody could watch, like constructing a type, leaves it unmarked).
- `reconcile` adds one `coverage` note with the numbers: how many nodes and relationships in scope ran, and how many never did.

### Curation

A curation file (`karyo/curation.json` next to the model; schema [`spec/karyo-curation.schema.json`](../spec/karyo-curation.schema.json)) says what matters and how it's grouped, without touching the code. It is what people, or Claude, write on top of automatic mode. It refers to nodes by their stable ids; a selector may use `*` for any run of characters (`orders.db.*`, `*Store`).

```jsonc
{ "karyo": "curation/1", "note": "optional prose",
  "top":  ["orders.api.Router.__call__"],                     // drawn as their own cards (wins over fold)
  "fold": ["orders.util.*"],                                   // drawn folded into their parent
  "hide": ["tests.*", "orders.models.clock.Moment"],           // left out, with their relationships
  "groups": { "stages": { "label": "Stages", "parent": "fulfilment", "members": ["orders.fulfilment.stages*"] } },
  "nodes": { "orders.db.OrderStore": { "label": "Orders store", "category": "store", "tags": ["state"] } } }
```

- `bun scripts/model.ts build … --curation <file>` applies it after the merge and before reconciling (without the flag, `karyo/curation.json` under `--root` is used when it exists; `--no-curation` skips it). Node fields first (label, summary, kind, category, tags added to the code's, group), then groups (members move in; labels and nesting go into `model.groups`, and views label a nested group `Parent / Child`), then `fold` and `top`, then `hide`.
- **Unresolved is never silent.** An entry that matches nothing is a `curation-unresolved` warning with a did-you-mean, so a refresh can fix it; a malformed entry is `curation-invalid` and skipped (a wrong version skips the whole file). `check` keeps these.
- **Hiding never loses a recorded call.** A hidden node a recorded run reached is kept, with a `curation-kept` note. There is one exception: a type whose recorded calls are all constructions that called nothing recorded (a record, a reply or an exception built along the way). Hiding it takes those construction spans out of the flows with it (a flow left empty goes), and no other call is lost.
- The curation wins over the code for what it says (a directive's label, say); `check` re-reconciles the curated model.
- `"start": "groups" | "cards"` says what a structure board starts on (docs/ENGINE.md "Group navigation"): one card per group, entered level by level, or every card; it goes into the model as `start`. Without it a big board starts on its groups.
- API (`src/model/curation.ts`, pure): `applyCuration(model, curation, file?)` → checks (the model is changed in place), `validateCuration(json)`, `selector(pattern)`, `groupLabel(model, groupId)`.

## SDKs

### Python (`sdk/python/karyo`)

**The rule: Karyo is inert in production.** The preferred way is zero footprint: the app declares itself in comments (or not at all, [automatic mode](#automatic-mode-in-python)) and never imports `karyo`, which is then a dev dependency only (`[dependency-groups] dev`). But production code *may* import karyo's public API, because it does nothing unless recording is turned on:

- `import karyo` costs well under a millisecond (about 0.4 ms warm, 6 ms cold): everything heavy (`inspect`, `json`, the recorders, the scan) is imported only where it's used;
- `@karyo.node(...)` returns what it decorates, itself (`is`), with no wrapper and no bookkeeping, and `karyo.external()` / `karyo.edge()` register nothing;
- no `sys.monitoring` tool is registered, no import hook installed, nothing recorded or written;
- `karyo.watch("pkg")` returns `False` at once, unless `KARYO_RECORD` is set in the environment: `1` records every flow, `0.01` samples one flow in a hundred (a flow is one top-level call into the package from outside it: a request, a test).

`sdk/python/tests/test_inert.py` measures this (the import budget, no wrappers, no monitoring tool), and `python -m karyo check-prod <package-dir>` enforces it (below).

#### Directives

Same grammar as Go. A directive is a full-line comment; `node` and `span` go on the line(s) directly above a `def` or `class` (above its decorators, if any; other comment lines may sit between, a blank line may not). `external` and `edge` can go anywhere. A comment line of the form `#   key=value …` (`#`, then three or more spaces) continues the directive above it. Values are bare words or `"double-quoted"`; lists are comma-separated, and a list key may repeat (its values add up).

```python
# karyo:node id=orders.api kind=service label="Orders API" group=orders category=api
#   tags=hot-path,touches-store calls=orders.store,orders.pricing
class OrdersApi(Service): ...

# karyo:node id=orders.normalize label=Normalize group=orders category=stage
def normalize(cart: Cart) -> int: ...

class OrderStore:
    # karyo:span node=orders.store label=create
    def create(self, customer: str) -> Order: ...

# karyo:external id=web-app kind=actor label="Web app" category=outside
# karyo:edge from=web-app to=orders.api kind=calls label="HTTPS"
```

| directive | keys | on | while recording |
|---|---|---|---|
| `karyo:node` | `id` (required, except where the reader knows the module, as the scan and the recorders do: then it defaults to the def's automatic id, `module.qualname`), `kind`, `label` (default: the def's name), `summary` (default: the docstring's first line), `group` (default: top-level package), `category`, `tags`, `calls`, `reads`, `writes`, `publishes`, `record=false` | a `def` or `class` | a function or method: every call is a span of the node, labeled `name()` (unless `record=false`). A class declares the node and is marked with it (`__karyo_node__`); its methods are wrapped only when they carry a directive of their own |
| `karyo:span` | `node` (required: a declared node id), `label` (default `name()`) | a `def` | every call of this function is a span of that node: a store's operations (`create`, `get`, `close`), a client's request methods |
| `karyo:external` | `id` (required), `kind` (default `external`), `label`, `summary`, `group`, `category`, `tags` | anywhere | declared once |
| `karyo:edge` | `from`, `to` (required), `kind` (default `calls`), `label` | anywhere | declared once; the `label` is what the wire says when you hover it (docs/ENGINE.md "Wire hover"), in place of the sentence generated from its kinds and recorded operations |

Kinds are the model's (`service`, `function`, `store`, `queue`, `external`, `actor`, `module`; edges `calls`, `reads`, `writes`, `publishes`, `subscribes`). Directives are read with `tokenize` (only real comments, never text in a string) and `ast` (which def or class follows). Anything malformed is a `directive-invalid` warning with the file and line, and the directive is ignored.

#### Scan

`python -m karyo scan <package-dir> -o .karyo/python.static.karyo.json [--root DIR] [--auto | --no-auto]` names modules as Python imports them (a scanned subpackage from its topmost package; a `src/` folder of packages as a path root), so they match the recorder's. It reads the directives (and the decorator form, below) plus the import edges between the package's modules, without importing or running anything, and prints any `directive-invalid` warnings. **Automatic mode** (`--auto`) adds the automatic nodes and the static call graph (next), with the directives refining the nodes of the defs they sit on; `--no-auto` reads directives only. Given neither, the SDK uses automatic mode when no scanned module has a `# karyo:` directive or `@karyo.node`. A project set up by `karyo init` says which in `karyo/config.json` (`"mode": "auto"`, the default, or `"directives"`; docs/ADOPT.md "Modes"), and `karyo refresh` / `karyo record` pass it.

#### Automatic mode in Python

`karyo/auto.py`, with `ast` (nothing is imported or run). **Nodes:** every class (kind `type`) and every public function and method (kind `function`); id `module.qualname` (`orders.api.checkout`, `orders.db.Store.get`), label the qualname, group the module's package, the docstring's first line as summary, code and ref as for a directive; a method's `parent` is its class, and it is folded into it. Two ids that would clash are kept apart: a function named like a module (`foo` in `pkg/__init__.py` next to `pkg/foo.py`), or ids that differ only in case (`stages.Chunk` the class, `stages.chunk` the function), are written `module:qualname` (the later-defined one, for case). Which code counts as which node is one rule, shared with the recorder so the two agree:

- a class, a module-level function, and a method (or `__call__`) of a class that is a node, whose name has no leading `_`, is a node;
- `__init__`, `__new__` and `__post_init__` are the class: constructing it is a call of the class node, and their calls are the class's;
- a def with `# karyo:node` (or `@karyo.node`) is that node, the automatic one refined (`auto.refine`: without `id=` it keeps the automatic id; what the declaration doesn't say stays automatic, a method keeping its type as `parent`, folded); a def with `# karyo:span node=X` is part of X;
- everything else (private helpers, other dunders, properties, overloads, nested functions, lambdas) is **transparent**: a private helper's calls are its caller's (statically they are inlined into every caller; at run time its frame is skipped), and a nested function's or lambda's are its enclosing node's.

**The static call graph** resolves only what it can resolve soundly, and never guesses an edge:

| resolved | how |
|---|---|
| a module-level function or class | its name in the module, `import m` / `import a.b as m` then `m.f`, `from m import f as g`, relative imports, module-level aliases (`g = f`), star imports from the project |
| class instantiation | `C(...)` is a call of `C` (its `__init__` is `C`) |
| `self.method()` | the method in the class, or inherited: the class hierarchy is resolved through imports and linearized (C3); `cls.method()` in a classmethod; `super().method()` |
| attributes and variables of a known type | a parameter annotation (`store: OrderStore`, `Optional[…]`, `X \| None`, a string annotation), a variable annotation, `x = Store(...)` assigned once, an instance attribute from `self.x = Store(...)` (every assignment in the class's methods agreeing) or a class-level annotation (dataclass fields), a function's return annotation |
| `obj()` | the type's `__call__` |

**Its limits** (the dynamic gaps the recorder fills): calls through `getattr`, registries, lists of functions (`for s in STAGES: s(x)`), callbacks and decorators that replace a function are not edges; a variable assigned two different things, or a parameter shadowing a global, isn't resolved; a method lookup stops at a base class the scan can't see (it could override the method), except bases known not to (`object`, `abc.ABC`, `typing.Generic`, `Protocol`, `NamedTuple`, `TypedDict`, `Enum`, the built-in exceptions); a nested function's calls count as its enclosing function's even when it's handed off as a callback; calls made at module level (import time) belong to no node. An override in a subclass is not an edge from a base-class caller (the static edge goes to the method the base's MRO finds; the run shows the override as "seen, not in the code").

#### Record

```sh
python -m karyo record [--out .karyo] [--root .] [--hooks karyo_hooks.py] [--package orders] [--project name]
                       [--monitor | --no-monitor] [--sample 0.01] [--auto | --no-auto] -- <command …>
```

With **`--monitor`** (the default with `--auto`, or for a project with no directives; Python 3.12+; `karyo record` always passes it, with the project's mode) every Python process of the command records with `sys.monitoring` (next); otherwise, and on older Pythons, with the import-time instrumenter (below the next section). `--sample 0.01` records one flow in a hundred. Either way it runs the command with recording on: `KARYO_RECORD=1` (or the sampling rate), `KARYO_MONITOR`, `KARYO_OUT`, `KARYO_ROOT`, `KARYO_PACKAGES`, `KARYO_HOOKS`, `KARYO_PROJECT`, and `PYTHONPATH` prepended with `karyo/_boot`, whose `sitecustomize.py` (it runs any other `sitecustomize` first) starts the recorder in every Python process of the command. Child processes inherit the environment, so a server the command launches over stdio is recorded too. On POSIX the command replaces the `record` process (a client that launched it manages the real server). In each process the recorder

- instruments the listed packages as they are imported: their directives are parsed, the declared nodes and edges registered, and each marked `def` gets one decorator added to its AST before it's compiled, so it's wrapped at definition time (a list built at import time, like `STAGES = [normalize, chunk, …]`, holds the recorded functions). Instrumented bytecode is never cached, so a later normal run can't pick it up;
- loads the hooks file and calls its `setup(karyo)`;
- hands trace context to every child process started inside a flow (`KARYO_TRACE` / `KARYO_PARENT` added to its environment), so a Go or Python child joins the trace with no code in the app;
- writes its fragment at exit (atexit) to `$KARYO_OUT/python-<pid>.karyo.json`.

Tests can do the same in process: `karyo.instrument(["orders"], hooks="karyo_hooks.py")` before anything imports the app.

#### The sys.monitoring recorder

`karyo/_monitor.py` (PEP 669). Nothing is wrapped or rewritten: a monitoring tool gets `PY_START` when a function starts and `PY_RETURN` / `PY_UNWIND` when it ends.

- **Classified once, disabled if it isn't a node.** The first time a code object starts, it is classified with the scan's rule above (the module's file is parsed once; `code.co_qualname` and `co_firstlineno` name the def). Code outside the watched packages (the standard library, installed packages), code generated at run time other than a node's constructor (a dataclass's `__eq__`), and code that isn't a node (a private helper) returns `sys.monitoring.DISABLE`: that code object never calls back again, so library code costs nothing after its first call. A node's code gets `PY_RETURN` and `CALL` turned on for it alone (`set_local_events`; CALL for constructions, below). `PY_UNWIND` (a call ending in an exception, recorded as `status: error`) is the only global event.
- **Constructions.** Constructing a class that is a node is a call of it, whatever runs it. Its own `__init__` (or `__new__`, `__post_init__`), hand-written or generated at run time (a dataclass's: `co_filename` `"<string>"`, classified by the class whose code it is, read from the receiver), starts as the class node. A class whose construction runs no project code (no `__init__` of its own: `object`'s, an exception's, a library base's) is caught where node code constructs it. The CALL event is on only in node code, and returns `DISABLE` at every call site after its first call unless that site constructs such a class; each such construction is a zero-length span. A class with no `__init__` of its own that is built only from outside the watched code (a test calling it directly) is not seen.
- **The caller** of a node call is the nearest node frame below it on the stack (transparent frames skipped), else the node running in the same asyncio task (a context variable), else none: a root call. Generators and coroutines are timed from their start to their final return. An inherited `__init__` records the class being constructed (`type(self)`), not the base.
- **Flows.** A root call made from outside the watched code starts an automatic flow, named after that caller (a test function, a request handler, a script), with the code that called it in the title (`call ← test_rate_limit`); other root calls from the same caller frame join it. Inside an explicit `karyo.flow(…)` they join that flow instead, and hooks, `karyo.context()` and child processes work as with the other recorder.
- **Sampling** (`KARYO_RECORD=0.01`, `--sample`): the flow is the unit, so a sampled flow is recorded whole; a flow left out costs one callback per node call.
- **Caps.** Calls are kept as spans (a flow replay's material) up to `KARYO_MAX_SPANS` per process (default 20000) and `KARYO_MAX_FLOW_SPANS` per flow (5000); past them a call is only counted, on its relationship (an observed edge with a `count`), and a `monitor-capped` note says how many. Every node that ran is listed in the fragment, so coverage stays complete.
- **Output**: the fragment at exit, with a `coverage` entry (the packages watched, the sampling rate), which is what lets the model mark code in them that never ran as [not exercised](#coverage).
- **Three ways to turn it on**: `python -m karyo record --monitor -- pytest` (dev); `karyo.watch("pkg")` in app code, inert unless `KARYO_RECORD` is set (so production can sample: `KARYO_RECORD=0.01`); `KARYO_MONITOR=0` forces the import-time recorder, which is also what `watch()` uses on Python < 3.12.

**What it costs** (measured on an Apple-silicon Mac, Python 3.14, tiny functions, so the overhead is all there is): off, nothing (no tool registered; a node call is the plain call, about 20 ns). Recording, about 1 µs per node call inside a flow; about 5 µs more per new flow (a two-call request: 0.1 µs off, 5.4 µs on); a flow the sampling leaves out, about 0.35 µs per node call (about 2 µs per tiny request). Library code costs nothing after its first call: a node calling ten pure-Python library functions costs 6.7 µs per call recording with `DISABLE`, 18 µs without it (about 1.1 µs per library call saved). Recording constructions costs nothing on calls that aren't constructions (a call site is disabled after its first call) and about 0.65 µs for each one recorded. Tests: `sdk/python/tests/test_monitor.py`.

#### Hooks (`karyo_hooks.py`)

Directives say what a function is. Boundary code, the part comments can't say, goes in a hooks file at the project root: dev only, loaded by the recorder, never imported by the app. It exposes `setup(karyo)`:

```python
def setup(karyo):
    @karyo.on_import("orders.web.middleware")          # right after that module is imported
    def continue_the_trace(middleware):
        handle = middleware.Tracing.__call__
        async def __call__(self, request, call_next):
            t = karyo.context_from(request.headers)     # {trace, parent, flow} from the request's headers
            with contextlib.ExitStack() as stack:
                if t["trace"]:
                    stack.enter_context(karyo.flow(t["flow"] or request.path, trace=t["trace"], parent=t["parent"]))
                stack.enter_context(karyo.span("orders.api", label=request.path))
                return await handle(self, request, call_next)
        middleware.Tracing.__call__ = __call__

    @karyo.on_import("orders.plugins.registry")
    def span_each_handler(registry):                   # dynamic dispatch: each handler is a span of its plugin's node
        traced = registry.traced
        registry.traced = lambda name, fn: karyo.wrap(traced(name, fn), karyo.node_of(fn), label=name)
```

For hooks: `karyo.on_import(module)`, `karyo.wrap(fn, node_id, label=None)` (plain, async, generator and async-generator functions; the signature is kept), `karyo.node_of(obj)` (the node a directive gave a function, a class or a bound method's class), plus `span`, `flow`, `context_from`, `context` and `current`.

#### Drivers

A script that starts flows (a recorder that plays the client, a test) is dev code and imports `karyo` directly:

```python
with karyo.flow("checkout", title="A checkout", entry="web-app"):
    await client.post("/checkout", json=cart, headers=karyo.context())   # or an RPC's metadata
karyo.write()                              # → $KARYO_OUT/python-<pid>.karyo.json (default .karyo/)
```

`karyo.context()` returns `karyo-trace`, `karyo-parent` (the current span) and `karyo-flow` (the flow's name), or `{}` outside a flow. `karyo.context_from()` accepts any mapping, with keys in any case. `flow(trace=, parent=)` continues the given trace; without them a flow continues `KARYO_TRACE` from the environment, or starts a new one. Outside a flow `span` records nothing and costs one context-variable read.

#### The decorator form

`@karyo.node(id, kind=…, label=…, category=…, tags=[…], calls=[…], …)`, `karyo.external(...)` and `karyo.edge(...)` work too and the scan reads them, but they make the app import karyo. Outside a recording `@karyo.node` returns what it decorates unchanged (no wrapper, no bookkeeping) and `external` / `edge` do nothing; inside one (`karyo.recording()`) they register the node and wrap like a directive. Prefer directives, or automatic mode.

#### Check the production rule

`python -m karyo check-prod <package-dir> [--allow karyo_hooks.py,scripts,tests] [--strict]` checks that karyo is **inert** in the app, and exits 1 listing `file:line` for each problem:

- app code may import karyo's public inert API (`node`, `external`, `edge`, `watch`, `recording`, `span`, `context`, `context_from`, `current`, `node_of`, `check`);
- it fails on imports of recorder internals (`karyo._record`, `karyo._monitor`, `from karyo import _monitor`, `karyo.auto`, …);
- on recording APIs called unconditionally (`instrument`, `flow`, `write`, `fragment`, `reset`, `on_import`, `wrap`: they start recording or keep flows in memory), unless inside `if karyo.recording():` or a test of `KARYO_RECORD`;
- on app code that sets `KARYO_RECORD` to anything but off, and on deployment config that does (`.env` files, Dockerfiles, compose files, Procfiles, systemd units, `app.yaml`, `fly.toml`, shell scripts, in the package or the project folder next to it; `--allow` a file if sampling in production is intended);
- and when the app imports karyo unconditionally but the `pyproject.toml` next to it doesn't list it in `[project] dependencies` (a production install would fail to import it; an `import karyo` inside `try: … except ImportError` is fine).

`--strict` is the zero-footprint rule: any karyo import (`import karyo`, `from karyo …`, `__import__("karyo")`, `importlib.import_module("karyo")`) fails, and so does karyo in `[project] dependencies`. `--allow` names files or directories exempt from both (default: `karyo_hooks.py,scripts,tests`).

**Installing the SDK editable** (a `uv` path source) gives a plain path entry (`package-dir` in `sdk/python/pyproject.toml`), not setuptools' import finder: a project folder named `karyo/` (where splices are saved) would otherwise shadow the package as a namespace package whenever Python runs from that project's root. `tests/test_inert.py` checks it.

### Go (`sdk/go`, module `karyo.dev/model`)

```go
//karyo:node id=payments.charge kind=service label="Charge card" category=api tags=money calls=payments.fraud,payments.ledger
func Charge(ctx context.Context, amount int) error {
    ctx, end := model.Span(ctx, "payments.charge", "charge")
    defer func() { end(err) }()
    ...
}

func main() {
    ctx := model.Flow(context.Background(), "charge", "A card charge") // continues KARYO_TRACE if set
    defer model.Write()                                                // → $KARYO_OUT/go-<pid>.karyo.json
}
```

Static scan: `go run karyo.dev/model/cmd/karyo-scan ./... > .karyo/go.static.karyo.json` (directives parsed with `go/parser`; imports from `go list -json`). Keys: `id`, `kind`, `label`, `summary`, `group`, `category`, `tags`, `calls`, `reads`, `writes`, `publishes` (`external`: the node keys without edges; `edge`: `from`, `to`, `kind`, `label`). The grammar is Python's: `//   key=value` continues a directive, list keys may repeat, `// karyo:` works too. A malformed directive (an unknown directive, key, node or edge kind, a bad or missing id, a key given twice) is a `directive-invalid` warning and is ignored, as in Python; so is a node declared twice or named like a package. Go spans are explicit (`model.Span`); a Go process joins a trace through `KARYO_TRACE` / `KARYO_PARENT`, which a recorded Python parent passes to it automatically.

### Comment markers: Swift and other `//` languages (`src/cli/markers.ts`)

A language with no SDK declares itself with the same directives as Go, in `// karyo:` (or `//karyo:`) comments:

```swift
/// Where the app gets notes: the local cache first, the server when it must.
// karyo:node id=notes.repository kind=service label="Note repository" category=service
//   calls=notes.cache,notes.api
struct NoteRepository { … }

// karyo:external id=ext.keychain label="Keychain" category=outside
```

`karyo refresh` reads them in a Swift project (a `Package.swift`, `.xcodeproj` or `.xcworkspace`; docs/ADOPT.md)
into one fragment, `.karyo/markers.static.karyo.json` (source `declared`, `lang` from the file's language). Nothing
is compiled or run: each file is read line by line, telling code from comments and strings (a marker inside a string
or a block comment doesn't count). Verbs, keys, kinds and checks are Go's: a malformed marker is a `directive-invalid`
warning and is ignored; so is a node id declared twice (the first is kept). A `calls=` / `reads=` / `writes=` /
`publishes=` or `edge` end that no marker declares is a `directive-unknown-target` warning with a did-you-mean.
A `node` marker records the declaration directly below it (other comment lines and attribute lines such as
`@MainActor` may sit between, a blank line may not) when the language's pattern finds one: Swift's `class`, `struct`,
`enum`, `actor`, `protocol`, `extension`, `func`, `var`, `let`, `init`, `typealias`. Its name, qualified by the types
around it, is the node's `ref.symbol` and default label; its line the `ref.line`; the comment block above it through
its closing brace the node's `code`; the first `///` line its summary. A marker with no declaration under it is kept,
with a ref to the marker's own line. `module` is the Swift package target (`Sources/<Target>/…`), else the file's
folder; `group` defaults to the id's first segment. Markers are kept by hand (or by Claude): there is no automatic
mode for Swift, and no recording. Another `//` language (Kotlin, Objective-C, TypeScript …) is one more entry in the
scanner's language table: extensions, string delimiters, a declaration pattern.

## Build and view

```sh
bun scripts/model.ts build .karyo/*.karyo.json -o karyo.model.json   # merge + reconcile, prints warnings
bun scripts/model.ts check karyo.model.json                          # reconcile again, check the invariants, print the report
```

`just check <model.json>` does the same. `just sdk-test` runs the Python SDK's own tests (directives, automatic mode and the static call graph, both recorders, inertness and its benchmark, check-prod). `build --curation <file>` applies a [curation file](#curation) (default: `karyo/curation.json` under `--root`, when there is one). `build --tours 'tours/*.tour.json' --root <dir>` also resolves tours (below) into the model; `check` keeps the tour checks from the build.

Then the Karyo scenes: `mapScene(model)` (structure: groups, nodes, edges by source, warning badges) and `flowScene(model, 'checkout')` (a recorded flow replayed hop by hop with real durations in a step list). A scene file default-exports one (`export default mapScene(model)`), or a page embeds one with `mount(el, flowScene(model, 'checkout'))`.

## Tours

A tour walks through a pipeline as a timeline: one step at a time, each with the code that runs, a small diagram, and how long it took in a recorded run. The prose is written by hand; everything else is **strict**: code is read from the source, nodes must exist in the model, timings come from recorded spans. `tours[]` in the model holds them, and the tour plate (`src/model/tour.ts`) draws them.

### Authored

One JSON file per tour, next to the code (e.g. `tours/first-order.tour.json`):

```jsonc
{ "id": "first-order", "title": "The first order, step by step", "summary": "…",
  "flow": "checkout",              // optional: a recorded flow the steps take their timings from
  "request": 1,                    // optional: scope every span lookup to request n (1-based root span) of the flow
  "steps": [
    { "id": "start", "title": "Open an order",
      "text": "Prose: paragraphs, `code`, **bold**.",          // freeform
      "node": "orders.api",                                    // a model node
      "code": { "symbol": "OrdersApi.start" },                // see below; omitted = the node's own code
      "focus": ["self.store.create"],                          // substrings: lines containing them are highlighted
      "show": ["orders.store"],                                // more nodes for the step's diagram
      "span": { "label": "POST /checkout" },                   // recorded spans that time the step
      "group": "…" },                                          // consecutive steps sharing a group are drawn as one bracket
    { "expand": "orders.pricing", "group": "pricing" }         // one step per declared callee
  ] }
```

**`code`**, all strict:

| form | excerpt |
|---|---|
| omitted | the node's own `code` (checked against the file; if the file changed since the scan, the current declaration is used and the drift is reported) |
| `{ "symbol": "Class.method" }` | the symbol, in the node's file |
| `{ "file": "orders/x.py", "symbol": "name" }` | the symbol, in that file |
| `{ "file": "orders/x.py", "lines": [a, b] }` | lines a to b |

Symbol lookup: Python finds `def name`, `async def name` or `class Name`, with its `# karyo:` directives (the comment block right above, from its topmost directive, as the SDK captures it), its decorators and its indented block; a dotted `Class.method` is the method inside that class. Go finds `func Name(`, a method `Type.Name` (`func (r *Type) Name(`) or `type Name`, with its leading comment, to the matching brace. Files are read relative to `--root`. Excerpts are capped at 80 lines like node code.

**`span`**: a selector `{ "label", "node", "request" }` or a list of them. Every given field must match; `request` is 1-based among the flow's requests (root spans; a bare construction at the root, a span of a type with nothing under it, isn't one). A `node` that is a type card matches its methods' spans too, and so does a step's own node. When a selector names only a label and several spans carry it (a request and the handler it calls share a name), the step's own node wins. Spans nested in another matched span are dropped, so nothing is counted twice. Timing is the sum of the matched durations, with how many spans matched.

**`expand`** is strict too: one step per **declared** `calls` edge of the node, in declared order. Each step's title is the callee's label, its text the callee's summary, its code the callee's code, its diagram the parent and the callee, and its timing the callee's spans under a span of the parent in the bound flow.

### Built

`bun scripts/model.ts build … --tours 'tours/*.tour.json' --root .` resolves every tour into `model.tours`:

```ts
interface BuiltTour { id: string; title: string; summary?: string; flow?: string; steps: BuiltStep[] }
interface BuiltStep {
  id: string; title: string; group?: string; text?: string; node?: string;
  show: string[];                       // the node, then `show` (unknown ids dropped, with a warning)
  code?: { file: string; start: number; end: number; lang: string; text: string; focus: number[] /* absolute lines */; symbol?: string; truncated?: boolean };
  timing?: { ms: number; label: string; status: 'ok' | 'error'; spans: number; attrs?: Record<string, unknown> };
  source: 'authored' | 'expanded';
}
```

**Type cards.** A step may name a type card (a type whose methods fold into it on the board). Its small diagram ("where it runs") draws the relationships between its cards (`stepWires` in `src/model/tours.ts`), each end going to the closest card that holds it (itself, else its parent). So two type cards are joined by the calls between their methods, and a method shown beside them keeps its own end.

Nothing in a tour can fail the build. A reference that no longer resolves drops that part of the step and adds a `tour-unresolved` warning naming the tour, the step and what's missing, so a renamed function or a changed recording shows up in the terminal the next time the model is built (`--strict` turns warnings into a failing exit code). Types and resolution: `src/model/model.ts`, `src/model/tours.ts`; tests: `tests/tours.test.ts` (`just test`).

## Splices

A **splice** is a what-if over any plate's real graph: proposed changes ("add a cache between checkout and the orders store", "put a validator right before billing", "remove the rate limiter") drawn in place and saved under a name, to reopen later. The model file is never edited: `applySplice` builds a new model from the real one and the splice, and the plate draws that. Nothing real is ever deleted from it, so every wire the plate drew is still there (a relationship the splice retires is a ghost) and every recorded call still lands on its relationship.

### File

One JSON file per splice, in the project that owns the model: `<project>/karyo/splices/<id>.splice.json` (e.g. `karyo/splices/caching.splice.json`). Schema: [`spec/karyo-splice.schema.json`](../spec/karyo-splice.schema.json).

```jsonc
{ "karyo": "splice/1", "id": "caching", "title": "Caching", "note": "optional prose",
  "base": { "model": "karyo.model.json", "commit": "<sha or null>", "scene": "orders-board" },
  "view": { "nav": "groups", "at": "orders", "path": ["Orders"], "drill": null, "open": null, "section": null, "cursor": null, "positions": {} },
  "created": "<iso>", "updated": "<iso>",
  "ops": [
    { "op": "add", "node": { "id": "splice.read-cache", "label": "Read cache", "kind": "store", "category": "store", "tags": [], "group": "core", "summary": "…" },
      "between": ["checkout.api", "orders.store"] },         // or "before": "X" | "after": "X" | "attach": { "to": "X", "dir": "out" | "in", "kind": "calls" } | none (a free node)
    { "op": "connect", "from": "a", "to": "b", "kind": "calls", "label": "…" },
    { "op": "disconnect", "from": "a", "to": "b" },
    { "op": "remove", "node": "X" },
    { "op": "rename", "node": "X", "label": "…" },
    { "op": "move", "node": "X", "group": "g" },
    { "op": "replace", "node": "X", "with": { "id": "splice.y", "label": "Y", "kind": "store" } },  // or "with": "<a node that exists>"
    { "op": "group", "group": { "id": "splice.notifications", "label": "Notifications", "parent": "orders" },
      "first": { "label": "Mailer" },                          // optional: its first card
      "attach": { "to": "orders.api", "dir": "in" } },         // optional: in = to → the group (an outlet of it), out = the group → to
    { "op": "rename", "group": "splice.notifications", "label": "Alerts" },   // rename and remove also take a group
    { "op": "remove", "group": "splice.notifications" }
  ] }
```

**The view a splice lives in.** `view` is where the splice was opened, and where it was last saved: the navigation level and group (`nav`: `groups` or `cards`; `at`: the group entered, null for the overview; `path`: the breadcrumb's group labels as they were, for words), the drill, the selection (`open`, `section`, `cursor`) and the splice's own arrangement (`positions`). A structure board writes these keys; other plates may write their own (the schema allows more). Reopening a splice restores the view: it slides into that group (a group the splice itself proposes counts) and reopens the card. A splice without a view, or one whose view doesn't say (an older splice), opens at the top level, as the board starts. The view is only where the user is: a splice's ops apply to the whole model, and moving to another group while in a splice stays in the splice.

**Cards with parts.** A board folds a type's methods into the type's card (see [Fold](#fold)), so its wire between two type cards stands for the relationships between their methods. An op that names such a card means what the board shows. `between` inserts into every relationship from a part of a to a part of b. `before` and `after` read the card's callers or callees from outside it, counted as cards. `disconnect` retires them all, and `connect` warns that the wire is already there. `remove` and `replace` take the card's parts with it. Ops that name methods work on those methods only. `landed()` and `describeOp` read cards the same way. `boardMarks(result)` adds a mark for each folded wire whose relationships are all proposed or all retired; the board and the Stack view draw with it. The core's `marks` stay keyed by the model's own relationships.

`id` is the file name's stem (the save endpoint refuses a mismatch). A node is named by its id (preferred) or its label (case, spacing, punctuation and a leading "the" ignored); a close spelling is never taken, only suggested.

### What the ops do

Ops apply in order; a later op may name a node an earlier one adds.

| op | effect |
|---|---|
| `add` … `between: [a, b]` | needs the relationship a → b (b → a is accepted, and its direction kept). a → b becomes a → new → b: both new relationships carry a → b's kinds, and a → b is marked `rerouted` |
| `add` … `before: X` | X with **one caller** c: c → X becomes c → new → X (c → X's kinds; c → X `rerouted`); no caller: just new → X. X with **several callers**: new is one more step that also calls X, just new → X (`calls`), nothing rerouted |
| `add` … `after: X` | X with **one outgoing relationship** X → d: X → new → d (X → d `rerouted`); none: just X → new. X that **fans out** to several: new is one more step X also calls, just X → new (`calls`), nothing rerouted |
| `add` … `attach: {to, dir, kind}` | one relationship: `out` new → to, `in` to → new; default `out`, `calls` |
| `add` (no placement) | a free node |
| `connect` | a proposed relationship (default `calls`). A pair that already exists is a warning (nothing to add); a real one an earlier op retired is restored instead |
| `disconnect` | the relationship is marked `removed` (a ghost) |
| `remove` | the node and all its relationships are marked `removed` (ghosts, never deleted) |
| `rename`, `move` | the node's label or group changes; marked `renamed` / `moved`. `move`'s group is an id or a label (a proposed group counts); a name no group has is a new group id, as before |
| `group` | a new group (`model.groups` gains `{id, label, parent?, sources: ['proposed']}`, `marks.groups[id] = 'proposed'`): `parent` (an id or label, a proposed one included) nests it, none puts it at the top. Its **entry** is its `first` card when it has one, else a **placeholder** card (`<group id>.entry`, labelled "<label> (no cards yet)", `marks.placeholders[id] = group`) that stands for the group until a card is proposed into it. `attach` is one relationship between `to` and the entry (`in`: to → entry, the group is an outlet of `to`; `out`: entry → to; default `calls`). A name another group has is a warning (put cards in that group instead); an `attach.to` that isn't there is a warning, and the group is still proposed without it |
| `rename` / `remove` with `group` | `rename` changes a group's label (a group of the code is marked `renamed`; a proposed one's placeholder follows); `remove` takes back a group this splice proposes, with its proposed cards and subgroups, and moves a card of the code that was moved into it back to its own group. A group of the code can't be removed (remove its cards). A `node` that names no node but exactly names a group acts on the group |
| `replace` … `with: {node}` or `with: "Y"` | swap X for Y: Y (a new node, whose kind, category and group default to X's, or a node that exists) takes over every relationship of X, in and out, with their kinds and labels (X's old ones are `rerouted`, a relationship that would join Y to itself is dropped); X is marked `removed` (a ghost) and `marks.replaced[X] = Y`. Later ops that place a node next to X, connect or disconnect it **follow** the replacement to Y (`result.follows`); a later remove, rename, move or replace of X doesn't (it warns "is replaced by Y"). Removing Y undoes the replace |

- **Proposed groups.** The first card that lands in a proposed group (an `add` with its `group`, a `move` into it, or an add placed next to its placeholder) takes over the placeholder's relationships, and the placeholder goes; a proposed group whose last card goes gets its placeholder back. `connect` / `disconnect` and `attach.to` may name a proposed group: they mean its entry. `describeOp` says it: "Add group Notifications in Orders, which Orders API calls", "Add Mailer in Notifications, which Orders API calls", "Rename group Notifications to Alerts", "Remove group Alerts".
- **New nodes** get `sources: ['proposed']`, kind `service` unless given, and the group of the node they are placed next to (`b` for between, `X` for before and after, `to` for attach; `splice` for a free node or one next to an ungrouped node). Their ids are `splice.<slug>`; an `add` without an id derives one from the label (`slugId`), unique in the model.
- **Proposals retire, never ghost:** rerouting, disconnecting or removing something the splice itself proposed deletes it (it never existed). Removing a proposed node also gives back the relationships it had rerouted.
- **Why "after X" doesn't always reroute.** Taking over every outgoing relationship of a node that fans out ("add Metrics after the Order router", which calls five services) would make the new node the middleman for all of them, which is rarely what anyone means. So a fan-out (or a fan-in, for "before") gets one more step beside the others, and `describeOp` says which happened: "Insert Formatter after Report renderer" (it went in between) or "Add Metrics, which Order router also calls" ("Add Guard, which also calls Orders store" for before). `result.trace.placed[i]` records it per op (`interpose` or `also`). To put something in front of one of several relationships, use `between`.
- **References follow renames too.** An op naming a node by a label an earlier op renamed away still finds it (a `renamed` follow).
- **Nothing throws.** An op that can't apply (an unknown node, a module, a node an earlier op removed, `between` two nodes with no relationship, a bad id or kind, two placements) is skipped with a warning `{ op, message, hint }`; the hint is a did-you-mean over ids and labels, or what to do.
- **Idempotent.** Applying a splice to its own result gives the same model: the splice's own proposals in the input are taken out and proposed again in order (a rename or move just reports that it's already done). Proposals from another splice stay: splices stack.

### API (`src/model/splice.ts`, pure: browser and bun)

```ts
applySplice(model: Model, splice: Splice): { model: Model; marks: SpliceMarks; warnings: SpliceWarning[] }
interface SpliceMarks {
  nodes: Record<string, 'proposed' | 'removed' | 'renamed' | 'moved'>;   // by node id
  edges: Record<string, 'proposed' | 'removed' | 'rerouted'>;           // by pairKey; removed and rerouted both draw as ghosts
  byOp: number[][];                                                      // per op: the earlier ops it builds on (whose proposals it names or retires)
  touched: { nodes: string[]; edges: string[] }[];                       // per op: what it proposed, retired, restored or changed
  replaced: Record<string, string>;                                      // X → Y, for every replace still in effect
  groups: Record<string, 'proposed' | 'renamed'>;                        // by group id
  placeholders: Record<string, string>;                                  // a proposed group's placeholder card → its group
}
interface SpliceWarning { op: number; message: string; hint?: string }
// also on the result: follows: { op, ref, from, to, why: 'replaced' | 'renamed' }[] (references that followed a replace
// or a rename) and trace: { retired, removed, placed } (which op last retired each relationship or removed each node,
// proposals included; how each before / after was placed), for explaining combinations

spliceOp.add(label, where?: { between: [a, b] } | { before } | { after } | { attach: { to, dir?, kind? } } | null, opts?: { id?, kind?, category?, tags?, group?, summary?, taken?: Model | Iterable<string> })
spliceOp.connect(from, to, kind = 'calls', label?) · .disconnect(from, to) · .remove(node) · .rename(node, label) · .move(node, group)
spliceOp.group(label, { id?, parent?, summary?, first?: string | SpliceNode, attach?, taken? }) · .renameGroup(group, label) · .removeGroup(group)
resolveGroupRef(model, ref): { id, match: 'id' | 'label' | 'none' | 'ambiguous', suggestions }   // a group by id or label ("the X group" too)
entryId(groupId)                                                                                   // its placeholder card's id
spliceOp.replace(node, label, opts?) · spliceOp.replace(node, { ref })                                    // with a new node, or with one that exists
resolveNodeRef(model | nodes, ref): { id: string | null; match: 'id' | 'label' | 'fuzzy' | 'none' | 'ambiguous'; suggestions: { id, label }[] }
describeOp(model, op, marks?): string         // "Insert Read cache between Checkout and Orders store", "Replace Orders store with Event store"; pass the spliced model (and its marks) to name added nodes and count only live relationships
emptySplice(base, view = {}, { id?, title?, note?, now? }): Splice
slugId(label, taken: Iterable<string> | (id) => boolean): string        // splice.read-cache, splice.read-cache-2 …
validateSplice(json, model?): { level: 'error' | 'warn'; path: string; message: string; hint?: string }[]   // schema + meaning; with a model, what won't apply
landed(model, splice): ('pending' | 'landed' | 'conflict')[]            // landedDetail(): the same with a reason each
```

**`landed`** asks, per op, whether the real code has caught up (a `group` has landed when the model has a group with its id or label and, when attached, a relationship between `to` and a card in it) (pass the real model; proposed items in it are ignored). An `add` has landed when the model has a node with the proposed id, or one with the same label and the proposed neighbours (between a and b: a → it → b); later ops that name the proposed id then follow the real one. `connect` lands when the relationship exists, `disconnect` and `remove` when it's gone, `rename` and `move` when the label or group matches. An op that hasn't landed is `conflict` when it no longer applies to the real model (a node it names is gone, the relationship it inserts into was removed), else `pending`.

### Combining splices

`combineSplices(model, [{title, splice}, …], {same?})` (`src/model/splice-stack.ts`, pure) is several splices as one what-if, built so a person can trust it: nothing one splice does is silently lost, and what it reports doesn't depend on the order.

- **Applied in order, as one splice**, so each change sees what the earlier splices proposed, took away and replaced (a node another splice replaced means its replacement). The result is also computed **in the other order** (`other: {order, result, differs}`).
- **Ids kept apart per splice.** Each splice's proposals get explicit ids first (an id-less add gets the one it would get on its own). When two splices propose the same id for different things, the later one in the list given is renamed `<id>.<splice id>` and labelled "Read cache (Probe)", in both orders, so two different "Read cache" proposals stay two cards. The list's order decides this, so swapping the order swaps which one is suffixed.
- **Agreement.** The same op on the same resolved targets, with an equivalent node (same label, kind and placement), from two splices or more, is one proposal: applied once (whichever runs first), the other splices' references to its node land on that one node.
- **Same thing?** Two proposals from different splices with one name that don't agree are asked about. The person can say they are one thing (`same`: the key `"<splice>/<id> = <splice>/<id>"`, recorded in the combination, never in either splice file): the node is made once and placed where each splice put it (the second place with an internal `$reuse` add, or a replace with the existing node).
- **What it finds**, every kind explained the same way (`subject`, `parts` per splice with what it does in `describeOp`'s words, `result`), in `conflicts` (conflicts first):

| kind | group (the key's word) | when | example |
|---|---|---|---|
| `conflict` | conflict ⚠ "two splices disagree" | a genuine disagreement, checked change against change both ways round: two renames, moves or replaces of one node that differ; a remove or replace against a rename, move or the other; a disconnect against an insert into, or a connect of, that relationship; two different inserts into one relationship | "Cut and Buffer disagree about Checkout → Orders store" |
| `lost` | consequence ⚠ "a change lost or left dangling" | a change from one splice another undoes: it removes a node the change needs (same words in both orders), brings back what it removed ("is back"), or a proposal isn't added; a change that only builds on a lost one is said inside that one | "Checkout → Audit log disappears because No audit removes Audit log" |
| `dangling` | consequence ⚠ | a proposed node left with nothing on a side it had in its own splice | "Read cache has nothing behind it, because No orders store removes Orders store" |
| `order` | order ⇄ "the order changes the result" | the other order gives other live nodes, relationships or names; says what each order gives (relationships as chains) | "Cut, then Buffer gives no Buffer; Buffer, then Cut gives Buffer" |
| `same-name` | same name ? / same thing = | two different proposals with one name (not agreed); once treated as one, a quiet note | "Two different Read caches, one in Caching (in front of Orders store) and one in Probe (in front of Billing). Same thing?" |
| `agreed` | agreed ✓ "proposed by both, shown once" | identical proposals (a quiet note, not a conflict) | "Caching and Store cache agree: Insert Read cache between Checkout and Orders store" |
| `follows` | follows → "follows a replacement" | one splice's changes name a node another splice replaced, and now apply to the replacement (a quiet note) | "Caching's Read cache now fronts Event store, which replaced Orders store" |

  **Conflict** is kept for real disagreements; **consequence** covers what combining breaks or undoes without anyone disagreeing about the same thing. The checks run over each splice's changes resolved against the base model (so the words are the same in either order), then against each splice on its own (a proposal that isn't added or has lost a side, a proposed relationship that no longer holds, not even through proposed nodes, a removal undone), then any change that warns only once combined. Warnings a splice has on its own stay `warnings`. Two changes that are compatible (a rename and a move of one node, an insert next to a node another renames) report nothing.
- **Proposed groups across splices.** Group ids are kept apart per splice like node ids (a second splice's `splice.notifications` becomes `splice.notifications.<splice id>`, labelled "Notifications (Beta)"); two splices proposing a group with one name is a **same name** question ("Two different Notifications groups, one in Alpha (called by Orders API) and one in Beta (called by Billing). Same thing?"), and treated as the same it is made once, holding what both put in it; the same group op from two splices is **agreed**. A splice that removes the node another splice's group is attached to is a **consequence** ("Nothing reaches the Notifications group any more, because Cut removes Orders API"), the same words in either order; two different names for one group are a **conflict**.
- **Replace across splices.** Because references to a replaced node follow it, a pair like this combines the same way in either order: Caching (a Read cache between Checkout and the Orders store) and Event store (`replace` the Orders store) give Checkout → Read cache → Event store, with one `follows` note and no conflict. Written instead as a remove of the Orders store plus a new Event store, the cache dangles in one order and isn't added in the other, and both say so, with the order item.

`spliceStack(model, layers, {combine, same})` builds the slices a Stack view compares: the real model, one per splice (with its marks and its changes in words), and the combination, titled by its order ("Caching, then Event store"), whose `warning` carries one numbered item per finding with its kind's name, symbol, tone and meaning (`ISSUE_WORDS`) and, for a same-name item, a "Treat as the same" / "Treat as different" action (docs/ENGINE.md "Stack of splices").

### Views

`verdict` is `proposed` for a relationship only a splice declares, and `wireStyle` gives it the `'proposed'` style; the node's `sources` say the same. Marks say the rest: `removed` / `rerouted` relationships and `removed` nodes are drawn as ghosts, `renamed` and `moved` nodes as changed.

### Saving (dev server only)

`bunx vite` (`just dev`) serves them, next to the layout saver (`vite.config.ts`, `src/model/splice-store.ts`). The layout saver, `POST /__karyo/layout?file=<…/karyo.layout.json>` (a structure board's "Save as team layout"), writes a `karyo.layout.json` only beside a `karyo.model.json` in this checkout, or anywhere in the project in project mode; anything else is a 403. The splices:

| request | answer |
|---|---|
| `GET /__karyo/splices?dir=<project dir>` (or its `karyo/splices`) | `[{ id, title, updated, ops, file }]`, newest first; `[]` when there are none |
| `GET /__karyo/splice?file=<…/karyo/splices/<id>.splice.json>` | the splice |
| `POST /__karyo/splice?file=…` (body: the splice) | validated (`validateSplice` errors: 400 with `issues`), then written atomically: `{ ok: true, file, issues }` |
| `DELETE /__karyo/splice?file=…` | `{ ok: true, file }`, or 404 |

Only `karyo/splices/*.splice.json` files inside the repo: repo-relative paths of plain segments (no `.` or `..`, no dot-folders, no `node_modules`), and the real folder (symlinks followed) must be inside the repo; anything else is a 403.

## Kit kinds and fields

A node's `kind` may also be any other lowercase word, which a project's **kit** can draw with its own card, sections and legend entry, and a node may carry that kind's own data in `fields` (docs/KITS.md). The directives and the Go scan accept such a kind unless it reads as a typo of a built-in one; the merge keeps `fields` like any other key. A kind no kit adds is drawn with the default card.
