"""Request handlers: they get the services, and never import the parts."""
from __future__ import annotations

from shop.services import Services


def place_order(services: Services, sku: str) -> int:
    if not services.stock.reserve(sku):
        return 0
    return services.orders.place(sku)


def cancel_order(services: Services, order: int) -> bool:
    return services.orders.cancel(order)
