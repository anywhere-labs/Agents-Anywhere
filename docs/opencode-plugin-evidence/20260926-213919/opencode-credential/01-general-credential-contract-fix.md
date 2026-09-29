<!-- tm_board_write · 2026-09-27T02:52:14.296Z · role=general · session=20260926-213919 -->
# AA OpenCode 插件 · 设备凭据契约级修复（opencode-credential）

## STATUS
完成并全绿：corepack yarn check exit 0（typecheck + check:build + build + 312 tests / 310 pass / 2 skip / 0 fail）。
只改 opencode-plugin/**（含 lib/** 构建产物）；未动 connector/**、server/**、web-next/**；未杀任何进程。

## 根因（file:line）
1. 服务端会轮换 token，触发条件有两个：
   - server/agent_server/infra/repositories/connectors.py:224-262 — 设备 id 是 conn_<sha256(user:installationId)[:24]>；同一 installationId 再注册撞唯一键时走 rotate_connector_token（256-261），token 换、id/created_at 不变。
   - connectors.py:541-569 — POST /connectors/{id}/revoke 也轮换 token（DSH 的「恢复/renew」语义，见 dsh-bridge-next/src/host/account/binding.ts:36-49,102-132）。
   - 真机证据：conn_958d752319c15b3a840696e4 created_at 21:52:59 / updated_at 21:54:22（同一行两次写）；本地 token cxt_L_QNcZHp…（sha256[:16]=016d1d78b9f6b619）≠ 服务端 token_prefix/token_hash；且 owner.json.blocked 记录 desktop-workbench（pid 24080）也在操作同一设备 → 另一宿主 renew→revoke 轮换，是本机的直接来源之一。
2. 插件（基线 HEAD）把「设备存在」当「凭据有效」：
   - onboarding.ts:332-337（旧）— resume() 读到 binding 就直接 spawn，从不校验设备 token。
   - onboarding.ts:560（旧）— 用 GET /connectors/{id}（账号 token 鉴权）证明设备行存在，证明不了 connectorToken；轮换完全不可见 → 旧 token 永远写进 connector/connector.json → Connector Authorization: Connector <id>:<token> 被 401（服务端 connector_ingress.py:409-416 是唯一校验点）。
   - onboarding.ts:573→585（旧）— 先 POST 再落盘 installationId；响应丢失/并发登录会换新 key 重建，同 key 再注册又触发服务端轮换，「最后写盘者」可能是被轮换掉的旧响应 → 本地≠服务端。
3. 401 之后：仅 supervisor 一条 warn（connector-supervisor.ts:575-593）；login.json 仍是 connected；status() 仍报 Connector 运行中 → 用户只看到 offline（静默）。
4. 自锁：跨进程 adopt（owner.json 指到我方 child）时不会重写 connector.json，运行中的 Connector 永远拿着旧 token。

## 修法
- 校验：src/server/account-api.ts:213 verifyConnectorToken → POST /api/v2/connector/auth（Connector <id>:<token>；200=true，401/403=false，其它抛错=不确定，不确定绝不轮换）。
- 自愈：src/server/onboarding.ts:661 #ensureBinding（跨进程锁内重新读盘）→ 有效复用；401 → #rotateBinding:721（revoke 同一设备，以服务端返回为准原子落盘）；404/设备没了 → #registerBinding:756 + #registerOnce:788。
- 幂等/竞态：新增 src/shared/file-lock.ts:48 withFileLock（跨进程锁；等待超时继续但落盘仍原子）；credentials.ts:312-341 pending.json（注册前持久化 installationId；丢响应重试同一设备，409 才显式换新 key）。
- 失败可见：onboarding.ts:818 #handleSupervisorState → warn + login.json status=failed（含「下一步」）+ status().credentialProblem；command-flows.ts:189 在 /aa-status 输出；有界自动修复 #healAfterAuthFailure:849（最多 2 次，轮换+重启，成功写回 connected）。
- adopt 自锁：onboarding.ts:896 #connectorConfigToken + :923-937 —— 我方 orphan 的 connector.json token ≠ 当前 binding 时，先停自己的 child（stopOwnConnector 可注入，测试不杀真 pid）再用当前 token 启动。
- 构建韧性：scripts/bundle-connector.ts:92 clearTarget —— 运行中的 Connector 锁住 lib/connector/.venv（Windows EBUSY）时原地覆盖三个运行目录，不再让 yarn build/check 假失败。

## 测试（新增/扩展，均注入假服务端/假 supervisor，不真登录、不真 spawn）
- tests/integration/onboarding-credential.test.ts（6）：自愈（stale→rotate 且 connector 拿到新 token）；并发/重载（两实例 resume 只轮换一次、盘=服务端）；注册幂等（两并发 login 只注册一个设备、0 轮换）；失败可见（不可修复 401 → log+login.json+status）；401 后自愈（authFailed → 轮换+重启）；adopt（旧 token orphan → 停+重启）。
- tests/unit/file-lock.test.ts（4）；tests/unit/account-api.test.ts（3）；credentials.test.ts pending key；commands.test.ts /aa-status 凭据行。

## EVIDENCE（corepack yarn check，2026-09-27）
- 构建产物检查通过：入口/files 完整、lib/ 与重构建逐字节一致、两入口可加载。
- ✔ adopt: a Connector adopted from an earlier process with an old token is stopped and restarted
- ✔ 自愈: a stale device token is rotated before the Connector starts (server response wins)
- ✔ 并发/重载: two instances resuming together rotate exactly once and agree with the server
- ✔ 注册幂等: two concurrent logins register one device and rotate nothing
- ✔ 失败可见: an unrepairable 401 reaches the log, login.json and status() with a next step
- ✔ 401 后自愈: a Connector-reported auth failure is repaired and restarted with the new token
- ✔ verifyConnectorToken ×3 / withFileLock ×4 / aa-status names a rejected device credential
- ℹ tests 312 · pass 310 · fail 0 · skipped 2

## HANDOFF（真机核对步骤）
1. 记录现状：select id, token_prefix, left(token_hash,16) from connectors where id='<connectorId>';
2. 重启 OpenCode（加载新 lib/）。启动日志应出现「设备凭据已轮换，并按服务端返回值原子落盘」或「设备凭据已自动修复，正在用新凭据重启 Connector」。
3. 一致性：本地 ~/.agents-anywhere/opencode-plugin/bindings/<serverKey>/<acct>.json 的 connectorToken sha256[:16] == DB token_hash[:16]；且 connector/connector.json 的 connectorToken == binding 的。
4. online：20s 心跳后再查 DB，status 应为 online、last_seen_at 更新。
5. 失败演练：用账号 token 调 POST /api/v2/connectors/{id}/revoke（或直接改 token_hash）→ 运行中的 Connector 401 → 插件应 warn + login.json failed（含 /aa-login 下一步）；服务端可达时应自动轮换并重启。

## 未验证 / 边界
- 真机端到端（未重启 lead 的 OpenCode、未写 DB）。
- 两个真实 OS 进程同时抢锁（锁+原子写已测单进程并发；跨进程仅设计保证）。
- 真实 Connector 的 401 通知（按 supervisor 实际 connector/state 形态精确模拟，未诱发真 401）。
- stopOwnConnector 的真实 kill（仅测注入 seam；本任务未杀任何进程）。
- 其它宿主（Desktop/DSH）并发轮换无法由本插件阻止；插件侧下一次校验即自愈。
- 工作树里 bridge-hub.ts / handshake.test.ts / bridge-client.ts / README 的改动是并发编辑者的，不是本任务产物（本次 check 时它们为绿）。