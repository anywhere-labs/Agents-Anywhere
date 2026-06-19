# Android 架构分层规则

这个 Android 工程采用一套简单的分层结构。规则不要搞复杂，重点是让每个目录的职责稳定、可预期。

## 包职责

```text
com.agentsanywhere.app.api
com.agentsanywhere.app.feature
com.agentsanywhere.app.model
com.agentsanywhere.app.ui
com.agentsanywhere.app.navigation
com.agentsanywhere.app.app
```

### `api`

负责网络请求和后端数据结构。

适合放这里：

- HTTP 客户端和接口封装
- 跟后端 JSON 对应的请求/响应 DTO
- API 相关异常
- JSON 解析辅助函数

不应该放这里：

- Compose UI
- 页面状态
- 面向用户展示的文案，除非是 API 错误兜底文案
- 把数据组合成页面展示内容的业务规则

### `feature`

负责功能层逻辑，也就是“不画 UI，但决定功能怎么运行”的代码。

适合放这里：

- Controller / use case
- 页面状态模型
- 状态更新和 patch helper
- 筛选、排序、分组、派生状态
- 远端 DTO 到 app 内部模型的转换

不应该放这里：

- Compose 函数
- 颜色、间距、字体、动画
- 按钮、弹窗、列表行、snackbar 等 UI 组件

### `model`

负责 app 内部共享的数据模型。

适合放这里：

- 多个 feature 都会用到的数据类
- 稳定的 app 概念，比如 session、device、auth payload、runtime metadata

不应该放这里：

- 只服务某个 API 的 DTO
- 只服务某个 UI 的临时状态
- Compose 相关类型

### `ui`

负责 Compose UI 和视觉交互。

适合放这里：

- screen、row、button、sheet、dialog、snackbar、loading state、empty state
- 只影响视觉表现的 UI 状态，比如某个 section 是否展开
- 颜色、间距、动画、glyph、design system 组件

不应该放这里：

- 网络请求
- 本地持久化
- 应该脱离 Compose 测试的筛选、排序、业务规则
- 后端 DTO 解析

### `navigation`

负责路由和目的地定义。

这个包应该保持很小，不应该知道 API client、controller 或 UI 实现细节。

### `app`

负责应用级组装。

适合放这里：

- 根 Composable
- 依赖组装
- navigation host 编排
- app 级副作用

不应该在这里写具体 feature 的业务规则。

## 依赖方向

推荐依赖方向：

```text
app -> ui
app -> feature
app -> api

ui -> feature
ui -> model
ui -> navigation

feature -> api
feature -> model

api -> model  // 只有模型确实是 app 共享概念时才允许
```

尽量避免这些方向：

```text
api -> feature
api -> ui
feature -> ui
model -> ui
model -> api
```

## 写代码时怎么判断放哪

可以用下面几个问题判断：

- 这段代码是在画界面，或者处理视觉交互吗？放 `ui`。
- 这段代码在决定哪些数据应该展示、怎么筛选、怎么排序吗？放 `feature`。
- 这段代码在请求后端或解析后端 JSON 吗？放 `api`。
- 这是多个功能都会用到的稳定 app 概念吗？放 `model`。
- 这段代码只是把 screen、controller、api 组装起来吗？放 `app`。

## Sessions 功能示例

Sessions 相关代码按下面方式归位：

- `api/SessionsApi.kt`：调用 `/sessions`、`/connectors`，解析远端数据。
- `feature/sessions/SessionsController.kt`：加载、更新 sessions。
- `feature/sessions/SessionsState.kt`：sessions 页面状态和派生状态。
- `feature/sessions/SessionsFilters.kt`：筛选状态、筛选逻辑、筛选选项生成。
- `ui/screens/sessions/*`：Compose 布局、session row、sheet、snackbar、视觉控件。

UI 可以调用 feature helper，但 feature 不能 import Compose，也不能依赖 `ui` 包。
