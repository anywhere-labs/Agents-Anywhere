# 本机共享记录 v1

> 历史契约，保留供旧版本迁移参考。当前实现使用 [v2 契约](../2.0/README.md)：Python Connector 独占维护运行记录与 ID 历史，Desktop 只写安装信息，插件只读。

Desktop 与 DSH 插件共同读写的本机发现文件。安装位置只由 Desktop 更新，两端均可追加本机设备 ID。用户 token、Connector token 仍保存在各自的私有数据目录。

## 固定路径

两端均使用 `os.userInfo().homedir` 加 `.agentsanywhere/machine.json`。不要使用工作目录、`DSH_HOME`、Electron profile 或硬编码的用户名和 Windows 盘符。目录不存在时由首次写入的一端递归创建。

```json
{
  "version": 1,
  "desktop": {
    "platform": "darwin",
    "appPath": "/Applications/Agents Anywhere.app",
    "executablePath": "/Applications/Agents Anywhere.app/Contents/MacOS/Agents Anywhere",
    "launchArgs": [],
    "packaged": true
  },
  "connectorIds": ["conn_first", "conn_second"]
}
```

`desktop` 可缺省；`connectorIds` 是按首次记录顺序排列、去重后的本机 Connector ID 历史。ID 可以属于不同账号或服务，不能单凭文件内容判断当前用户拥有设备。未来增加字段时，写入者保留不认识的字段；未知版本不覆盖。

## Desktop 写入规则

- 每次主进程启动校验当前实际应用位置与可执行文件权限。已有正确记录不重写；缺失、损坏或安装位置变更才更新。损坏 JSON 先备份再修复。
- 正式 macOS 记录 `.app` 和内部启动文件，Windows 记录真实安装目录及 `.exe`。开发模式同样写入，`packaged: false`，`appPath` 指向 Desktop 项目，`executablePath` 指向 Electron，`launchArgs` 带项目路径。
- 只有本机新设备 `POST /connectors` 成功返回 ID 时追加记录。已有绑定复用、`/revoke` 重连、断开操作和远程设备不追加、不改顺序，也不回填先前已存在的绑定。
- ID 写入失败会阻止本次新设备落地并尝试回滚服务端注册。后续私有绑定保存失败造成的回滚可能留下历史 ID；插件以服务端当前列表为准过滤已删除记录。
- 写入安装位置和 ID 均等待下述跨进程锁，读取与合并发生在获得锁之后；写入完成前不继续设备配对。

## 两端写入与互斥

- 两端只向 `connectorIds` 追加新 ID，已存在的 ID 不重复追加、不改顺序、不重写文件；保留 `desktop` 与未知字段。插件不写安装位置，不修复损坏或未知版本的共享记录。
- 互斥覆盖整个读取、合并和原子发布。规范化文件路径为 `realpath(dirname(filePath)) + basename(filePath)`，Windows 转小写；端口为 `49152 + sha256("aa-machine-state-v1\n" + canonicalPath).readUInt16BE(0) % 16384`。
- 两端独占绑定 `127.0.0.1` 上的同一端口作为短期写入锁，不提供 HTTP 或业务接口。占用时每 20ms 重试，5 秒后明确报错；不能绕过锁继续写。进程退出后由操作系统释放，不抢占或删除过期锁文件。
- 临时文件位于同一目录，使用 `0600` 权限，完整写入并 `fsync` 后原子替换目标，再释放锁。两端须一起更新到支持此协议的版本。

## Desktop 配对规则

1. 首次登录自动将本机上线，以及已删除本机设备在重连时重新配对，均先读取有序 ID 历史，再调用当前服务器的 `GET /api/v2/connectors`。
2. 只匹配当前登录账号拥有的设备，按本地记录顺序取第一个交集 ID。匹配成功通过 `/connectors/{id}/revoke` 换新 token，保留原设备名称和 Agent 配置；没有匹配才调用 `POST /connectors` 创建新设备并追加 ID。
3. 读取共享记录、获取设备列表或换 token 失败时停止本次配对，允许重试，不降级新建。普通已有设备重连仍直接轮换其 token，不执行创建前的匹配流程。
4. 复用设备时不写共享 ID 历史；本地绑定或凭据保存失败也不删除已有服务端设备。自动删除回滚只适用于本次新创建的设备。

## 插件使用规则

1. 检测安装时优先读本文件；本文件不存在时兼容旧 `.agentsanywhere/desktop/install.json`。记录不可读、损坏或版本未知时报错，不视为未配对。
2. 安装目标存在时继续由 Desktop 管理 Connector；目标已不存在时允许原 Web 流程，同时保留历史 ID。Desktop 协议唤起与专门 onboarding 仍待接入。
3. 在原 Web 流程的 OAuth 回调换取用户 token 后，读取有序 ID 列表，调用当前服务器的 `GET /api/v2/connectors` 获取当前用户设备。
4. 按本地 ID 顺序查找交集，多个匹配只选第一个。兼容旧插件已有的私有绑定，将其 ID 作为最后一个本机候选，避免升级后重复创建。
5. OAuth 后匹配成功即用同一 ID 调用 `POST /api/v2/connectors/{id}/revoke` 换新 Connector token，保留设备及其 Agent 配置。普通恢复流程可复用已验证有效的私有 token。
6. 没有任何本机候选匹配才新建设备，仍使用持久化的 `installationId` 保证丢失注册响应时可恢复。列设备或换 token 失败时停留重试，不降级新建。
7. 新建或恢复成功后，先持久化私有绑定，再将 ID 登记到共享文件，成功后才启动 Connector。恢复旧版私有绑定时，先确认服务端归属和凭据有效，再补登记缺失的 ID；已经登记的 ID 不重写。
8. 共享登记失败时显示错误并保留私有绑定。下次从该绑定恢复，重新验证并补登记，不再次注册、不删除已有设备。共享文件始终不包含用户或 Connector token。
9. 私有凭据交给插件管理的 Connector；确认上线后按原流程进入 Web 的 Agent 快速添加页面。

契约测试使用两端实际读写模块，覆盖并发进程、持锁进程异常退出，以及插件 OAuth 新建后 Desktop 首次配对/已删除设备重连的完整流程。测试中服务端只允许发生一次新建，Desktop 必须复用插件实际登记的 ID。所有测试使用临时主目录，不操作用户的真实共享记录。
