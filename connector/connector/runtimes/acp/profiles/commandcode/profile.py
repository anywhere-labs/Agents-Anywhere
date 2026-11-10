from ...domain.definitions import AgentProfile

COMMAND_CODE_PERMISSION_MODES = (
    ("default", "标准（写入与命令审批）"),
    ("auto-accept", "自动接受编辑"),
    ("plan", "计划模式（只读）"),
    ("dont-ask", "不询问（保留安全限制）"),
    ("bypass", "跳过所有权限检查"),
)

COMMAND_CODE_PROFILE = AgentProfile(
    id="commandcode",
    title="Command Code",
    runtime_capabilities=("runtime.attachment",),
    permission_options=COMMAND_CODE_PERMISSION_MODES,
)
