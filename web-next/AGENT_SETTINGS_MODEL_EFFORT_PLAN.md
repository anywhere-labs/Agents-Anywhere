# Agent 设置 Model / Effort 改造说明

这份文档描述新前端如何适配后端这次 agent model / effort 设置体系重构。

核心规则是：`effort` 不再是一个独立的全局目录。`effort` 选项属于具体的 `model`。前端应该从 runtime config schema 里的 `model.options[].efforts` 读取可选 effort，并从 agent defaults 里的 `models[].efforts` 编辑系统默认目录。

## 共享数据规则

先同步前端类型：

- `RuntimeConfigOption` 增加 `efforts?: RuntimeConfigOption[] | null`。
- `AgentCatalogEntry` 增加 `efforts: AgentCatalogEntry[]`。
- `UserAgentDefaultRuntime` 移除顶层 `efforts`。
- `updateAgentDefaults` 的入参应该支持 `models`，不再发送旧的 `settings` 或 `enabled`。

在 `src/features/dashboard/runtime-config.ts` 增加一个共享 helper：

- 输入：runtime schema fields、当前选中的 model value、当前 effort field。
- 输出：应该显示的 effort field，或者当 effort 应该隐藏时返回 `null`。
- 行为：
  - 从 model field 里找到当前选中的 model option。
  - 如果该 model option 有 `efforts: []`，隐藏 effort 字段。
  - 如果该 model option 有 efforts，用它替换 effort field 的 options。
  - 如果还没有选中 model，则使用第一个带 effort 元数据的 model。
  - 如果 schema 没有嵌套 efforts，只做防崩退化，不承诺旧后端完整可用。

当 model 变化时，必须立刻检查当前 effort 是否还合法。如果不合法，就清空 effort，或者切换到第一个合法 effort。

优先使用 `DropdownMenu` 表达 model / effort 选择。这个场景天然适合二级菜单：一级入口显示当前组合，二级菜单按 model 展开，model 下展示它支持的 efforts。除非表单语义明确要求原生选择框，否则不要使用 `Select`。

兼容性边界：

- 新前端以新后端 contract 为准，不维护旧 agent defaults 结构的完整兼容。
- 如果 `model.options[].efforts` 缺失，UI 可以退化为隐藏 effort，或使用 schema 顶层 effort options，目标只是避免页面崩溃。
- 不保留 `filterClaudeEffortField` 这类 Claude 专用兼容逻辑。
- 不再支持顶层 `UserAgentDefaultRuntime.efforts` 编辑。
- 不向 `/agents/defaults` 发送旧 payload 字段。

## Connector Agent 设置

入口：

- `src/components/pages/device-page.tsx`
- 当前弹窗：`AgentConfigDialog`
- 后端 API：
  - `getRuntimeConfigSchema`
  - `getConnectorAgentSettings`
  - `patchConnectorAgentSettings`

这个弹窗用于配置某个 connector agent 的 runtime 默认设置。它是单设备管理入口，所以交互应该保持紧凑。

使用现有标准组件：

- `Dialog`、`DialogContent`、`DialogHeader`、`DialogFooter`
- `FieldSet`、`FieldGroup`、`Field`、`FieldLabel`
- `DropdownMenu`、`DropdownMenuSub`、`DropdownMenuItem`，用于 model、effort 等 enum 字段
- `Checkbox` 或 `Switch`，用于 boolean 字段
- `Button`
- `Alert`，用于保存或加载错误
- `LoadingState`，用于 schema 或 settings 加载中状态

这里不要引入自定义 model picker。当前按 schema 渲染字段的表单结构是对的，只需要把 enum 字段的呈现从旧 select 思路调整为标准 dropdown，并把 effort 过滤逻辑改成 schema-driven。

交互流程：

1. 用户打开设备页，点击某个 attached agent 的设置按钮。
2. 弹窗打开，加载 runtime schema 和这个 connector 已保存的 runtime settings。
3. 表单渲染可配置的 schema fields。
4. model 字段显示为 dropdown。
5. effort 字段根据当前选中的 model 动态生成：
   - 如果该 model 支持 efforts，则在 dropdown 中显示这些 effort。
   - 如果该 model 没有 effort 选项，则完全隐藏 effort 行。
