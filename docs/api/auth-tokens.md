# 登录令牌与刷新

每次登录（注册、密码登录、OAuth 登录、手机扫码登录）都会开启一个**登录**（token family）。同一个登录里的访问令牌和刷新令牌一起生效，也一起失效。

## 登录响应

`POST /auth/register`、`POST /auth/login`、`POST /auth/oauth/finalize` 的 `auth`，以及 `POST /auth/mobile-login/exchange` 的 `auth`，都返回：

| 字段 | 说明 |
| --- | --- |
| `accessToken` | 放在 `Authorization: Bearer` 里的访问令牌。 |
| `expiresAt` | 访问令牌的过期时间（ISO 8601）。目前仍为签发后 7 天。 |
| `refreshToken` | 一次性刷新令牌，格式 `aart_<登录 id>.<随机串>`。客户端要安全保存（Keychain、Keystore、系统凭据库）。 |
| `refreshExpiresAt` | 刷新令牌的过期时间。每次刷新都会顺延 30 天。 |

旧客户端忽略这几个新字段即可，行为与之前相同。

## 刷新

```text
POST /auth/refresh
{"refreshToken": "aart_..."}
```

返回新的 `accessToken` 和**下一个** `refreshToken`，旧的刷新令牌随即作废。

- 同一个刷新令牌只能用一次。已经用过的刷新令牌再次出现，说明它被复制了，Server 会结束整个登录：这个登录的访问令牌和刷新令牌都会失效，用户需要重新登录。
- 客户端应当在访问令牌过期前刷新，并且保证同一时间只有一个刷新请求（多个标签页或进程共享令牌时要加锁）。
- 刷新失败返回 401，客户端应当回到登录页。

手机扫码登录仍可以继续使用 `POST /auth/mobile-login/refresh`。它签发的访问令牌属于扫码时开启的登录，那个登录结束后它也会返回 401。

## 退出登录

```text
POST /auth/logout        (Authorization: Bearer <accessToken>)
→ 204
```

结束当前登录，不影响同一账号的其他登录。

## 什么时候令牌会失效

| 事件 | 结束哪些登录 |
| --- | --- |
| 退出登录 | 当前登录 |
| 修改密码（`POST /auth/change-password`，带访问令牌） | 除当前登录外的所有登录 |
| 通过邮箱验证码重置密码、管理员重置密码 | 该账号的所有登录 |
| 管理员停用账号 | 该账号的所有登录（重新启用后也需要重新登录） |
| 删除账号 | 全部 |
| 刷新令牌被重复使用 | 该登录 |

每个请求都会检查账号是否仍然可用、登录是否已经结束。各 worker 会把检查结果缓存几秒钟，所以登录结束后最多几秒，所有 worker 都会拒绝它的令牌。

升级前签发的访问令牌不属于任何登录：在过期前继续可用，账号被停用或删除后立即失效。

## WebSocket 与下载

WebSocket 和下载链接不要在 URL 里带访问令牌，用 `POST /ws-ticket` 换一次性票据，详见 [Realtime API](./realtime.md)。票据只能在登录有效时换取。
