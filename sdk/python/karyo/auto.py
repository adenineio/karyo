"""Automatic mode: every class and public function or method is a node, with the static call graph.

`python -m karyo scan --auto <package-dir>` (the default for a package with no `# karyo:` directives)
reads the code with `ast` (nothing is imported or run) and adds, next to the directives and imports:

  nodes   every class (kind `type`) and every public function or method (kind `function`), with a
          stable id `module.qualname` (`orders.api.checkout`, `orders.db.Store.get`), the module's package
          as its group, its code and ref. A method's `parent` is its class, and it is drawn folded into
          it (`fold: true`) until a curation file (karyo/curation.json) says otherwise. A `# karyo:node`
          directive (or `@karyo.node`) on a def refines that def's automatic node rather than adding one:
          without `id=` it keeps the automatic id, with one it renames the node; what it says (label,
          kind, category, tags, `calls=` …) wins, what it doesn't say (kind, label, group, the parent a
          method folds into) stays the automatic node's (`refine`). A `# karyo:span node=X` makes the
          def part of X.
  edges   `calls`, source `extracted`, between those nodes, for what can be resolved soundly:
          direct calls of functions (also through `import m`, `from m import f as g` and module-level
          aliases), class instantiation, `self.method()` (inherited methods through the known class
          hierarchy, `super().method()`), and calls through attributes and variables whose type is
          known (a parameter or variable annotation, `self.store = SessionStore(…)` in `__init__`, a
          class-level annotation, `x = Store()`, a function's return annotation). Anything else (a
          `getattr`, a callback, a value whose type isn't certain, a method an unknown base class
          could override) is skipped: an edge is never guessed.

Which code is a node, and where calls made in code that isn't one go, is the same rule for the
static scan and for the sys.monitoring recorder (karyo/_monitor.py), so the two agree:

  - a class, a module-level function, a method (and `__call__`) whose name has no leading `_`, of a
    class that is a node, is a node;
  - `__init__`, `__new__` and `__post_init__` are the class: constructing it is a call of the class
    node, and the calls they make are the class's;
  - everything else (private helpers, other dunders, properties, nested functions, lambdas) is
    transparent: its calls count as calls of the node that called it (statically: a private helper's
    calls are inlined into its callers; a nested function or lambda's calls are its enclosing node's).

A node id that would also be a module's name (a function `foo` in `pkg/__init__.py` next to
`pkg/foo.py`) is written `module:qualname` instead, since node ids and module names share one namespace.
"""
from __future__ import annotations

import ast
import builtins
import os
import re
from typing import Iterable, Optional

from . import code_excerpt
from . import directives as dv

INIT_METHODS = ("__init__", "__new__", "__post_init__")
PUBLIC_DUNDERS = ("__call__",)
_FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)
_DEFS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
_COMPS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
_FOUND = frozenset({ast.Import, ast.ImportFrom, *_DEFS, ast.Call, ast.Global})   # what Mod.found() keeps
_STATEMENTS = tuple(t for t in (ast.stmt, ast.excepthandler, getattr(ast, "match_case", None)) if t is not None)  # what holds statements
_DIRECTIVE = re.compile(r"^[ \t]*#\s?karyo:(?:node|span|external|edge)\b|\bkaryo\.node\(|^[ \t]*@node\(", re.M)
_BUILTINS = set(dir(builtins))
# External base classes known not to define the methods an app calls on its own objects: a lookup may
# pass them. Any other unknown base stops a method lookup (it could override the method).
_HARMLESS_BASES = {"builtins.object", "typing.Generic", "typing.Protocol", "typing_extensions.Protocol", "abc.ABC",
                   "typing.NamedTuple", "typing.TypedDict", "typing_extensions.TypedDict", "enum.Enum", "enum.IntEnum",
                   "enum.StrEnum", "enum.Flag", "enum.IntFlag"}


# ------------------------------------------------------------------ walking the tree
#
# The scan walks a lot of syntax, so it walks it cheaply: `_children` is ast.iter_child_nodes without the
# leaves nothing is ever looked up in (names, constants, operators, load/store), and the field list of each
# node type is worked out once. Leaving out leaves keeps the order of everything else.

def _subclasses(t: type) -> list[type]:
    return [s for c in t.__subclasses__() for s in (c, *_subclasses(c))]


_LEAVES = frozenset({ast.Name, ast.Constant, ast.alias, *_subclasses(ast.expr_context), *_subclasses(ast.boolop),
                     *_subclasses(ast.operator), *_subclasses(ast.unaryop), *_subclasses(ast.cmpop)})
_INNER = frozenset(t for t in _subclasses(ast.AST) if t not in _LEAVES)   # every other node type
_NOT_NODES = frozenset({"ctx", "op", "ops", "names", "name", "id", "attr", "arg", "module", "level", "kind",
                        "conversion", "type_comment", "is_async", "rest", "kwd_attrs"})   # fields that never hold a node worth visiting
_FIELDS: dict[type, tuple[str, ...]] = {}


def _children(n: ast.AST) -> list:
    """n's child nodes, in ast.iter_child_nodes order, less leaves."""
    t = type(n)
    fields = _FIELDS.get(t)
    if fields is None:
        fields = _FIELDS[t] = () if t in _LEAVES else tuple(f for f in t._fields if f not in _NOT_NODES)
    out = []
    for f in fields:
        v = getattr(n, f, None)
        if type(v) is list:
            out += [x for x in v if type(x) in _INNER]
        elif type(v) in _INNER:
            out.append(v)
    return out


# The fields a statement (or an except clause, a with item, a match case or pattern) can hold another one in.
_PART_FIELDS = frozenset({"body", "orelse", "finalbody", "handlers", "items", "cases", "pattern", "patterns", "kwd_patterns"})
_PARTS: dict[type, tuple[str, ...]] = {}


