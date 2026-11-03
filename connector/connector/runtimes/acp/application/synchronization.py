from __future__ import annotations

import asyncio


def _is_permanent_rejection(exc: Exception) -> bool:
    """永久拒绝（服务端明确不收）——重试无意义，应跳过毒通知。

    ConnectorIngestRejectedError：HTTP 200 但响应内逐条拒收；
    httpx.HTTPStatusError：HTTP 4xx（401/408/429 已被更低层转换为
    认证/网络错误），同样重试无望。"""
    from connector.server.ingest import ConnectorIngestRejectedError

    import httpx

    return isinstance(exc, (ConnectorIngestRejectedError, httpx.HTTPStatusError))


class SynchronizationService:
    def __init__(self, store, publish):
        self.store, self.publish = store, publish
        self.lock = asyncio.Lock()
        self.stopping = False
        self.task = None
        self.last_error: str | None = None

    def start(self):
        self.task = asyncio.create_task(self.run())

    async def flush(self):
        async with self.lock:
            while rows := self.store.pending():
                try:
                    await self.publish([value for _, _, value in rows])
                except Exception as exc:  # noqa: BLE001 -- 分类后再决定重试或跳过
                    if not _is_permanent_rejection(exc):
                        raise
                    # 毒通知会永久卡死整批（服务端按批拒绝）：二分定位并
                    # 丢弃毒条，其余通知照常投递。否则 outbox 只涨不排，
                    # 最终 sync_backpressure 拒发一切新消息（2026-11-03 事故）。
                    await self._drop_poison(rows)
                    continue
                with self.store.transaction():
                    self.store.acknowledge([key for _, key, _ in rows])

    async def _drop_poison(self, rows) -> None:
        stack = [rows]
        while stack:
            chunk = stack.pop()
            if not chunk:
                continue
            try:
                await self.publish([value for _, _, value in chunk])
            except Exception as exc:  # noqa: BLE001 -- 继续二分缩小范围
                if not _is_permanent_rejection(exc):
                    raise
                if len(chunk) == 1:
                    key, value = chunk[0][1], chunk[0][2]
                    method = value.get("method") if isinstance(value, dict) else None
                    params = value.get("params") if isinstance(value, dict) else {}
                    session_id = params.get("sessionId") if isinstance(params, dict) else None
                    from connector.logging import logger

                    logger.warning(
                        "sync dropped poison notification method={} session={}",
                        method, session_id,
                    )
                    with self.store.transaction():
                        self.store.acknowledge([key])
                    continue
                mid = len(chunk) // 2
                stack.append(chunk[mid:])
                stack.append(chunk[:mid])
                continue
            with self.store.transaction():
                self.store.acknowledge([key for _, key, _ in chunk])

    async def run(self):
        while not self.stopping:
            try:
                await self.flush()
                self.last_error = None
            except Exception as error:  # noqa: BLE001 -- durable queue retains all unacknowledged facts
                self.last_error = type(error).__name__
            await asyncio.sleep(0.1 if self.last_error is None else 1)

    async def close(self):
        self.stopping = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
