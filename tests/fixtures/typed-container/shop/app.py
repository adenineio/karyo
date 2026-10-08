"""The app: routes a request to its handler."""
from __future__ import annotations

from shop import handlers
from shop.services import build


def serve(path: str) -> object:
    s = build()
    if path.startswith("/orders/"):
        return handlers.place_order(s, path.rpartition("/")[2])
    return handlers.cancel_order(s, int(path.rpartition("/")[2] or 0))
