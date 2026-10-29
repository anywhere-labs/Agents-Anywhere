from ..domain.definitions import AcpError
from .pi import PI_PROFILE

PROFILES = {PI_PROFILE.id: PI_PROFILE}


def get_profile(key: str):
    if key not in PROFILES:
        raise AcpError("unknown_agent_profile", "Agent 类型未登记。")
    return PROFILES[key]
