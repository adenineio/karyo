"""Orders."""


class OrderBook:
    def place(self, sku: str) -> int:
        return len(sku)

    def cancel(self, order: int) -> bool:
        return order > 0