def _parts(n: ast.AST, keep: tuple) -> list:
    """The children of n of the `keep` types that can hold statements, with-items or patterns (as _children
    would list them): what a walk of statements needs, without looking through every expression."""
    t = type(n)
    fields = _PARTS.get(t)
    if fields is None:
        fields = _PARTS[t] = tuple(f for f in t._fields if f in _PART_FIELDS)
    out = []
    for f in fields:
        v = getattr(n, f, None)
        out += [x for x in v if isinstance(x, keep)] if type(v) is list else [v] if isinstance(v, keep) else []
    return out


def _all_nodes(n: ast.AST, keep: Optional[tuple] = None) -> list:
    """n and every node below it in ast.walk's order (breadth first), less leaves; with `keep` (statement
    types), only the nodes of those types (and what is below them), which leaves the order of the rest as it is."""
    out = [n]
    i = 0
    while i < len(out):
        out += _children(out[i]) if keep is None else _parts(out[i], keep)
        i += 1
    return out


def has_directives(texts: Iterable[str]) -> bool:
    """Do any of these sources declare themselves (a `# karyo:` directive or `@karyo.node`)? Automatic mode is
    the default only when none do, for the scan and the recorder alike."""
    # every directive form has "karyo" or "@node(" in it, and a plain substring test is far cheaper than the pattern
    return any(("karyo" in t or "@node(" in t) and _DIRECTIVE.search(t) for t in texts)


def group_of(module: str, is_pkg: bool) -> str:
    """An automatic node's group: its module's package (a package's own `__init__` is that package)."""
    if is_pkg:
        return module
    return module.rpartition(".")[0] or module


# ------------------------------------------------------------------ defs and node ids

class Def:
    """A class, function or method in one module."""

    def __init__(self, mod: "Mod", node: ast.AST, qualname: str, cls: Optional["Def"], outer: Optional["Def"]):
        self.mod, self.ast, self.qualname = mod, node, qualname
        self.name: str = node.name  # type: ignore[attr-defined]
        self.is_class = isinstance(node, ast.ClassDef)
        self.cls = cls                  # the class whose body this def is directly in
        self.outer = outer              # the function this def is nested in (then it's transparent)
        self.first = node.decorator_list[0].lineno if node.decorator_list else node.lineno  # type: ignore[attr-defined]
        decos = [_deco_name(d) for d in node.decorator_list]  # type: ignore[attr-defined]
        self.static = "staticmethod" in decos
        self.classmethod = "classmethod" in decos
        self.prop = any(d in ("property", "cached_property") or d.endswith((".setter", ".getter", ".deleter")) for d in decos)
        self.overload = "overload" in decos
        self.id: Optional[str] = None   # the node its code counts as: its own, its class's (init), a directive's, or None
        self.own = False                # it is that node (not a part of another one)
        self.init = False               # __init__ / __new__ / __post_init__: the class node
        self.declared = False           # the id came from a directive (or @karyo.node)
        self.given: frozenset = frozenset()   # declared: the keys the declaration gives (the rest are automatic)
        self.members: dict[str, list] = {}   # class: name -> [Def | "attr"] defined in its body
        self.calls: Optional[list["Def"]] = None
        self._attrs: Optional[dict] = None
        self._mro: Optional[list] = None
        self._bases: Optional[list] = None

    @property
    def kind(self) -> str:
        return "class" if self.is_class else "method" if self.cls is not None and self.outer is None else "function"

    def __repr__(self) -> str:
        return f"<Def {self.mod.name}.{self.qualname}>"


def _deco_name(d: ast.expr) -> str:
    if isinstance(d, ast.Call):
        d = d.func
    parts = []
    while isinstance(d, ast.Attribute):
        parts.append(d.attr)
        d = d.value
    if isinstance(d, ast.Name):
        parts.append(d.id)
    name = ".".join(reversed(parts))
    return name.split(".")[-1] if name.startswith(("functools.", "typing.", "abc.")) else name


_BODIES = ("body", "orelse", "finalbody", "handlers", "cases")    # where a statement holds more statements
_BODY_FIELDS: dict[type, tuple[str, ...]] = {}                    # node type -> those of its fields


