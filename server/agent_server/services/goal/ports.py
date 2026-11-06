from typing import Any, Protocol


class GoalRepository(Protocol):
    async def read_goal(self, session_id: str) -> dict | None: ...
    async def pending_goal_operation(self, session_id: str) -> str | None: ...
    async def reserve_goal_operation(
        self, session_id: str, request: dict, *, binding: dict | None = None
    ) -> dict | None: ...
    async def replay_goal_operation(
        self, session_id: str, request: dict
    ) -> dict | None: ...
    async def get_goal_operation(
        self, session_id: str, operation_id: str
    ) -> dict | None: ...
    async def mark_goal_dispatched(
        self, session_id: str, operation_id: str
    ) -> None: ...
    async def save_goal_operation(self, session_id: str, result: dict) -> None: ...
    async def save_goal(
        self,
        session_id: str,
        state: dict,
        *,
        connector_id: str,
        reconcile: bool = False,
        operation: dict | None = None,
    ) -> dict: ...
    async def read_uploaded_file(
        self, *, session_id: str, file_id: str, user_id: str
    ) -> dict: ...


class GoalGateway(Protocol):
    async def request(
        self, connector_id: str, method: str, params: dict, *, timeout: float
    ) -> Any: ...
