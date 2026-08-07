from __future__ import annotations


class RuntimeOrderAllocator:
    def __init__(self, start: int = 1) -> None:
        self._order_by_id: dict[str, int] = {}
        self._next_order = start

    def order_for(self, item_id: str) -> int:
        order = self._order_by_id.get(item_id)
        if order is None:
            order = self._next_order
            self._next_order += 1
            self._order_by_id[item_id] = order
        return order