class Mod:
    """One module: its directives, defs and top-level bindings."""

    def __init__(self, name: str, path: str, rel: str, source: str, comments=None):
        self.name, self.path, self.rel = name, path, rel
        self.is_pkg = os.path.basename(path) == "__init__.py"
        # comments: dv.comments_or_error(source), if read already; a node directive without id= takes the def's automatic id
        self.parsed = dv.read(source, rel, comments, default_id=self.auto_id)
        self.tree = self.parsed.tree
        self.lines = self.parsed.lines
        self.defs: list[Def] = []
        self.by_ast: dict[int, Def] = {}
        self.by_qualname: dict[str, list[Def]] = {}
        self.globals: dict[str, list] = {}
        self.stars: list[str] = []
        self.scopes: dict[int, tuple] = {}      # id(function ast) -> its names, collected once (see Scope)
        self.walrus = ":=" in source            # may a name be bound inside an expression (`x := …`)? (an over-estimate)
        self.decorates = "node(" in source      # may it use the decorator form (@karyo.node(…))? (an over-estimate)
        self._found: dict[bool, list] = {}
        if self.tree is not None:
            self._walk(self.tree.body, "", None, None)

    def auto_id(self, qualname: str) -> Optional[str]:
        """The automatic node id of the def named `qualname` here: `module.qualname`, or `module:qualname`
        when that would also name a module."""
        nid = f"{self.name}:{qualname}" if _module_clash(self, qualname) else f"{self.name}.{qualname}"
        return nid if dv.ID_RE.match(nid) else None

    def decorated(self) -> dict[int, tuple[str, frozenset]]:
        """Defs declared with the decorator form (`@karyo.node("id", …)`, `@node(…)` imported from karyo):
        id(def ast) -> (node id, the keyword arguments given)."""
        out: dict[int, tuple[str, frozenset]] = {}
        if self.tree is None or not self.decorates:
            return out
        names = karyo_names(self.found())
        if not names[0] and not names[1]:
            return out
        for d in self.defs:
            for dec in d.ast.decorator_list:  # type: ignore[attr-defined]
                if isinstance(dec, ast.Call) and karyo_call(dec, names) == "node" and dec.args \
                        and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
                    out[id(d.ast)] = (dec.args[0].value, frozenset(k.arg for k in dec.keywords if k.arg))
        return out

    def found(self, calls: bool = False) -> list:
        """The module's imports, defs and `global` statements (in functions and classes too), in ast.walk's
        order; with `calls`, its calls as well, which takes a walk of every expression instead of only the
        statements. The scan and the bindings share these walks."""
        if calls not in self._found:
            keep = None if calls else _STATEMENTS
            self._found[calls] = [n for n in _all_nodes(self.tree, keep) if type(n) in _FOUND] if self.tree is not None else []
        return self._found[calls]

    def _walk(self, body: list, prefix: str, cls: Optional[Def], outer: Optional[Def]) -> None:
        for s in body:
            if isinstance(s, _DEFS):
                d = Def(self, s, prefix + s.name, cls, outer)
                self.defs.append(d)
                self.by_ast[id(s)] = d
                self.by_qualname.setdefault(d.qualname, []).append(d)
                if cls is not None and outer is None:
                    cls.members.setdefault(s.name, []).append(d)
                if d.is_class:
                    self._walk(s.body, d.qualname + ".", d, outer)
                else:
                    self._walk(s.body, d.qualname + ".<locals>.", None, d)
            elif cls is not None and outer is None and isinstance(s, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                for t in (s.targets if isinstance(s, ast.Assign) else [s.target]):
                    for n in _names(t):
                        cls.members.setdefault(n, []).append("attr")
            else:
                fields = _BODY_FIELDS.get(type(s))
                if fields is None:
                    fields = _BODY_FIELDS[type(s)] = tuple(f for f in _BODIES if f in type(s)._fields)
                for field in fields:
                    sub = getattr(s, field, None)
                    if isinstance(sub, list):
                        self._walk(sub, prefix, cls, outer)


def karyo_names(found: list) -> tuple[set[str], dict[str, str]]:
    """How a module refers to karyo: names bound to the module (`import karyo [as k]`), and names bound to
    its functions (`from karyo import node [as n]`). `found`: the module's imports (Mod.found)."""
    mods: set[str] = set()
    funcs: dict[str, str] = {}
    for n in found:
        if isinstance(n, ast.Import):
            mods |= {a.asname or a.name for a in n.names if a.name == "karyo"}
        elif isinstance(n, ast.ImportFrom) and n.module == "karyo" and not n.level:
            funcs |= {a.asname or a.name: a.name for a in n.names}
    return mods, funcs


def karyo_call(c: ast.Call, karyo: tuple[set[str], dict[str, str]]) -> str:
    """The karyo function a call calls (`karyo.edge(...)`, or `edge(...)` imported from karyo), else "":
    another library's `dot.edge("a", "b")` is not a karyo edge."""
    f = c.func
    if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in karyo[0]:
        return f.attr
    if isinstance(f, ast.Name):
        return karyo[1].get(f.id, "")
    return ""


def _names(t: ast.AST) -> list[str]:
    if isinstance(t, ast.Name):
        return [t.id]
    if isinstance(t, (ast.Tuple, ast.List)):
        return [n for e in t.elts for n in _names(e)]
    if isinstance(t, ast.Starred):
        return _names(t.value)
    return []


def _module_clash(mod: Mod, qualname: str) -> bool:
    """Would `mod.qualname` also name a module (e.g. function `foo` in pkg/__init__.py next to pkg/foo.py)?"""
    if not mod.is_pkg:
        return False
    p = os.path.join(os.path.dirname(mod.path), *qualname.split("."))
    return os.path.isfile(p + ".py") or os.path.isfile(os.path.join(p, "__init__.py"))


def assign_ids(mod: Mod, auto: bool) -> None:
    """Give every def the node its code counts as (see the module docstring)."""
    by_target: dict[int, list[dv.Directive]] = {}
    for d in mod.parsed.directives:
        if d.target is not None:
            by_target.setdefault(id(d.target), []).append(d)
    decorated = mod.decorated()
    for d in mod.defs:           # outer defs first, so a method sees its class's id
        dirs = by_target.get(id(d.ast), [])
        nd = next((x for x in dirs if x.verb == "node"), None)
        sd = next((x for x in dirs if x.verb == "span"), None)
        deco = decorated.get(id(d.ast))
        if nd is not None:
            d.id, d.own, d.declared = nd.attrs["id"], True, True
            d.given = frozenset(k for x in dirs if x.verb == "node" for k in x.attrs)
        elif deco is not None:
            d.id, d.own, d.declared, d.given = deco[0], True, True, deco[1] | {"id"}
        elif sd is not None:
            d.id = sd.attrs["node"]
        elif d.outer is not None or d.overload:
            d.id = None
        elif not d.is_class and d.cls is not None and d.name in INIT_METHODS:
            # constructing the class: in automatic mode, or when a directive made the class a node
            d.id, d.init = (d.cls.id if d.cls.own and (auto or d.cls.declared) else None), True
        elif not auto:
            d.id = None
        elif d.is_class:
            ok = not d.name.startswith("_") and (d.cls is None or d.cls.own)
            d.id, d.own = (_auto_id(mod, d) if ok else None), ok
        elif d.cls is None:
            ok = not d.name.startswith("_")
            d.id, d.own = (_auto_id(mod, d) if ok else None), ok
        else:
            ok = d.cls.own and not d.prop and (d.name in PUBLIC_DUNDERS or not d.name.startswith("_"))
            d.id, d.own = (_auto_id(mod, d) if ok else None), ok
        if d.id is None:
            d.own = False
    # ids that differ only in case (`stages.Chunk` the class, `stages.chunk` the function) are one name to a reader,
    # and the model refuses them (docs/MODEL.md "Identity"): all but the first one defined are written module:qualname
    # (a declaration keeps the id it gives or takes: an automatic one that differs from it only in case moves aside)
    folds: dict[str, list[Def]] = {}
    for d in mod.defs:
        if d.own and d.id:
            folds.setdefault(_fold(d.id), []).append(d)
    for same in folds.values():
        for d in [x for x in sorted(same, key=lambda x: (not x.declared, x.first, x.qualname))[1:] if not x.declared]:
            d.id = f"{mod.name}:{d.qualname}"
            for m in mod.defs:            # its __init__ is still the class
                if m.init and m.cls is d:
                    m.id = d.id


def _fold(nid: str) -> str:
    return re.sub(r"\.{2,}", ".", "".join(nid.split()).lower()).rstrip(".")


def _auto_id(mod: Mod, d: Def) -> Optional[str]:
    return mod.auto_id(d.qualname)


def refine(rec: dict, d: Def) -> dict:
    """In automatic mode, a declaration on a def (a `# karyo:node` directive, `@karyo.node`) refines the def's
    automatic node instead of standing beside it: what the declaration says wins, and what it doesn't say
    (kind, label, group) is the automatic node's, so the node keeps its place on the board; a declared method
    of a class that is a node keeps that class as its parent and is folded into it like any method (a curation's
    `top` draws it as its own card). `rec`: the declaration's record, changed in place and returned."""
    if not d.declared:
        return rec
    mod = d.mod
    auto = {"kind": "type" if d.is_class else "function", "label": d.qualname, "group": group_of(mod.name, mod.is_pkg)}
    for k, v in auto.items():
        if k not in d.given:
            rec[k] = v
    if d.cls is not None and d.cls.own and d.cls.id and d.cls.id != d.id:
        rec["parent"] = d.cls.id
        if not d.is_class and d.outer is None:
            rec["fold"] = True
    return rec


def declared_defs(mod: Mod) -> dict[str, Def]:
    """node id -> the def a declaration (a directive or the decorator) made it, in one module (ids assigned)."""
    return {d.id: d for d in mod.defs if d.declared and d.own and d.id}


def node_record(d: Def) -> dict:
    """The automatic node of a def (only for defs whose own node it is, not declared by a directive)."""
    mod, n = d.mod, d.ast
    end = n.end_lineno or n.lineno  # type: ignore[attr-defined]
    parent = d.cls.id if d.cls is not None and d.cls.own else None
    rec = {"id": d.id, "kind": "type" if d.is_class else "function", "label": d.qualname,
           "summary": dv.first_doc_line(n), "group": group_of(mod.name, mod.is_pkg), "module": mod.name, "lang": "python",
           "ref": {"file": mod.rel, "line": n.lineno, "symbol": d.qualname},  # type: ignore[attr-defined]
           "code": code_excerpt(mod.rel, mod.lines[d.first - 1:end], d.first, end), "sources": ["extracted"]}
    if parent:
        rec["parent"] = parent
        if not d.is_class:
            rec["fold"] = True
    return {k: v for k, v in rec.items() if v is not None}


# ------------------------------------------------------------------ the project: modules, bindings, values

# Values an expression can have, as far as the scan can tell for certain:
#   ("mod", name)  a project module     ("ext", dotted) something outside the project
#   ("cls", Def)   a project class      ("inst", Def)   an instance of it
#   ("fn", Def)    a function/method    ("super", Def)  super() inside a method of that class
# None: unknown. Unknown is never guessed at.


class Project:
    """Every scanned module, for resolving names across them."""

    def __init__(self, mods: dict[str, Mod], auto: bool = True):
        self.mods = mods
        self.auto = auto
        for m in mods.values():
            assign_ids(m, auto)
            self._bindings(m)
        self._stack: set = set()

    # ---- bindings

    def _relbase(self, m: Mod, node: ast.ImportFrom) -> str:
        if not node.level:
            return node.module or ""
        pkg = m.name if m.is_pkg else m.name.rpartition(".")[0]
        parts = pkg.split(".") if pkg else []
        base = ".".join(parts[: len(parts) - (node.level - 1)]) if node.level > 1 else pkg
        return f"{base}.{node.module}" if node.module else base

    def _bindings(self, m: Mod) -> None:
        if m.tree is None:
            return
        g = m.globals

        def bind(name: str, v) -> None:
            g.setdefault(name, []).append(v)

        def visit(stmts: list) -> None:
            for s in stmts:
                if isinstance(s, _DEFS):
                    bind(s.name, ("def", m.by_ast[id(s)]))
                elif isinstance(s, ast.Import):
                    for a in s.names:
                        if a.asname:
                            bind(a.asname, ("import", a.name))
                        else:
                            top = a.name.split(".")[0]
                            bind(top, ("import", top))
                elif isinstance(s, ast.ImportFrom):
                    base = self._relbase(m, s)
                    for a in s.names:
                        if a.name == "*":
                            m.stars.append(base)
                        else:
                            bind(a.asname or a.name, ("ref", f"{base}.{a.name}" if base else a.name))
                elif isinstance(s, ast.Assign):
                    if len(s.targets) == 1 and isinstance(s.targets[0], ast.Name):
                        bind(s.targets[0].id, ("expr", s.value))
                    else:
                        for t in s.targets:
                            for n in _names(t):
                                bind(n, ("unknown",))
                elif isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
                    bind(s.target.id, ("ann", s.annotation))
                elif isinstance(s, ast.AugAssign):
                    for n in _names(s.target):
                        bind(n, ("unknown",))
                elif isinstance(s, (ast.For, ast.AsyncFor)):
                    for n in _names(s.target):
                        bind(n, ("unknown",))
                    visit(s.body); visit(s.orelse)
                elif isinstance(s, (ast.With, ast.AsyncWith)):
                    for it in s.items:
                        if it.optional_vars is not None:
                            for n in _names(it.optional_vars):
                                bind(n, ("unknown",))
                    visit(s.body)
                elif isinstance(s, ast.Try) or s.__class__.__name__ == "TryStar":
                    visit(s.body); visit(s.orelse); visit(s.finalbody)
                    for h in s.handlers:
                        if h.name:
                            bind(h.name, ("unknown",))
                        visit(h.body)
                elif isinstance(s, (ast.If, ast.While)):
                    visit(s.body); visit(s.orelse)
                elif isinstance(s, ast.Match):
                    for c in s.cases:
                        for n in _all_nodes(c.pattern):
                            if isinstance(n, (ast.MatchAs, ast.MatchStar)) and n.name:
                                bind(n.name, ("unknown",))
                        visit(c.body)
                elif isinstance(s, ast.Delete):
                    for t in s.targets:
                        for n in _names(t):
                            bind(n, ("unknown",))
        visit(m.tree.body)
        # `global x` in a function rebinds x at run time
        for n in m.found():
            if type(n) is ast.Global:
                for name in n.names:
                    bind(name, ("unknown",))

    # ---- values

    def global_value(self, m: Mod, name: str):
        key = (m.name, name)
        if key in self._stack:
            return None
        self._stack.add(key)
        try:
            bs = m.globals.get(name)
            if not bs:
                sub = f"{m.name}.{name}"
                if sub in self.mods:
                    return ("mod", sub)
                for star in m.stars:
                    sm = self.mods.get(star)
                    if sm is not None and not name.startswith("_"):
                        v = self.global_value(sm, name)
                        if v is not None:
                            return v
                return ("ext", f"builtins.{name}") if name in _BUILTINS and not m.stars else None
            vals = []
            for b in bs:
                v = self._binding_value(m, b)
                if v is None:
                    return None
                if v not in vals:
                    vals.append(v)
            return vals[0] if len(vals) == 1 else None
        finally:
            self._stack.discard(key)

    def _binding_value(self, m: Mod, b):
        k = b[0]
        if k == "def":
            d: Def = b[1]
            return ("cls", d) if d.is_class else ("fn", d)
        if k == "import":
            return ("mod", b[1]) if b[1] in self.mods else ("ext", b[1])
        if k == "ref":
            return self.dotted(b[1])
        if k == "expr":
            return self.value(b[1], Scope(self, m, None, None))
        if k == "ann":
            return self.annotation(b[1], Scope(self, m, None, None))
        return None

    def dotted(self, name: str):
        """A dotted name (`pkg.mod.func`, `pkg.mod.Class.method`): the project thing it names, or ("ext", …)."""
        parts = name.split(".")
        for i in range(len(parts), 0, -1):
            head = ".".join(parts[:i])
            if head in self.mods:
                v = ("mod", head)
                for p in parts[i:]:
                    v = self.attr(v, p)
                    if v is None:
                        return None
                return v
        return ("ext", name)

    def attr(self, v, name: str):
        if v is None:
            return None
        k = v[0]
        if k == "mod":
            return self.global_value(self.mods[v[1]], name)
        if k == "ext":
            return ("ext", f"{v[1]}.{name}")
        if k == "cls":
            hit = self.lookup(v[1], name)
            if isinstance(hit, Def):
                return ("cls", hit) if hit.is_class else ("fn", hit)
            return None
        if k == "inst":
            hit = self.lookup(v[1], name)
            if isinstance(hit, Def):
                if hit.is_class:
                    return ("cls", hit)
                return None if hit.prop else ("fn", hit)
            if hit is None or hit == "attr":        # an instance attribute (or a dataclass field)
                return self.attr_type(v[1], name)
            return None
        if k == "super":
            mro = self.mro(v[1])
            hit = self._lookup_in(mro[1:], name)
            if isinstance(hit, Def) and not hit.is_class and not hit.prop:
                return ("fn", hit)
            return None
        return None

    # ---- classes

    def bases(self, c: Def) -> list:
        """A class's bases: project classes, and an `_Unknown` for each base the scan can't see (it could define anything)."""
        if c._bases is not None:
            return c._bases
        c._bases = out = []
        for b in c.ast.bases:  # type: ignore[attr-defined]
            e = b.value if isinstance(b, ast.Subscript) else b
            v = self.value(e, Scope(self, c.mod, None, None))
            if v is not None and v[0] == "cls":
                out.append(v[1])
            elif v is not None and v[0] == "ext" and (v[1] in _HARMLESS_BASES or _is_exception(v[1])):
                continue
            else:
                out.append(_Unknown())
        return out

    def mro(self, c: Def) -> list:
        """The method resolution order of a class (C3), with an `_Unknown` for each base the scan can't see."""
        if c._mro is not None:
            return c._mro
        c._mro = [c, _Unknown()]        # while computing: a cyclic hierarchy is unknown past itself
        bases = self.bases(c)
        seqs = [s[:] for s in [*(self.mro(b) if isinstance(b, Def) else [b] for b in bases), list(bases)] if s]
        out: list = [c]
        while seqs:
            head = next((s[0] for s in seqs if not any(s[0] in t[1:] for t in seqs)), None)
            if head is None:            # no consistent order (Python would refuse the class)
                out.append(_Unknown())
                break
            out.append(head)
            seqs = [t for t in ([x for x in t if x is not head] for t in seqs) if t]
        c._mro = out
        return out

    def _lookup_in(self, mro: list, name: str):
        for k in mro:
            if isinstance(k, _Unknown):
                return "?"
            ms = [x for x in k.members.get(name, ()) if x == "attr" or not x.overload]
            if ms:
                if len(ms) > 1 or ms[0] == "attr":
                    return "attr"       # redefined, or a class attribute: not a method we can name
                return ms[0]
        return None

    def lookup(self, c: Def, name: str):
        """What `name` is on class c (a Def), "attr"/"?" when unknown, None when no known class defines it."""
        return self._lookup_in(self.mro(c), name)

    def attr_type(self, c: Def, name: str):
        """The type of an instance attribute of c: from an annotation (class body or `self.x: T`), else
        from what every `self.x = …` in its methods assigns, when they all agree."""
        for k in self.mro(c):
            if isinstance(k, _Unknown):
                return None
            t = self._attrs_of(k).get(name, False)
            if t is not False:
                return t
        return None

    def _attrs_of(self, c: Def) -> dict:
        if c._attrs is not None:
            return c._attrs
        c._attrs = {}
        ann: dict[str, object] = {}
        assigned: dict[str, list] = {}
        for s in c.ast.body:  # type: ignore[attr-defined]
            if isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
                ann[s.target.id] = self.annotation(s.annotation, Scope(self, c.mod, None, None))
        for m in c.members.values():
            for d in m:
                if not isinstance(d, Def) or d.is_class or d.static or d.classmethod:
                    continue
                scope = Scope.of(self, d)
                recv = scope.receiver
                if recv is None:
                    continue
                for n in _all_nodes(d.ast):
                    if isinstance(n, ast.AnnAssign) and _is_self_attr(n.target, recv):
                        ann[n.target.attr] = self.annotation(n.annotation, scope)  # type: ignore[attr-defined]
                    elif isinstance(n, ast.Assign):
                        for t in n.targets:
                            if _is_self_attr(t, recv):
                                assigned.setdefault(t.attr, []).append(self.value(n.value, scope) if len(n.targets) == 1 else None)  # type: ignore[attr-defined]
                            else:
                                for x in _all_nodes(t):
                                    if _is_self_attr(x, recv):
                                        assigned.setdefault(x.attr, []).append(None)  # type: ignore[attr-defined]
                    elif isinstance(n, ast.AugAssign) and _is_self_attr(n.target, recv):
                        assigned.setdefault(n.target.attr, []).append(None)  # type: ignore[attr-defined]
        for name in set(ann) | set(assigned):
            if name in ann:
                c._attrs[name] = ann[name]
            else:
                vs = assigned[name]
                c._attrs[name] = vs[0] if vs and all(v is not None and v == vs[0] for v in vs) else None
        return c._attrs

    # ---- expressions

    def annotation(self, e: Optional[ast.expr], scope: "Scope"):
        """The instance type an annotation names (`Store`, `"Store"`, `Optional[Store]`, `Store | None`)."""
        if e is None:
            return None
        if isinstance(e, ast.Constant) and isinstance(e.value, str):
            try:
                e = ast.parse(e.value, mode="eval").body
            except SyntaxError:
                return None
        if isinstance(e, ast.BinOp) and isinstance(e.op, ast.BitOr):
            sides = [x for x in (e.left, e.right) if not (isinstance(x, ast.Constant) and x.value is None)]
            return self.annotation(sides[0], scope) if len(sides) == 1 else None
        if isinstance(e, ast.Subscript):
            base = self.value(e.value, scope)
            name = base[1].split(".")[-1] if base and base[0] == "ext" else ""
            elts = e.slice.elts if isinstance(e.slice, ast.Tuple) else [e.slice]
            if name in ("Optional", "Annotated"):
                return self.annotation(elts[0], scope)
            if name == "Union":
                rest = [x for x in elts if not (isinstance(x, ast.Constant) and x.value is None)]
                return self.annotation(rest[0], scope) if len(rest) == 1 else None
            return None
        v = self.value(e, scope)
        return ("inst", v[1]) if v is not None and v[0] == "cls" else None

    def value(self, e: ast.expr, scope: "Scope"):
        if isinstance(e, ast.Name):
            return scope.lookup(e.id)
        if isinstance(e, ast.Attribute):
            return self.attr(self.value(e.value, scope), e.attr)
        if isinstance(e, ast.Await):
            return self.value(e.value, scope)
        if isinstance(e, ast.Call):
            f = e.func
            if isinstance(f, ast.Name) and f.id == "super" and scope.lookup("super") == ("ext", "builtins.super"):
                return ("super", scope.cls) if scope.cls is not None and not e.args else None
            v = self.value(f, scope)
            if v is None:
                return None
            if v[0] == "cls":
                return ("inst", v[1])
            if v[0] == "fn":
                ret = v[1].ast.returns  # type: ignore[attr-defined]
                return self.annotation(ret, Scope.of(self, v[1])) if ret is not None else None
            return None
        return None

    # ---- calls

    def calls_of(self, d: Def) -> list[Def]:
        """The project defs a def's code calls (its nested functions and lambdas included), in order."""
        if d.calls is not None:
            return d.calls
        d.calls = []
        if d.is_class:
            return d.calls
        found: list[Def] = []
        _Calls(self, found).body(d, Scope.of(self, d))
        seen: set = set()
        d.calls = [x for x in found if not (id(x) in seen or seen.add(id(x)))]  # type: ignore[func-returns-value]
        return d.calls

    def call_target(self, call: ast.Call, scope: "Scope") -> Optional[Def]:
        v = self.value(call.func, scope)
        if v is None:
            return None
        if v[0] in ("fn", "cls"):
            return v[1]
        if v[0] == "inst":
            hit = self.lookup(v[1], "__call__")
            return hit if isinstance(hit, Def) and not hit.is_class else None
        return None

    def targets(self, callee: Def, seen: set) -> list[str]:
        """The nodes a call of `callee` reaches: its node, or through transparent code, the nodes that code calls."""
        if callee.is_class:
            if callee.id and callee.own:
                return [callee.id]
            inits = [self.lookup(callee, n) for n in INIT_METHODS]
            return [t for i in inits if isinstance(i, Def) for t in self.targets(i, seen)]
        if callee.id:
            return [callee.id]
        if id(callee) in seen:
            return []
        seen.add(id(callee))
        return [t for c in self.calls_of(callee) for t in self.targets(c, seen)]

    def edges(self) -> list[tuple[str, str]]:
        """Every (caller node, callee node) the code shows, in module then source order."""
        out: list[tuple[str, str]] = []
        have: set = set()
        for m in sorted(self.mods.values(), key=lambda x: x.name):
            for d in m.defs:
                if d.id is None or d.is_class:
                    continue
                for c in self.calls_of(d):
                    for t in self.targets(c, set()):
                        if t != d.id and (d.id, t) not in have:
                            have.add((d.id, t))
                            out.append((d.id, t))
        return out


class _Unknown:
    """A base class the scan can't see: a method lookup that reaches it stops (it could override anything)."""
    __slots__ = ()


def _is_exception(name: str) -> bool:
    n = name.rpartition(".")[2]
    return name.startswith("builtins.") and (n in ("BaseException", "Exception") or n.endswith(("Error", "Warning", "Exception")))


def _is_self_attr(t: ast.AST, recv: str) -> bool:
    return isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) and t.value.id == recv


