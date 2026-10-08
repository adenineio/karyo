"""Turn parsed directives into model records (nodes, edges, checks). Shared by the static scan and
the recorder, so a node looks the same whether it was read from the file or found at import time."""
from __future__ import annotations

import ast
from typing import Callable, Optional

from . import code_excerpt
from .directives import EDGE_KEYS, Directive, Parsed, first_doc_line


def node_record(d: Directive, module: str, rel: str, lines: list[str]) -> dict:
    """The model node a `karyo:node` directive declares."""
    a, n = d.attrs, d.target
    assert n is not None
    end = n.end_lineno or n.lineno
    out = {"id": a["id"], "kind": a.get("kind") or "function", "label": a.get("label") or n.name,
           "summary": a.get("summary") or first_doc_line(n), "group": a.get("group") or module.split(".")[0],
           "category": a.get("category"), "tags": a.get("tags") or None,
           "module": module, "lang": "python", "ref": {"file": rel, "line": n.lineno, "symbol": d.qualname},
           "code": code_excerpt(rel, lines[d.start - 1:end], d.start, end), "sources": ["declared"]}
    return {k: v for k, v in out.items() if v is not None}


def external_record(d: Directive) -> dict:
    a = d.attrs
    out = {"id": a["id"], "kind": a.get("kind") or "external", "label": a.get("label") or a["id"],
           "summary": a.get("summary"), "group": a.get("group") or a["id"].split(".")[0],
           "category": a.get("category"), "tags": a.get("tags") or None, "sources": ["declared"]}
    return {k: v for k, v in out.items() if v is not None}


def declare(parsed: Parsed, module: str, rel: str, add_node: Callable[[dict], None],
            add_edge: Callable[..., None]) -> None:
    """Feed one file's node / external / edge directives to a registry."""
    for d in parsed.directives:
        if d.verb == "node":
            add_node(node_record(d, module, rel, parsed.lines))
            for k in EDGE_KEYS:
                for t in d.list(k):
                    add_edge(d.attrs["id"], t, k)
        elif d.verb == "external":
            add_node(external_record(d))
        elif d.verb == "edge":
            add_edge(d.attrs["from"], d.attrs["to"], d.attrs.get("kind") or "calls", d.attrs.get("label"))


def span_targets(parsed: Parsed) -> list[tuple[Directive, Optional[str]]]:
    """What the recorder wraps: (directive, span label) for every def a node or span directive marks.
    A class node declares the node and is marked with it; its methods are wrapped only when they carry
    a directive of their own."""
    out: list[tuple[Directive, Optional[str]]] = []
    for d in parsed.directives:
        if d.target is None:
            continue
        if isinstance(d.target, ast.ClassDef):
            if d.verb == "node":
                out.append((d, None))
            continue
        if d.verb == "node" and d.attrs.get("record", True) is False:
            continue
        out.append((d, d.attrs.get("label") if d.verb == "span" else None))
    return out
