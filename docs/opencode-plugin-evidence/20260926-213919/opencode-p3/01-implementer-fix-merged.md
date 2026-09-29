<!-- tm_board_write · 2026-09-26T18:46:51.335Z · role=implementer · session=20260926-213919 -->
# P3 合并修复报告 (fix-merged)

## 概述
按 P3 四路验证结论一次性合并修复，全部围绕 Hub 侧（插件包）+ 少量 Connector 侧。
两条发布阻塞级（#1 高危判定 fail-open、#2 通知形状被 AA 拒绝）已闭合。
文件范围：opencode-plugin/src、opencode-plugin/tests、connector/runtimes/opencode、connector/tests/test_opencode_*.py。
未触碰 server/**、web-next/**、runtime_protocol/**、package.json。

## 通知新形状（AA 契约对齐，AA 零改动）
- interactionType: "approval"（原 "permission"，AA InteractionType 不认）
- blocking: { scope: "session", targetId: <平台 sessionId> }（满足 AA NoticeBlocking 强制 scope+targetId）
- context: { permission, requestId, requiresLocalConfirmation, source?, save? }（原 blocking 里的细节移入此处）
- Hub 侧 `#noticeWire()` 把 projector 的 nativeId 改写为平台 sessionId；Connector `NoticeIn` 转发不变。
- 对齐实测类型：desktop-workbench/.../session-snapshot-response.ts:198-236 (NoticeIn/NoticeBlocking)。

## 逐条闭合表
| # | 级别 | 修法 | 断言名 |
|---|------|------|--------|
| 1 | 🔴 | permission-policy.ts:38-77 黑名单→白名单 READ_ONLY_ACTIONS；null/空/未列名=local-only；projector remoteActions 高危→[] | §6⑥ an action outside the read-only allowlist (or missing/empty) stays local-only；test_wire_high_risk_gap_is_closed_by_the_allowlist |
| 2 | 🔴 | projector.ts:434-466 新形状；bridge-hub #noticeWire 重写 targetId | write surface: a permission notice uses the AA shape...；live e2e linked.interaction_type == "approval" |
| 3 | 🟠 | ApprovalRecord.ownerConnectorId + Hub #sessionOwners/#claim(subscribe/create/startTurn) + answer 比对，新码 device_mismatch | §6⑤ a notice bound to one connector device refuses any other device；test_wire_second_device_cannot_answer_another_connections_notice |
| 4 | 🟠 | permission-bridge observe：key 存在即 return，不重开 answered | §6② a re-delivered permission.asked never reopens an answered interaction |
| 5 | 🟠 | bridge-hub #capabilities 用 derived() 按 ctx.session.{create,prompt,interrupt}+permission.reply+attached 派生；metadata.probe='unverified' | write surface: capabilities expose...；bridge-readonly 读流程（已补 install ctx） |
| 6 | 🟠 | protocol.ts CATALOG_METHODS；#onRequest 增 UNSUPPORTED_OPERATION 分支 | write methods fail closed without a host...（新增 catalog.listModels/listPermissions 断言） |
| 7 | Minor | permission-bridge #refuse 审计拒绝（outcome='refused'+reason）；成功在 reply 之后审计（outcome='allowed'/'denied'）；无 token | §6④ every remote answer is audited with an outcome...；§6⑦ every attempt is audited (outcome/reason) |
| 8 | Minor | #startTurn 增 requireString(content) | write surface: createAndStart / startTurn ... reach the host |
| 9 | Minor | runtime.py:_operation_result ok=data.get("ok") is True | test_write_result_without_an_explicit_ok_is_a_failure |
| 10 | Minor | bridge-hub rejectAttachments 显式拒绝；promptOptions 不再透传 | write surface: attachments are refused loudly...；test_attachments_are_refused_loudly_not_dropped |
| 11 | Minor | #updateSelections 返回 ignored[]；runtime.py 复制 ignored 到 result | write surface: unknown selection keys come back in ignored...；test_update_session_selections_reports_applied_and_ignored_keys |
| 12 | Minor | xfail 转正 + 新用例（重复 asked/并发双答/跨连接/未列名/update_selections/附件/replied→resolved） | 见上各行 |

## 验收证据
1. opencode-plugin: typecheck EXIT=0；test tests 78 / pass 78 / fail 0；build EXIT=0。
2. connector: uv run pytest 上述 5 文件 → 56 passed，0 xfail。
3. §6⑥ xfail(test_wire_high_risk_gap_counterexample) 已删除 xfail，转为 test_wire_high_risk_gap_is_closed_by_the_allowlist 直接断言。
4. 恒真断言扫描：opencode-plugin/tests 与 connector 对抗测试无 or True / not False / == True 型恒真。

## 假设与未完成项
- 【假设】§6⑤ 设备绑定：通知的 owner 取自“首个认领会话的连接（subscribe/createAndStart/startTurn）”，首认领生效；无任何连接认领时 owner=null，此时退化为原 location+session 绑定（单测/无订阅 wire 用例保持通过）。生产路径中合法设备在权限产生前已 subscribe/resynchronize，故被绑定。
- 【缺口】来源评审文件 .git/opencode-team/20260926-213919/opencode-p3/（review-correctness/impact/completeness）在本机磁盘不存在（该目录下只有 design/dist/p0/p2/p5/research）；本报告依据 dispatch 内逐条 file:line 与反例执行。
- 未跑全量 pytest（按约束）。