6. 用户切换 model 后，effort 菜单立即更新。
7. 如果旧 effort 不再适用于新 model，表单自动清空它，或者选择第一个合法 effort。
8. 用户点击保存。
9. 前端通过 `patchConnectorAgentSettings` 发送完整 draft settings。
10. 保存成功后关闭弹窗，设备页显示更新后的 effective settings。
11. 保存失败时保持弹窗打开，并在字段上方显示 `Alert`。

重要 UI 细节：

- 隐藏 effort 时不要留下空 label 或空白行。
- effort dropdown 的 label 应该使用后端 schema label，不要硬编码为 "Reasoning" 或 "Claude effort"。
- 保存中禁用保存按钮。
- 表单保持纵向、简单；这里不是目录编辑器。

推荐的 dropdown 结构：

1. 如果只有 model，没有 effort：一个 dropdown 直接列出 models。
2. 如果有 model 和 effort：一个 dropdown 显示当前 `effort · model` 组合。
3. dropdown 内容中，优先把 model 作为 `DropdownMenuSub`。
4. 每个 model 的 submenu 里列出该 model 支持的 efforts。
5. 如果某个 model 没有 efforts，点击该 model 只设置 model，并清空 effort。

## 系统 Agent 设置

入口：

- `src/components/pages/settings-page.tsx`
- 当前 tab：`AgentTab`
- 后端 API：
  - `getAgentDefaults`
  - `updateAgentDefaults`
  - 如果默认权限设置仍然展示在这里，才需要 `getRuntimeConfigSchema`

这个页面用于配置用户全局 agent 目录默认值。它应该编辑 model entries，以及每个 model 下嵌套的 effort entries。

使用现有标准组件：

- `Tabs`，如果页面需要把“默认设置”和“目录管理”拆成多个区域
- `Card` 或带边框的 `section`，用于每个 runtime 分组
- `Table`，用于宽屏下展示 model 行
- `Accordion`，用于展开某个 model 并编辑它下面的 efforts
- `Dialog`，用于新增或编辑 model
- `Dialog`，用于新增或编辑某个 model 下的 effort
- `DropdownMenu`、`DropdownMenuSub`，用于行操作和 model / effort 二级选择
- 带 lucide icon 的 `Button`，用于新增、编辑、删除、上移、下移
- `Input`，用于 key、label、description 字段
- `Checkbox` 或 `RadioGroup`，用于选择默认 model
- `AlertDialog`，用于删除确认
- `Alert`，用于保存或加载错误
- `LoadingState`，用于 defaults 加载中状态

不要发明自定义嵌套拖拽编辑器。排序用小的上移/下移图标按钮即可，这更简单、可预测，也更符合当前管理后台风格。

推荐布局：

1. 先展示一个 runtime 分组，从 Codex 开始。
2. 分组 header 显示 runtime 名称和“添加 model”按钮。
3. 下方渲染 model table。
4. 每个 model 行展示：
   - display label
   - key
   - 如果是默认 model，显示 default badge
   - effort 数量
   - 行操作
5. 展开 model 行后，在 `AccordionContent` 里显示该 model 的 efforts。
6. efforts 区域使用紧凑 table 或纵向列表，展示：
   - display label
   - key
   - 如果使用默认标记，显示 default badge
   - 行操作
   - “添加 effort”按钮

新增 / 编辑 model 流程：

1. 用户点击“添加 model”，或者点击某个 model 行的编辑操作。
2. 打开 dialog，字段包括 key、label、可选 description。
3. 新建 model 时，effort entries 可以先为空，除非后端返回值里已经带了默认 efforts。
4. 用户保存 dialog。
5. 本地 model 列表更新。
6. 页面通过 `updateAgentDefaults` 保存新的 `models` 数组，或者先标记为 dirty，等用户点击页面级保存按钮后再提交。

新增 / 编辑 effort 流程：

1. 用户展开一个 model 行。
2. 用户点击“添加 effort”，或者编辑某个 effort 行。
3. 打开 dialog，字段包括 key、label、可选 description。
4. effort 只保存到当前 model 下。
5. 其他 model 不受影响。

删除流程：

1. 用户从行操作菜单里选择删除。
2. 显示 `AlertDialog`。
3. 用户确认后，从本地 state 删除该 model 或 effort。
4. 持久化更新后的 `models` 数组。
5. 如果被删除的是默认 model，则选择第一个剩余 model 作为默认值，或者在保存前显示校验错误。

排序流程：

1. 每个 model 和 effort 行都有上移 / 下移图标按钮。
2. 点击按钮后，当前项和相邻项交换位置。
3. 保存前，前端根据当前可见顺序重新计算 `sortOrder`。

