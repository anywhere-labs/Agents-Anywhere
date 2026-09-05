# 邮箱账号与昵称

本次账号变更以 `v2` 为基线：邮箱是登录标识，`displayName` 是可修改的展示名称，
`userId` 继续作为内部关联键。用户名登录停止支持；不把既有用户名或 OAuth
附带邮箱转换成账号邮箱，不删除旧数据。数据库结构升级只增加账号字段和验证码
存储；未绑定邮箱的旧账号不能通过原用户名重新登录。

管理员在「服务」页配置 Resend API Key、发件地址和验证码开关。开启时，注册、
管理员创建用户和绑定邮箱都要求有效验证码；关闭时按实例管理员的信任策略直接
标记邮箱已验证。验证码不承担密码登录功能，登录仍使用邮箱和密码。

现有 `oauth_accounts.display_name` 仅是第三方身份资料；新用户资料使用
`users.display_name` / API `displayName`。界面称为「昵称」，不引入另一个
`nickname` 字段。首次 OAuth 注册可预填第三方显示名，之后由用户自己维护，
第三方登录不会覆盖已保存的昵称。

验证码需限制发送频率和错误尝试次数，保存摘要、有效期和用途，并与账号写入一起
单次消费。绑定新邮箱成功前保留原邮箱。API Key 只保存在服务端，管理接口只返回
是否已配置，留空保存保留现有 Key。

交付前验证邮箱唯一性、大小写规范化、昵称更新、盐查询与登录一致性、旧用户名
拒绝、验证码过期/重放/限流，以及启用和关闭两种验证策略。实际邮件投递需要部署
管理员配置 Resend 和已验证的发件域名后验证。

## 使用方式

1. 新建实例时，用邮箱、昵称、密码和现有 setup-token 创建首个管理员。
2. 管理员打开「服务」中的 Resend 邮箱验证卡片，填写发件地址和 API Key，
   开启验证码并保存。留空 API Key 会保留已保存的密钥；关闭验证后可明确清除密钥。
3. 开启验证后，注册和管理员创建用户先发送验证码，再提交邮箱、昵称、密码和验证码。
4. 用户在「设置 → 账号」修改昵称，或给新邮箱发送验证码后绑定/更换邮箱。
   更换成功后，使用新邮箱和原密码登录，内部 ID、设备和会话归属不变。

未启用验证码时，注册和绑定不会调用邮件服务，按实例设置直接标记为已验证。
后续开启验证码不追溯修改这些已接受的账号。这里的「已验证」包含管理员明确
选择的免验证策略，并不表示 Resend 曾经确认过该邮箱的所有权。

## API 与客户端

本次实现范围为 Server、Web、Android 和 iOS。按用户要求，Desktop 代码没有修改。
Desktop Workbench 的旧账号表单仍使用用户名请求，不能直接用于新的邮箱认证 API；
其账号界面需要 Desktop 维护者另行对接。

接口均在 `/api/v2` 下，保留现有密码 verifier、salt、setup-token 和 access-token
机制。令牌主体仍是稳定的 `userId`。

| 操作 | 请求 |
| --- | --- |
| 登录盐查询 | `POST /auth/password-salt`，`{email}` |
| 邮箱登录 | `POST /auth/login`，`{email, passwordVerifier}` |
| 注册 | `POST /auth/register`，`{email, displayName, passwordVerifier, passwordSalt, code?, setupToken?}` |
| 发送验证码 | `POST /auth/email-code`，`{email, purpose: "register" 或 "bind", pendingToken?}` |
| 修改昵称 | `PUT /auth/me/profile`，`{displayName}`，需要登录 |
| 绑定/更换邮箱 | `PUT /auth/me/email`，`{email, code?}`，需要登录 |
| 服务设置 | `PATCH /admin/settings`，`{email: {enabled?, fromAddress?, apiKey?, clearApiKey?}}` |

认证响应、`/auth/me` 和管理员用户列表增加 `email`、`emailVerified`、`displayName`。
`/auth/config.emailVerificationRequired` 供客户端判断是否展示验证码输入。
管理接口返回 `email.apiKeyConfigured`，不会返回 `apiKey`。

验证码为 6 位数字，有效期 10 分钟，同一用途/用户/邮箱 60 秒内不可重发，
每小时最多 5 次错误校验；重发不能重置错误次数。发送还受邮箱和来源 IP 的
小时额度限制。第三方 OAuth 新用户在普通注册关闭时需要提供有效的 `pendingToken`
才可以发送注册验证码；绑定已有账号仍需该账号密码，不能只凭第三方返回的邮箱绑定。

用户名请求不再兼容。旧客户端需要与此服务端版本一起更新；旧数据库中未设置账号
邮箱的用户无法用原用户名重新登录。仍有效的既有登录令牌可继续用于资料和邮箱绑定。
数据库结构版本升级至 `2.25`；只增加字段和验证码表，不回填邮箱、不改用户 ID，
不清空用户、设备、会话或第三方账号。已有邮箱账号数据时拒绝降级删除这些字段。

Resend 通过服务端 `httpx` 请求固定的官方 `POST /emails` 接口。参见
[Resend 发送邮件接口](https://resend.com/docs/api-reference/emails/send-email) 和
[发件域名要求](https://resend.com/docs/api-reference/errors)。

## 本次验证记录

- Auth、邮箱验证和数据库结构升级专项共 151 项通过，包含验证码并发消费只能
  成功一次、跨用途/账号隔离、超时/重放/重发/错误预算和 OAuth 事务回滚。
- 邮件传输、配置及架构边界相关复核 23 项通过；使用模拟 Resend，没有真实投递。
- Web 72 项测试通过，类型检查和协议检查通过。
- Server 最后一次全量运行 662 项通过、14 项跳过，1 项会话未读用例在 SQLite
  提交时遇到 `database is locked`；该用例与相邻两个用例单独复测 3 项通过。
  不把这次全量运行记为全绿，相关会话/数据库引擎业务代码不在本次修改范围。
- iOS 全部 84 个 Swift 文件语法解析及独立接口合约检查通过；邮箱状态展示修正后
  对受影响文件再次解析通过。Android 中英文资源和接口调用链已静态检查。
- 没有进行 Android 构建、原生界面交互、实际 PostgreSQL 并发部署验证或真实邮件
  投递验收；本机缺少 Android SDK。Desktop 不在本次修改范围。
