from ...domain.definitions import AcpError


def require_enabled(enabled: bool = False) -> None:
    # V2 insertion ACK and foreground completion must never use v1 semantics.
    raise AcpError("acp_v2_not_enabled", "ACP v2 尚未通过独立生命周期验收。")