class Scope:
    """A function's names: parameters (typed by annotations, the receiver by its class), local bindings,
    the enclosing function's (closures), then the module's."""

    def __init__(self, project: Project, mod: Mod, fn: Optional[ast.AST], parent: Optional["Scope"], cls: Optional[Def] = None):
        self.p, self.mod, self.parent, self.cls = project, mod, parent, cls
        self.local: dict[str, list] = {}
        self.globals: set[str] = set()
        self.nonlocals: set[str] = set()
        self.receiver: Optional[str] = None
        self.hidden: list[set] = []          # comprehension / lambda names in effect
        self._resolving: set[str] = set()    # names whose value is being worked out (`x = x.copy()` leans on itself)
        self.d: Optional[Def] = mod.by_ast.get(id(fn)) if fn is not None else None
        if fn is not None:
            # a function's names are the same every time it is looked at: collected once, shared by its scopes
            # (they only read them; what changes while resolving, hidden and _resolving, stays per scope)
            names = mod.scopes.get(id(fn))
            if names is None:
                self._collect(fn)
                names = mod.scopes[id(fn)] = (self.local, self.globals, self.nonlocals, self.receiver)
            self.local, self.globals, self.nonlocals, self.receiver = names

    @staticmethod
    def of(project: Project, d: Def) -> "Scope":
        parent = Scope.of(project, d.outer) if d.outer is not None else None
        return Scope(project, d.mod, d.ast, parent, d.cls if d.outer is None else (parent.cls if parent else None))

    def _collect(self, fn: ast.AST) -> None:
        a = fn.args  # type: ignore[attr-defined]
        params = [*a.posonlyargs, *a.args]
        d = self.d
        is_method = d is not None and d.cls is not None and d.outer is None and not d.static
        for i, p in enumerate(params):
            if i == 0 and is_method:
                self.receiver = p.arg
                self.local[p.arg] = [("recv",)]
            else:
                self.local[p.arg] = [("ann", p.annotation)] if p.annotation is not None else [("unknown",)]
        for p in (a.vararg, a.kwarg):
            if p is not None:
                self.local[p.arg] = [("unknown",)]
        for p in a.kwonlyargs:
            self.local[p.arg] = [("ann", p.annotation)] if p.annotation is not None else [("unknown",)]
        self._visit(fn.body)  # type: ignore[attr-defined]

    def _bind(self, name: str, v) -> None:
        self.local.setdefault(name, []).append(v)

    def _visit(self, stmts: list) -> None:
        exprs = self.mod.walrus
        for s in stmts:
            for n in _local_nodes(s, exprs):
                if type(n) not in _BINDERS:
                    continue
                if isinstance(n, _DEFS):
                    self._bind(n.name, ("def", self.mod.by_ast[id(n)]) if id(n) in self.mod.by_ast else ("unknown",))
                elif isinstance(n, ast.Global):
                    self.globals.update(n.names)
                elif isinstance(n, ast.Nonlocal):
                    self.nonlocals.update(n.names)
                elif isinstance(n, ast.Import):
                    for x in n.names:
                        self._bind(x.asname or x.name.split(".")[0], ("import", x.name if x.asname else x.name.split(".")[0]))
                elif isinstance(n, ast.ImportFrom):
                    base = self.p._relbase(self.mod, n)
                    for x in n.names:
                        if x.name != "*":
                            self._bind(x.asname or x.name, ("ref", f"{base}.{x.name}" if base else x.name))
                elif isinstance(n, ast.Assign):
                    if len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                        self._bind(n.targets[0].id, ("expr", n.value))
                    else:
                        for t in n.targets:
                            for x in _names(t):
                                self._bind(x, ("unknown",))
                elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
                    self._bind(n.target.id, ("ann", n.annotation))
                elif isinstance(n, (ast.AugAssign, ast.For, ast.AsyncFor)):
                    for x in _names(n.target):
                        self._bind(x, ("unknown",))
                elif isinstance(n, ast.withitem) and n.optional_vars is not None:
                    for x in _names(n.optional_vars):
                        self._bind(x, ("unknown",))
                elif isinstance(n, ast.ExceptHandler) and n.name:
                    self._bind(n.name, ("unknown",))
                elif isinstance(n, ast.NamedExpr):
                    self._bind(n.target.id, ("unknown",))
                elif isinstance(n, (ast.MatchAs, ast.MatchStar)) and n.name:
                    self._bind(n.name, ("unknown",))
                elif isinstance(n, ast.Delete):
                    for t in n.targets:
                        for x in _names(t):
                            self._bind(x, ("unknown",))

    def lookup(self, name: str):
        for h in reversed(self.hidden):
            if name in h:
                return None
        if name in self.globals:
            return self.p.global_value(self.mod, name)
        if name in self.nonlocals:
            return self.parent.lookup(name) if self.parent else None
        bs = self.local.get(name)
        if bs is not None:
            # a binding that reads the name it binds (`font = font.model_copy()`, or two names leaning on each
            # other) can't be settled from the code: unknown, never a loop
            if name in self._resolving:
                return None
            self._resolving.add(name)
            try:
                return self._local_value(bs)
            finally:
                self._resolving.discard(name)
        if self.parent is not None:
            return self.parent.lookup(name)
        return self.p.global_value(self.mod, name)

    def _local_value(self, bs: list):
        anns = [b for b in bs if b[0] == "ann"]
        if anns and all(b[0] != "recv" for b in bs):     # a declared type governs every assignment
            vs = {self._val(b) for b in anns}
            return vs.pop() if len(vs) == 1 else None
        vals = []
        for b in bs:
            v = self._val(b)
            if v is None:
                return None
            if v not in vals:
                vals.append(v)
        return vals[0] if len(vals) == 1 else None

    def _val(self, b):
        k = b[0]
        if k == "recv":
            if self.cls is None or self.d is None:
                return None
            return ("cls", self.cls) if self.d.classmethod else ("inst", self.cls)
        if k == "ann":
            return self.p.annotation(b[1], self)
        if k == "expr":
            return self.p.value(b[1], self)
        return self.p._binding_value(self.mod, b) if k in ("def", "import", "ref") else None