默认 model 和默认 effort 行为：

- 每个 runtime 应该只有一个默认 model。
- 默认 model 选择可以用 `RadioGroup`，或者用一个会清除其他默认项的单选式操作。
- effort 默认值属于具体 model。如果后端允许 effort 没有默认值，UI 不应该强制选择一个。
- 不要在这个页面展示顶层 effort catalog。efforts 必须出现在所属 model 下面。

保存行为：

- 如果一次可以编辑多个项目，推荐使用页面级“保存更改”按钮。
- 如果使用即时保存，保存中要禁用行操作，并在 runtime 分组附近展示小的保存状态。
- 保存时只发送当前 runtime 的 `models` 数组：

```ts
updateAgentDefaults(token, {
  codex: {
    models: nextModels,
  },
})
```

不要再向这个 endpoint 发送旧的顶层 `efforts`、`settings` 或 `enabled` 字段。

## Composer Model Picker

入口：

- `src/components/session/session-composer.tsx`
- `src/components/task-composer.tsx`

这两处也必须改。原因是 composer 里的 model / effort picker 直接决定新建 session 或当前 session patch 的 runtime settings。如果这里仍然用旧的 Claude 特判，那么用户在 composer 里看到的 effort 选项会和后端 schema、connector 设置、系统设置不一致。

当前情况：

- `session-composer.tsx` 已经使用 `DropdownMenu`、`DropdownMenuSub`、`DropdownMenuSubContent`，这是正确方向。
- `task-composer.tsx` 目前使用 `CascadingSelector` 展示 model / reasoning，也应该改成标准 `DropdownMenu` 二级菜单。
- 两处都还在使用 `filterClaudeEffortField`，需要替换成共享的 schema-driven helper。

推荐交互：

1. composer 底部只保留一个 model / effort 组合按钮。
2. 按钮文字显示当前组合，例如 `Medium · GPT-5.5`。
3. 点击按钮打开 `DropdownMenu`。
4. 一级菜单按 model 展示。
5. 有 efforts 的 model 使用 `DropdownMenuSub`，二级菜单展示该 model 支持的 efforts。
6. 没有 efforts 的 model 直接作为 `DropdownMenuItem`，点击后只设置 model，并清空 effort。
7. 当前选中的 model 和 effort 用 `Check` 图标标记。
8. 切换 model 时，如果当前 effort 不再合法，立即清空或切换到第一个合法 effort。
9. 如果 schema 没有 effort 字段，菜单只显示 models。
10. 如果 schema 没有 model 字段但有 effort 字段，则退化为一个普通 effort dropdown。

`session-composer.tsx` 的保存行为：

- 选择 model 或 effort 后，通过 `onPatchRuntimeSettings` patch 当前 session settings。
- patch payload 必须保持最小：
  - 只切 model：发送 `{ model, effort: undefined 或清空后的值 }`。
  - 只切 effort：发送 `{ effort }`。
  - 切换到无 effort 的 model：发送 `{ model, effort: null 或空值 }`，具体跟现有 API 清空语义保持一致。

`task-composer.tsx` 的保存行为：

- 选择项进入本地 state。
- 创建 session 时，把合法的 `model` 和 `effort` 放进 runtime settings。
- 如果 effort 因 model 切换变成非法，不要把旧 effort 带进 create payload。

视觉要求：

- 不要把 model 和 effort 拆成两个相邻 select。
- 不要新做复杂 cascading 组件；标准 `DropdownMenuSub` 已经足够。
- 菜单宽度固定，长 model label 使用 truncate。
- 二级菜单适合现在的结构：model 是父级，effort 是子级。

## 不应该重新引入的东西

- 不要恢复顶层 effort 编辑器。
- 不要在 UI 里硬编码 Claude model effort 过滤逻辑。
- 不要为了兼容旧 schema 保留 Claude 专用分支；最多做通用防崩退化。
- 当 `DropdownMenu`、`DropdownMenuSub`、`RadioGroup`、`Accordion`、`Dialog`、`Table` 已经覆盖交互时，不要新增自定义选择器。
- 不要优先使用 `Select` 做 model / effort 选择；这里的二级结构更适合 dropdown。
- 不要把 connector runtime settings 和系统目录编辑耦合在一起。Connector 设置负责选择值；系统设置负责定义可选的 model / effort 目录。
