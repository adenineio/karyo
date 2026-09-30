"""Comment directives: the way Python code declares itself to Karyo without importing it.

Same grammar as the Go SDK's `//karyo:` directives. A directive is a full-line comment:

    # karyo:node id=orders.store kind=store label="Orders store" group=orders category=storage
    #   tags=persistent,audited calls=orders.db,billing.charge
    class OrdersStore(Store): ...

    # karyo:span node=orders.db label=save
    def save(self, order): ...

    # karyo:external id=browser kind=actor label="Browser"
    # karyo:edge from=browser to=api.checkout kind=calls label="HTTP"

`node` and `span` go on the line(s) directly above a `def` / `class` (above its decorators, if
any; other comment lines may sit between, a blank line may not). `external` and `edge` can go
anywhere. A following comment line of the form `#   key=value …` (a `#`, then three or more spaces)
continues the directive above it. Values are bare words or "double-quoted"; lists are
comma-separated, and a list key may repeat (its values add up).

Read with `tokenize` (only real comments count, never text in strings) and `ast` (which def or
class follows). Nothing is imported or run. Anything malformed (an unknown verb or key, a bad id
or kind, a missing id, a node directive with no def under it) is a `Problem`: the scan reports it
as a `directive-invalid` warning, so a typo never passes silently.
"""
from __future__ import annotations

import ast
import difflib
import io
import re
import tokenize
from dataclasses import dataclass, field
from typing import Optional, Union

KINDS = ("service", "function", "type", "store", "queue", "external", "actor", "module")
EDGE_KINDS = ("calls", "reads", "writes", "publishes", "subscribes", "imports")
ID_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$")
WORD_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$")

KEYS: dict[str, tuple[str, ...]] = {
    "node": ("id", "kind", "label", "summary", "group", "category", "tags", "calls", "reads", "writes", "publishes", "record"),
    "external": ("id", "kind", "label", "summary", "group", "category", "tags"),
    "edge": ("from", "to", "kind", "label"),
    "span": ("node", "label"),
}
REQUIRED = {"node": ("id",), "external": ("id",), "edge": ("from", "to"), "span": ("node",)}
LIST_KEYS = ("tags", "calls", "reads", "writes", "publishes")
ID_KEYS = ("id", "from", "to", "node")
EDGE_KEYS = ("calls", "reads", "writes", "publishes")
ATTACHED = ("node", "span")      # verbs that belong to the def / class below them

_DIRECTIVE = re.compile(r"^#\s?karyo:(\S*)(.*)$")
_CONTINUE = re.compile(r"^#\s{3,}(\S.*)$")

Def = Union[ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef]


@dataclass
class Problem:
    file: str
    line: int
    message: str

    def check(self) -> dict:
        return {"level": "warn", "code": "directive-invalid", "subject": f"{self.file}:{self.line}",
                "message": f"{self.file}:{self.line}: {self.message}"}

    def __str__(self) -> str:
        return f"{self.file}:{self.line}: {self.message}"


@dataclass
class Directive:
    verb: str
    attrs: dict
    line: int                          # the `# karyo:` line (1-based)
    end: int                           # its last continuation line
    target: Optional[Def] = None       # the def / class below it (node, span)
    qualname: Optional[str] = None     # dotted, e.g. "SessionStore.create"
    start: int = 0                     # first line of the target's code: its topmost directive

    def list(self, key: str) -> list[str]:
        v = self.attrs.get(key)
        return v if isinstance(v, list) else []


@dataclass
class Parsed:
    directives: list[Directive] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)
    tree: Optional[ast.Module] = None
    lines: list[str] = field(default_factory=list)


def parse_kv(text: str) -> tuple[dict[str, str], list[str]]:
    """`a=b c="d e" f=g,h` -> ({a: b, c: "d e", f: "g,h"}, errors)."""
    out: dict[str, str] = {}
    errors: list[str] = []
    i, n = 0, len(text)
    while True:
        while i < n and text[i].isspace():
            i += 1
        if i >= n:
            break
        m = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*)=").match(text, i)
        if not m:
            j = i
            while j < n and not text[j].isspace():
                j += 1
            errors.append(f"expected key=value, got {text[i:j]!r}")
            i = j
            continue
        key, i = m.group(1), m.end()
        if i < n and text[i] == '"':
            i += 1
            buf = []
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    i += 1
                buf.append(text[i])
                i += 1
            if i >= n:
                errors.append(f"{key}: unterminated quote")
            i += 1
            val = "".join(buf)
        else:
            j = i
            while j < n and not text[j].isspace():
                j += 1
            val, i = text[i:j], j
        if key in out and key in LIST_KEYS:        # a list key may repeat (e.g. across continuation lines)
            out[key] = f"{out[key]},{val}"
            continue
        if key in out:
            errors.append(f"{key} given twice")
        out[key] = val
    return out, errors


def _suggest(word: str, options: tuple[str, ...]) -> str:
    close = difflib.get_close_matches(word, options, n=1)
    return f" (did you mean {close[0]!r}?)" if close else ""