_OWN_NAMES = frozenset({ast.Lambda, *_COMPS, *_DEFS})   # what has names of its own (or, a class, its own body)
# Without a walrus, an expression binds nothing: the nodes a name can be bound in are statements and these parts of them.
_BINDS = tuple(t for t in (ast.stmt, ast.excepthandler, ast.withitem, getattr(ast, "match_case", None),
                           getattr(ast, "pattern", None)) if t is not None)
_BINDERS = frozenset({*_DEFS, ast.Global, ast.Nonlocal, ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign, ast.AugAssign,
                      ast.For, ast.AsyncFor, ast.withitem, ast.ExceptHandler, ast.NamedExpr, ast.Delete,
                      *(getattr(ast, t) for t in ("MatchAs", "MatchStar") if hasattr(ast, t))})   # what Scope._visit binds from


def _local_nodes(s: ast.AST, exprs: bool):
    """Every node of a statement that binds in the enclosing function: not inside nested defs, lambdas,
    classes or comprehensions (their names are their own), but their own names. `exprs`: look inside
    expressions too (only an `x := …` binds in one). Depth first, last child first."""
    stack = [s]
    while stack:
        n = stack.pop()
        yield n
        if type(n) in _OWN_NAMES:
            continue
        stack += _children(n) if exprs else _parts(n, _BINDS)


