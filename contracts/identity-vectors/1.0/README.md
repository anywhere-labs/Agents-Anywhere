# identity-vectors 1.0

v2 Connector 生成的各种标识的**金标准测试向量**（输入 → 输出）。v3 用 TypeScript 重写 Connector（`connector-ts/`）时，这些标识必须与 v2 Python **逐字节一致**，否则旧会话会变成新会话、已有 Timeline 条目会重复、已保存的模型/权限选择会失效（`docs/v3/01-goals-and-principles.md` §4.6）。

**规则：任何实现（目前是 `connector-ts/src/domain/identity/`）必须 100% 通过 `vectors.json` 中的全部向量。** 不允许跳过某一类，也不允许为了让实现通过而修改向量。

## 生成

```sh
cd connector && uv run python scripts/export_identity_vectors.py          # 重新生成
cd connector && uv run python scripts/export_identity_vectors.py --check  # 文件与当前 v2 代码不一致时失败
```

- 脚本直接调用 v2 的真实函数（`connector/` 下的 Python；DSH 插件算法通过 Node `--experimental-strip-types` 运行 `dsh-bridge-next/src/host/dsh-runtime/identity.ts`），不重写算法。规则写在大方法内部的，用最小替身驱动那个方法（例如 `AcpRuntime.list_sessions`、`Projection.apply`、Pi `timeline()`）。唯一例外是 `session.piNativeSessionId`：规则内联在扫描磁盘的 `scan()` 里，向量用真实的 `fingerprint()` 拼出，类别上标了 `"composed": true`。
- 需要 Node ≥ 22.6（用于运行插件的 `.ts` 源码）。
- 输出是确定的，不含时间戳；`generator` 字段记录生成时的 Python 与 Unicode 数据库版本。

验证 TS 实现：

```sh
cd connector-ts && corepack yarn install && corepack yarn test
```

## 文件格式

`vectors.json` 只含 ASCII（非 ASCII 字符一律 `\uXXXX` 转义，避免不可见字符和孤立代理项产生歧义），每条向量占一行：

```json
{"name": "可选说明", "input": {...}, "output": <期望输出>}
{"input": {...}, "error": "ValueError"}
```

- `output`：期望的返回值（字符串、对象、数组、布尔或 `null`）。
- `error`：v2 对这个输入抛出的异常类名。实现必须拒绝该输入（抛错），而不是生成别的标识。
- 每个类别有 `source`（v2 中的位置）和 `description`（规则摘要），至少 20 条向量，覆盖空字符串、Unicode/emoji、组合字符、超长输入、含 `\0`、冒号、斜杠、反斜杠的输入。

## 覆盖的规则

