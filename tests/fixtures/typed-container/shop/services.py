"""The parts, built once: what every handler is given."""
from __future__ import annotations

from dataclasses import dataclass

from shop.orders import OrderBook
from shop.stock import Stock


@dataclass
class Services:
    orders: OrderBook
    stock: Stock


def build() -> Services:
    return Services(OrderBook(), Stock())
