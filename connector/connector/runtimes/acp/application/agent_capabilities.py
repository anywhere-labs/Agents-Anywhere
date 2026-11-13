from __future__ import annotations

from ..domain.definitions import AcpError, PromptRejectedBeforeDispatch


class AgentCapabilities:
    """One application boundary for optional Agent operations, independent of provider."""

    def __init__(self, sessions):
        self.sessions = sessions

    def context(self, session_id: str, external_session_id: str | None = None):
        row = self.sessions.store.require("binding", session_id)
        if (
            external_session_id is not None
            and row["agent_session_id"] != external_session_id
        ):
            raise AcpError("agent_session_mismatch", "原生会话身份不匹配。")
        context = self.sessions.sessions.get(session_id)
        if not context or context["closing"]:
            raise AcpError("agent_recovery_required", "会话执行者需要恢复。")
        return context

    def supported(self, session_id: str, capability_id: str) -> bool:
        context = self.sessions.sessions.get(session_id)
        if not context or context["closing"]:
            return False
        aa = context["client"].capabilities.get("_meta", {}).get("aa", {})
        return capability_id in aa.get("capabilities", [])

    async def invoke(
        self,
        session_id: str,
        capability_id: str,
        method: str,
        values: dict,
        *,
        writable=False,
        external_session_id=None,
    ):
        context = self.context(session_id, external_session_id)
        if not self.supported(session_id, capability_id):
            raise AcpError("agent_capability_unsupported", "Agent 未提供此能力。")
        binding = self.sessions._binding(
            self.sessions.store.require("binding", session_id)
        )
        if writable:
            binding.require_writable()
            if len(self.sessions.active_runs) >= self.sessions.max_runs:
                raise AcpError("run_capacity", "并发执行已达到上限。")
            self.sessions.active_runs.add(session_id)
            with self.sessions.store.transaction():
                self.sessions._save_binding(
                    binding.observe(context["generation"], foreground="running")
                )
        failed = False
        try:
            result = await context["client"].extension(
                method, {**values, "sessionId": context["agentSessionId"]}
            )
            failed = result.get("ok") is False and result.get("executionStarted") is not False
            return result
        except PromptRejectedBeforeDispatch:
            failed = False
            raise
        except BaseException:
            failed = True
            raise
        finally:
            if writable:
                self.sessions.active_runs.discard(session_id)
                with self.sessions.store.transaction():
                    current = self.sessions._binding(
                        self.sessions.store.require("binding", session_id)
                    )
                    if (
                        current.connection_generation == context["generation"]
                        and not context["closing"]
                    ):
                        self.sessions._save_binding(
                            current.observe(
                                context["generation"],
                                foreground="unknown" if failed else "idle",
                                attachment="recovery_required"
                                if failed
                                else "attached",
                            )
                        )
