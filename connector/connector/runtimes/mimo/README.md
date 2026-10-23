# MiMoCode Runtime (Agents Anywhere)

适配 **Xiaomi MiMo Desktop / MiMoCode** 作为 Agents Anywhere 的 Agent Runtime。

## 确认关系

| 组件 | 说明 |
|------|------|
| **MiMoCode** ([XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)) | 终端原生 AI 编码助手；**MiMo Desktop 的核心引擎** |
| 本地 CLI | `mimo` / `npm i -g @mimo-ai/cli`；无头：`mimo run "<prompt>"` |
| 本地库 | `mimocode.db`（OpenCode 血统：session / message / part） |

## 能力

| 能力 | 状态 |
|------|------|
| 会话列表 / Timeline 读取 | ✅ 读 `mimocode.db` |
| 新建会话 / 续聊 | ✅ 调用 `mimo run` |
| 中断 | ⚠️ 状态置 idle（无 PID 级 kill） |
| 模型目录 | ⚠️ `mimo models` 文本解析（尽力） |
| 权限目录 / 交互审批 | ❌ 协议默认 unsupported |

## 配置

| 字段 | 说明 |
|------|------|
| `mimocode_db` | 可选，自定义库路径；默认自动探测 |
| `mimo_bin` | 可选，CLI 路径；或环境变量 `MIMO_BIN` |
| `default_cwd` | 新会话默认工作目录 |

## 接入 Connector

在 `connector/connector/runtimes/providers.py` 注册：

```python
from .mimo import MimoRuntimeProvider

# providers registry
DEFAULT_PROVIDERS = [
    ...,
    MimoRuntimeProvider(),
]
```

或在运行时动态加载本目录 `provider.py`。

## 本机要求

1. 安装 MiMo Desktop 或 `npm i -g @mimo-ai/cli` 并完成登录  
2. 确保存在 `~/.local/share/mimocode/mimocode.db`（Windows 见 `LOCALAPPDATA/mimocode`）  
3. Connector 与 AA Server 配对后，在 Web/桌面端添加 **MiMo** Agent  

## 协议对照

实现对齐 `docs/runtime-protocol/connector-to-runtime.md`（draft v1）：

- `RuntimeProvider`: discover / get_config_schema / validate_config / create_runtime  
- `AgentRuntime`: list_sessions / read_timeline / create_and_start_session / start_turn / get_model_catalog  

未实现的方法由协议基类返回 `RuntimeUnsupportedError` 即可。
