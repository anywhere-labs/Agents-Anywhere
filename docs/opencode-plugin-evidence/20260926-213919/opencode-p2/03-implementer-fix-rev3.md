<!-- tm_board_write · 2026-09-26T17:47:28.539Z · role=implementer · session=20260926-213919 -->
# OpenCode P2 Connector — rev3 契约裁定修复交付

> 范围：connector/connector/runtimes/opencode/** + connector/tests/test_opencode_*.py（未改契约层/其它 runtime/插件/server）
> 基线（改前）：三文件 21 passed；全量 tests 23 failed / 839 passed。
> 改后：三文件 36 passed；全量 tests 23 failed / 853 passed（失败集与基线逐条一致，无新增）。

## 1. 缺陷闭包表

| 编号 | 修法 | 文件:行 | 对应新增/相关测试 |
|---|---|---|---|
| M1 | items 逐项 try/except ValueError → skip+计数+continue；notifications 逐条 try → skip+计数；skippedItemCount 为 Connector 自持计数器，commit 时经 host.timeline_sync(metadata={syncDiagnostics:{skippedEventCount(null/透传),skippedItemCount,updatedAt}}) 上报 | bridge/sync.py:192-277 | test_malformed_items_are_skipped_counted_and_do_not_lose_the_page；test_notification_page_forwards_platform_notifications |
| M2 | client initialize 新增 location；runtime 传 values[location] 且缺则 start() 拒绝(fail-closed→runtime_unavailable)；select_endpoint 对「已配置 location 而端点 locations 为空/不含」拒绝返回 None（按 location.directory 规范化匹配） | bridge/client.py:57/105-114；runtime.py:289-307；discovery.py:155-190 | test_runtime_requires_a_location_and_fails_closed；test_select_endpoint_rejects_unlisted_or_empty_location；test_bridge_client_handshake...(断言 initialize 携带 location=/repo) |
| M4 | 三态握手 LIVE/STALE/KEEP；仅 D1(不可解析)/D2(连接被拒且 pid 非存活)/D3(协议主版本/身份不匹配) 删除；K1 超时只记 debug 保留，K2 瞬时 IO 保留；runtime 侧改用 discard_if_stale 做同样判定 | discovery.py:213-380（probe/_handshake/endpoint_is_stale/_pid_alive） | test_probe_keeps_endpoint_file_on_handshake_timeout；test_endpoint_is_stale_only_for_definitive_failures；test_probe_handshakes_live_endpoints_and_cleans_invalid_files |
| M5 | SyncRelay.subscribe 新增 historyHash(64hex) 写入 params；resynchronize 从 read_checkpoint 取 historyHash 与 fromSeq 同发 | bridge/sync.py:139-156；runtime.py:78-88 | test_subscribe_reports_history_hash_and_records_session |
| m1 | _checkpoint 改用 value.get(key)，缺 historyHash 键不再 KeyError | bridge/sync.py:47 | test_checkpoint_tolerates_a_missing_history_hash_key |
| m2 | _read_frames 对空行/keepalive continue（EOF 仍 return，避免死循环） | bridge/client.py:222-229 | test_bridge_client_survives_blank_keepalive_lines |
| m3 | 新增常量 CAPABILITY_SESSION_DISCOVERY=session.discovery；sessionDiscovery 由能力位派生，不再硬编码 True；metadata.discoveryState 经 RuntimeCapability.metadata 自动透传（Hub 侧填充） | provider_config.py:19-21/135-137 | test_session_discovery_capability_is_derived_not_hardcoded |
| m4 | 抽出 _sync_mode_from(result)，features 缺失/null/非 Mapping 一律退化为 polling | runtime.py:_sync_mode_from/375 | test_sync_mode_defaults_when_features_are_absent_or_null |
| m5 | 新增 _decode(decoder,*a,**kw) 把解码 ValueError 包装为 RuntimeUpstreamError；读路径 7 处解码点全部接入 | runtime.py:_decode 及 get_runtime_capabilities/list_*/snapshot/state/notices | test_read_path_wraps_decode_failures_as_upstream_errors |
| m6 | select_endpoint 候选按 (startedAt,pid,port) 降序，取代字典序任取 | discovery.py:176-189 | test_select_endpoint_prefers_the_most_recently_started |
| n3 | accept QueueFull → logger.warning + dropped_batch_count++ + restart()（触发重订阅，不再静默丢批） | bridge/sync.py:83-105 | test_queue_full_is_counted_and_forces_resync |
| n4 | run() 任何内部恢复后调用 _resubscribe()（逐会话 read_checkpoint→subscribe(fromSeq,historyHash)）重订阅并重校准 | bridge/sync.py:301-345 | test_recovery_resubscribes_with_persisted_hash |
| §6③ | _write_checkpoint 注释显式写明 throughSeq 语义由 Hub 保证、Connector 逐字持久化不推导 | bridge/sync.py:230-235 | 注释项（无测试） |
| 测试质量 | fake_host 改用 unittest.mock.create_autospec(RuntimeHostClient, instance=True)：错关键字/缺参数会 TypeError（已实测验证），消除签名假绿 | tests/test_opencode_live_transport.py:38-47 | 已验证 create_autospec 对 timeline_sync(bogus=1) 抛 TypeError |
| 协议主版本覆盖 | 补 identity.protocolVersion=2.0 路径 | — | test_bridge_client_rejects_incompatible_protocol_major |