| 类别 | 条数 | v2 位置 | 规则 |
| --- | ---: | --- | --- |
| `session.stableRuntimeSessionId` | 47 | `runtimes/session_identity.py` | `sess_{runtime}_{sha256(connectorId:runtime:ext)[:24]}`；任一分量为空抛错 |
| `session.codexStableSessionId` | 59 | `runtimes/codex/domain/sessions.py` | 上式，runtime=`codex`，第一个参数是 namespace |
| `session.claudeStableSessionId` | 59 | `runtimes/claude/domain/session.py` | 同上，runtime=`claude` |
| `session.namespace` | 23 | `runtime_protocol/instance_binding.py` `session_namespace` | 旧兼容实例（runtimeId == runtimeType）= connectorId，忽略 source key；具名实例 = `connectorId:runtimeType:runtimeId[:sourceKeyDigest]`；source key 含控制字符或空白抛错 |
| `session.sourceKeyDigest` | 31 | 同上 `_source_key_digest` | `sha256(kind + "\0" + key)[:24]` |
| `session.filesystemResourceKey` | 40 | `runtime_protocol/filesystem.py` | 输入是 `canonical_path()` 的结果；darwin：`NFC(casefold(path))`；linux：原样 |
| `session.sourceKey` | 44 | `dsh/provider.py`、`codex/provider.py` `session_source_key` | DSH：`dsh_bridge_endpoint` + `<dshHome>/agents-anywhere/bridge/endpoint.json`（1.x 插件的 endpoint 路径，只作身份）；Codex：`codex_home` + `<codexHome>` |
| `session.dshEndToEnd` | 20 | Connector namespace + 插件 `sessionId` | 从 connectorId、实例、dshHome、平台到最终 `sess_dsh_…` |
| `session.acpNativeInventoryId` | 22 | `acp/runtime.py` `list_sessions` | 未绑定的 ACP 原生会话：`acp_native_` + `fingerprint([runtimeId, nativeSessionId])[:40]` |
| `session.piNativeSessionId` | 30 | `acp/profiles/pi/native_runtime.py` `scan` | 未绑定的 Pi 原生历史：`pi_native_` + `fingerprint([runtimeId, path, headerId])[:40]` |
| `storage.acpRuntimeRoot` | 24 | `acp/composition.py` `runtime_root` | ACP 实例私有状态目录名：`sha256(namespace + ":" + runtimeId)` |
| `selection.protocolSelectionId` | 49 | `server/protocol.py` `protocol_selection_id` | `sel_{type}_{base64url(sha256("1:runtime:type:" + canonicalJson))[:24]}` |
| `selection.customModelSelectionId` | 24 | `runtimes/custom_models.py` | codex 用 `{model_id, reasoning_id}`，其他用 `{model_id[, effort_id]}` |
| `selection.claudePermissionSelectionId` | 22 | `claude/domain/permissions.py` | `{permission_id}` |
| `selection.dshModelSelectionId` | 20 | `dsh/identity.py` | `dsh:model:` + base64url(无填充) JSON 数组 |
| `selection.dshPermissionSelectionId` | 22 | `dsh/identity.py` | `dsh:permission:` + base64url(无填充) |
| `selection.catalogs` | 62 | `codex/domain/catalogs.py`、`claude/domain/{models,permissions}.py` | 内置目录真实产出的选择项 id（Codex 权限用目录里的 `identity` 对象 `{permission_mode}`；有推理档位的 Codex 模型本身没有 id） |
| `selection.acpSelectionId` | 20 | `acp/domain/catalogs.py` | `acp-selection:` + base64url(**有** `=` 填充)，JSON 用默认 `ensure_ascii=True` |
| `timeline.codexClientMessageItemId` | 20 | `codex/timeline/identity.py` | `codex-client-message-v1` |
| `timeline.codexTurnPositionItemId` | 21 | 同上 | `codex-turn-item-v2`：ext、turn、lane、position |
| `timeline.codexTurnItemLane` | 98 | 同上 | lane、是否用 turn 位置身份、是否是用户消息 |
| `timeline.codexNextTurnLanePosition` | 20 | 同上 | 回合内各 lane 的位置计数；reasoning 共用 assistant-message 的位置 |
| `timeline.codexDerivedKeyFromValues` | 20 | 同上 | 无原生 id 时的派生 key（`_safe_component`） |
| `timeline.codexTimelineItemIdFromValues` | 20 | 同上 | client message > 原生 id > `codex_{ext}_{derivedKey}` |
| `timeline.codexTimelineItemId` | 52 | 同上 | 原始 dict 版本（字段别名、Python 真值链） |
| `timeline.codexAsyncInputIds` | 20 | `codex/domain/input_requests.py` | 异步提问的 notice / client message / timeline 条目 id |
| `timeline.claudeMessageAndToolItemId` | 30 | `claude/timeline/messages.py` | `claude_msg_` / `claude_tool_`，scope = externalSessionId 或 sessionId |
| `timeline.claudeSystemItemId` | 20 | 同上 | `claude_system_` |
| `timeline.claudeStableId` | 20 | 同上 `_stable_id` | 消息兜底与 API 重试条目 |
| `timeline.claudeHistoryTurnId` | 20 | `claude/sessions/reader.py` | 历史回合 `turn_claude_…` |
| `timeline.acpProjectionItemId` | 44 | `acp/infrastructure/projection.py` | 按更新序列驱动：已验证的 `_meta.aa.timelineItem` 优先（旧 revision 返回 null）；已验证的 messageId/toolCallId 稳定；否则按连接 epoch 和消息序号 |
| `timeline.piHistoryItemId` | 32 | `acp/profiles/pi/history.py` `timeline` | `fingerprint([sessionId, "pi", entryId 或 legacy:index:fingerprint(entry), suffix])` |
| `timeline.dshTimelineItemId` | 20 | `dsh/identity.py` | `dsh_` + `sha256(ext\0kind\0businessId)`；空分量抛错 |
| `dshPlugin.sessionId` | 44 | `dsh-bridge-next/.../identity.ts` | `sess_dsh_…`；AA 创建的会话（`aa_{sha256(namespace)[:16]}_{platformId}`）直接还原平台 id |
| `dshPlugin.nativeSessionId` | 30 | 同上 | AA 创建 DSH 会话时的原生 id |
| `dshPlugin.userMessageId` | 25 | 同上 | `aa.{sha256(ext)[:16]}.{base64url(clientMessageId)}` |
| `dshPlugin.clientMessageId` | 36 | 同上 | 上式的严格逆运算 |
| `dshPlugin.itemId` | 20 | 同上 | 与 `timeline.dshTimelineItemId` 同算法，但接受空分量 |
| `planning.stableId` | 20 | `planning/domain/session.py` | `plan_` / `draft_` / `review_` + `sha256("\0".join(parts))[:32]` |
| `unicode.casefold` | 1575 | Python `str.casefold` | 所有会被折叠的码位及样例字符串（darwin 路径身份依赖它） |
| `unicode.isalnum` | 170 | Python `str.isalnum` | Codex `_safe_component` 依赖它 |
| `unicode.nfc` | 20 | `unicodedata.normalize("NFC")` | darwin 路径身份依赖它 |