class _Calls:
    """Walks a def's code for calls, with the right scope for each part (nested functions, lambdas and
    comprehensions have their own names)."""

    def __init__(self, project: Project, out: list[Def]):
        self.p, self.out = project, out

    def body(self, d: Def, scope: Scope) -> None:
        for s in d.ast.body:  # type: ignore[attr-defined]
            self.visit(s, scope)

    def visit(self, n: ast.AST, scope: Scope) -> None:
        # depth first, in source order; a part with names of its own is visited with its own scope
        todo = [n]
        while todo:
            n = todo.pop()
            t = type(n)
            if t in _OWN_NAMES:
                self._scoped(n, scope)
                continue
            if t is ast.Call:
                c = self.p.call_target(n, scope)
                if c is not None:
                    self.out.append(c)
            todo += reversed(_children(n))

    def _scoped(self, n: ast.AST, scope: Scope) -> None:
        if isinstance(n, _FUNCS):
            for x in (*n.decorator_list, *n.args.defaults, *[k for k in n.args.kw_defaults if k is not None]):
                self.visit(x, scope)
            inner = self.p.mods[scope.mod.name].by_ast.get(id(n))
            sub = Scope(self.p, scope.mod, n, scope, scope.cls) if inner is None else Scope.of(self.p, inner)
            for s in n.body:
                self.visit(s, sub)
            return
        if isinstance(n, ast.ClassDef):
            for x in (*n.decorator_list, *n.bases):
                self.visit(x, scope)
            for s in n.body:
                self.visit(s, scope)
            return
        if isinstance(n, ast.Lambda):
            scope.hidden.append({a.arg for a in (*n.args.posonlyargs, *n.args.args, *n.args.kwonlyargs)} |
                                {a.arg for a in (n.args.vararg, n.args.kwarg) if a is not None})
            self.visit(n.body, scope)
            scope.hidden.pop()
            return
        if isinstance(n, _COMPS):
            names = {x for g in n.generators for x in _names(g.target)}
            scope.hidden.append(names)
            for g in n.generators:
                self.visit(g.iter, scope)
                for c in g.ifs:
                    self.visit(c, scope)
            for x in ((n.key, n.value) if isinstance(n, ast.DictComp) else (n.elt,)):
                self.visit(x, scope)
            scope.hidden.pop()


