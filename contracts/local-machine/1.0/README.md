# 本机共享记录 v1

Desktop 写入、DSH 插件读取的本机发现文件。它只保存公开的安装位置和设备 ID，用户 token、Connector token 仍保存在各自的私有数据目录。

## 固定路径

两端均使用 `os.userInfo().homedir` 加 `.agentsanywhere/machine.json`。不要使用工作目录、`DSH_HOME`、Electron profile 或硬编码的用户名和 Windows 盘符。目录不存在时由 Desktop 递归创建。

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
- 同步读改写配合 Desktop 单实例锁串行更新；文件写入同目录临时文件并 `fsync`，再原子替换。插件只读，不引入第二个写入者。

## 插件使用规则

1. 检测安装时优先读本文件；本文件不存在时兼容旧 `.agentsanywhere/desktop/install.json`。记录不可读、损坏或版本未知时报错，不视为未配对。
2. 安装目标存在时继续由 Desktop 管理 Connector；目标已不存在时允许原 Web 流程，同时保留历史 ID。Desktop 协议唤起与专门 onboarding 仍待接入。
3. 在原 Web 流程的 OAuth 回调换取用户 token 后，读取有序 ID 列表，调用当前服务器的 `GET /api/v2/connectors` 获取当前用户设备。
4. 按本地 ID 顺序查找交集，多个匹配只选第一个。兼容旧插件已有的私有绑定，将其 ID 作为最后一个本机候选，避免升级后重复创建。
5. OAuth 后匹配成功即用同一 ID 调用 `POST /api/v2/connectors/{id}/revoke` 换新 Connector token，保留设备及其 Agent 配置。普通恢复流程可复用已验证有效的私有 token。
6. 没有任何本机候选匹配才新建设备，仍使用持久化的 `installationId` 保证丢失注册响应时可恢复。列设备或换 token 失败时停留重试，不降级新建。
7. 私有凭据交给插件管理的 Connector；确认上线后按原流程进入 Web 的 Agent 快速添加页面。

契约测试使用 Desktop 实际写入模块生成文件，再由插件读取验证。所有测试使用临时主目录，不操作用户的真实共享记录。