def validate(verb: str, raw: dict[str, str]) -> tuple[dict, list[str]]:
    """Check one directive's keys and values. Returns (typed attrs, errors)."""
    errors: list[str] = []
    if verb not in KEYS:
        return {}, [f"unknown directive karyo:{verb}{_suggest(verb, tuple(KEYS))} (one of {', '.join(KEYS)})"]
    allowed = KEYS[verb]
    attrs: dict = {}
    for k, v in raw.items():
        if k not in allowed:
            errors.append(f"karyo:{verb} has no key {k!r}{_suggest(k, allowed)} (keys: {', '.join(allowed)})")
            continue
        if k in LIST_KEYS:
            items = [x.strip() for x in v.split(",") if x.strip()]
            for x in items:
                if not (ID_RE if k in EDGE_KEYS else WORD_RE).match(x):
                    errors.append(f"{k}: {x!r} is not a valid {'node id' if k in EDGE_KEYS else 'tag'}")
            attrs[k] = items
        elif k in ID_KEYS:
            if not ID_RE.match(v):
                errors.append(f"{k}: {v!r} is not a valid node id (letters, digits, _ . : / -)")
            attrs[k] = v
        elif k == "kind":
            kinds = EDGE_KINDS if verb == "edge" else KINDS
            # a node kind may also be a kit's (docs/KITS.md): any other lowercase word, unless it reads as a typo of a built-in one
            kit = verb != "edge" and re.match(r"^[a-z][a-z0-9-]*$", v) and not difflib.get_close_matches(v, kinds, n=1, cutoff=0.8)
            if v not in kinds and not kit:
                errors.append(f"kind: {v!r} is not a {'edge' if verb == 'edge' else 'node'} kind{_suggest(v, kinds)} "
                              f"(one of {', '.join(kinds)})")
            attrs[k] = v
        elif k == "category":
            if not WORD_RE.match(v):
                errors.append(f"category: {v!r} is not a single word")
            attrs[k] = v
        elif k == "record":
            if v.lower() not in ("true", "false", "yes", "no"):
                errors.append(f"record: {v!r} must be true or false")
            attrs[k] = v.lower() in ("true", "yes")
        else:
            if not v:
                errors.append(f"{k} is empty")
            attrs[k] = v
    for k in REQUIRED[verb]:
        if k not in raw:
            errors.append(f"karyo:{verb} needs {k}=")
    return attrs, errors


def _defs(tree: ast.Module) -> dict[int, tuple[Def, str]]:
    """First line of every def / class (its first decorator, or the def line) -> (node, dotted qualname)."""
    out: dict[int, tuple[Def, str]] = {}

    def walk(nodes: list[ast.AST], prefix: str) -> None:
        for n in nodes:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                q = f"{prefix}{n.name}"
                first = n.decorator_list[0].lineno if n.decorator_list else n.lineno
                out[first] = (n, q)
                walk(n.body, q + ".")
            elif not isinstance(n, ast.expr):      # if / try / with / match blocks can hold defs too
                walk(list(ast.iter_child_nodes(n)), prefix)
    walk(list(tree.body), "")
    return out


def read(source: str, file: str) -> Parsed:
    """All directives in one Python source file, attached to their defs and validated."""
    p = Parsed(lines=source.splitlines())
    try:
        p.tree = ast.parse(source, filename=file)
    except SyntaxError as e:
        p.problems.append(Problem(file, e.lineno or 1, f"not valid Python: {e.msg}"))
        return p

    # full-line comments, by line
    comments: dict[int, str] = {}
    trailing: list[tuple[int, str]] = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                line = tok.start[0]
                if p.lines[line - 1][: tok.start[1]].strip():
                    trailing.append((line, tok.string))
                else:
                    comments[line] = tok.string.strip()
    except (tokenize.TokenError, IndentationError) as e:
        p.problems.append(Problem(file, 1, f"can't tokenize: {e}"))
        return p
    for line, text in trailing:
        if _DIRECTIVE.match(text):
            p.problems.append(Problem(file, line, "a karyo: directive must be a comment on its own line"))

    defs = _defs(p.tree)
    line = 1
    total = len(p.lines)
    while line <= total:
        text = comments.get(line)
        m = _DIRECTIVE.match(text) if text else None
        if not m:
            line += 1
            continue
        verb, rest, end = m.group(1), m.group(2), line
        while end + 1 in comments and (c := _CONTINUE.match(comments[end + 1])) and not _DIRECTIVE.match(comments[end + 1]):
            rest += " " + c.group(1)
            end += 1
        raw, errors = parse_kv(rest)
        attrs, verrors = validate(verb, raw)
        errors += verrors
        d = Directive(verb=verb, attrs=attrs, line=line, end=end)
        if verb in ATTACHED:
            nxt = end + 1
            while nxt in comments:               # other comment lines (more directives) may sit between
                nxt += 1
            hit = defs.get(nxt)
            if hit is None:
                errors.append(f"karyo:{verb} must be directly above a def or class (or its decorators), "
                              f"with no blank line between")
            else:
                d.target, d.qualname = hit
                if verb == "span" and isinstance(d.target, ast.ClassDef):
                    errors.append("karyo:span goes above a def (a function or method), not a class")
        for e in errors:
            p.problems.append(Problem(file, line, e))
        if not errors:
            p.directives.append(d)
        line = end + 1

    # a target's code starts at its topmost directive
    tops: dict[int, int] = {}
    for d in p.directives:
        if d.target is not None:
            tops[id(d.target)] = min(tops.get(id(d.target), d.line), d.line)
    for d in p.directives:
        if d.target is not None:
            d.start = tops[id(d.target)]
    return p


def first_doc_line(n: ast.AST) -> Optional[str]:
    doc = ast.get_docstring(n) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)) else None
    return doc.strip().splitlines()[0] if doc and doc.strip() else None