固定字段名均未改名：location / historyHash / session.discovery / discoveryState / skippedEventCount / skippedItemCount / syncDiagnostics。

## 2. 验收原始证据

### 2.1 目标三文件
```
cd connector; uv run pytest tests/test_opencode_provider.py tests/test_opencode_bridge_client.py tests/test_opencode_live_transport.py -q -p no:cacheprovider
....................................                                     [100%]
36 passed in 4.70s
```

### 2.2 全量 tests（不得高于 23 基线）
```
cd connector; uv run pytest tests -q -p no:cacheprovider
23 failed, 853 passed, 3 skipped, 1 warning in 56.70s
```
失败集与改前基线 Compare-Object：baseline=23 after=23，only-in-after=∅，only-in-baseline=∅（逐条一致）。
新增通过：全量 passed 839→853。

### 2.3 ruff
```
cd connector; uv run ruff check connector/runtimes/opencode tests/test_opencode_provider.py tests/test_opencode_bridge_client.py tests/test_opencode_live_transport.py --output-format concise --no-cache
All checks passed!
```

## 3. 判定与遗留假设
1. models.py 未改：rev3 §4.1 的修法原文即「models.py 校验返回失败 → SyncRelay 跳过并计数」，示例代码为 sync.py 内 except ValueError。故 models.py 保留抛 ValueError 作为解码失败信号，由 SyncRelay 捕获——符合裁定本意，未放宽为返回 None 以免丢失可诊断性。
2. 读路径仍 fail-loud：宽容跳过仅用于 Hub 推流（sync.batch items/notifications）；平台显式读请求（getSnapshot/getState/notices）解码失败包装为 RuntimeUpstreamError（m5），不静默丢弃。若评价方认为 §6① 也要求读路径跳过，请指示。
3. D2 本机验证方式：Windows loopback 上「连接不存在端口」实测多为超时（K1）而非拒绝，故 D2/D3 规则用纯单元测试（构造 ConnectionError/死 pid/BridgeProtocolError）确定性覆盖；集成 probe 测试覆盖 D1 删除与 K1 保留。此为用户机实测事实。
4. m3 的 discoveryState：Connector 侧只负责不再硬编码并从能力位派生；metadata.discoveryState/blindSessionCount 的实际填充与 partial→complete 翻转属 Hub（P1）职责，Connector 经 capability_set 原样透传。
5. 未触碰用户 OpenCode 配置/运行进程；未改 runtime_protocol 契约层。