# ------------------------------------------------------------------ what the scan and the recorder use

def extract(mods: dict[str, Mod], taken: set[str]) -> tuple[list[dict], list[tuple[str, str]], "Project"]:
    """Automatic nodes (for defs no directive declares) and the static call graph of the scanned modules.
    `taken`: ids already used by directives or modules (an automatic node never takes one)."""
    p = Project(mods, auto=True)
    for m in mods.values():             # a module name the file-system check missed (a namespace package)
        for d in m.defs:
            if d.own and not d.declared and d.id in mods:
                d.id = f"{m.name}:{d.qualname}"
    nodes = []
    seen: set[str] = set()
    for m in sorted(mods.values(), key=lambda x: x.name):
        for d in m.defs:
            if d.own and not d.declared and d.id and d.id not in seen and d.id not in taken:
                seen.add(d.id)
                nodes.append(node_record(d))
    return nodes, p.edges(), p


def code_map(mod: Mod, auto: bool) -> dict[str, list[tuple[int, Optional[str], bool]]]:
    """For the recorder: qualname -> [(first line, node id or None, is a class's __init__)] of every def in
    one module, as the scan assigns them. A code object is looked up by its co_qualname and co_firstlineno."""
    assign_ids(mod, auto)
    out: dict[str, list[tuple[int, Optional[str], bool]]] = {}
    for d in mod.defs:
        if not d.is_class:
            out.setdefault(d.qualname, []).append((d.first, d.id, d.init))
    return out
