# 模块边界与依赖规则

## 依赖图

```
entry (HAP, 应用壳)
 ├─ session (HSP, 会话/时间线/登录)
 ├─ terminal (HSP, 终端)
 ├─ files (HSP, 文件)
 │    ├── terminal/files 复用 session 的会话态与共享组件（SharedApiClient、StateViews 等）
 │    └── 三者均依赖：
 │         network (HAR, API/DTO/Realtime)
 │           └── common (HAR, 设计令牌/工具/共享资源)
```

依赖方向自上而下单向：`common ← network ← session ← terminal/files ← entry`。

## 模块职责

| 模块 | 职责 | 内容 |
| --- | --- | --- |
| `common` | 基础层，零依赖 | ColorTokens/TypeTokens/AppearanceSettings、LanguageSettings、Json/ApiException/ApiUrls 等纯工具、FileViewSupport 等零网络依赖共享组件、跨模块共享的 string/media 资源 |
| `network` | 网络层 | ApiClient、AuthApi/SessionsApi/DevicesApi/FilesApi/TerminalApi/RealtimeApi/AnnouncementsApi/AppUpdatesApi、各 DTO、RealtimeWebSocket |
| `session` | 会话域 | AuthSessionStore/LoginServer(PKCE)、会话域 store、SharedApiClient、会话/时间线页面与组件、DiffCodeView、被多域复用的共享组件（ConfirmDialog/StateViews 等） |
| `terminal` | 终端域 | TerminalEmulator、TerminalRender、终端页 |
| `files` | 文件域 | 文件浏览页、Agent 文件页、FileRowMenuOverlay |
| `entry` | 应用壳 | EntryAbility、tab 壳（Index）、设备域页面、跨域共享组件、router_map 聚合、entry 级资源 |

## 归属判定规则

1. 域专属代码（页面、组件、store、资源）随所属域模块走。
2. 被 ≥2 个域引用的组件：零网络依赖的上移 `common`，有网络依赖的上移 `session`（主域）；`entry` 只保留应用壳级组件（AnnouncementGateOverlay 等）。HSP 页面无法引用 entry（HAP）内的代码。
3. 出现 A→B→A 循环时，把粘合层上移到两者的共同上游模块（历史案例：`SharedApiClient` 依赖 `AuthSessionStore`，随 session 域上移；`TimelineSummaries` 等 DTO 消费文件不进 common）。
4. HSP 模块自带各自 `router_map.json`，由 entry 聚合；页面跳转统一 `pushPathByName`，不感知目标页面所在模块。