共 42 类、3015 条。

## canonical JSON（`sort_keys=True, separators=(",", ":")`）

多条规则对 JSON 取哈希，实现必须复现 Python `json.dumps` 的输出：

- 键按 **Unicode 码位**排序（不是 UTF-16 码元；`"￿"` 排在 `"😀"` 前面）。
- 字符串转义：`\" \\ \n \r \t \b \f`，其余 `< 0x20` 用小写 `\u00xx`；`ensure_ascii=False` 时其他字符原样输出（含 U+007F、U+2028）；`ensure_ascii=True` 时所有非 ASCII 码元和 U+007F 转义，astral 字符写成代理对。
- 数字：JavaScript 中整数值且绝对值 `< 1e21` 的按 Python `int` 输出数字；其余按 Python `float.__repr__`（指数小于 -4 或不小于 16 时用 `1e-05`、`1e+21` 这样的形式）。

## 已知限制（实现时要注意）

- **整数值浮点数无法复现**：Python 的 `1.0`、`1e16` 经 JSON 传到 JavaScript 后与整数 `1`、`10000000000000000` 无法区分；超过 2^53 的 Python 整数在 JavaScript 中会丢精度。向量刻意不包含这类输入，生成脚本会断言。v2 实际传入这些规则的标识对象只含字符串、`null` 和小整数。
- **孤立代理项**：Python 在 UTF-8 编码时抛 `UnicodeEncodeError`，TS 实现也必须抛错；DSH 插件运行在 Node 里，会把孤立代理项按 U+FFFD 哈希，插件类算法保留这一行为。向量不含孤立代理项。
- **Unicode 版本**：`casefold`、`isalnum`、NFC 的结果取决于 Python 自带的 Unicode 数据库。本文件由 Python 3.14（Unicode 16.0）生成；Desktop 内置 Python 3.12（Unicode 15.0），命令行用户可能用 3.13（15.1）。只有在较新 Unicode 版本中新增的字符上会出现差异；Node 22 的 ICU 已是 Unicode 17，测试对少数 Unicode 17 新增的大小写对做了显式豁免。
- **Windows 路径**：`canonical_path()` 在 Windows 上通过 `LCMapStringEx` 转小写，需要真实系统调用，不在本向量范围内；`filesystem_resource_key` 在 Windows 上对已规范化的路径不再变换。
- **不覆盖的标识**（没有可复现的确定性规则）：ACP 经 AA 创建的会话 id（由 Server 预留后下发）；Claude 运行中回合 `turn_claude_<随机>`；Claude 工具块缺少原生 id 时的 `_stable_id("tool", repr(block))`（依赖 Python 对象的 `repr`）；ACP 连接 epoch（`uuid4`）；Pi `bash-<uuid4>` 工具 id。
- 审批、提问等 notice id（Codex `sdk_approval_request_id`、Claude `_stable_approval_id` 等）只在 Runtime 生命周期内有效，未纳入本版本。

## 变更规则

- 已发布的向量只能新增，不能修改输出。v2 算法变了（即使是 bug 修复），要么证明旧输出不再出现在任何存量数据里，要么新建 `identity-vectors/1.1/` 并在 v3 中同时支持新旧两种规则。
- 修改 `connector/` 中任何被引用的函数后，运行 `--check`；不一致说明修改破坏了身份兼容性。
