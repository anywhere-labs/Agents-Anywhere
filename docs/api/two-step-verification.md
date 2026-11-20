# 两步验证（TOTP）

用户可以给自己的账号开启两步验证。开启后，用密码登录还需要输入身份验证器 App（RFC 6238，SHA-1、6 位、30 秒）显示的验证码，或一个一次性恢复码。

接口都在 `/api/v2` 下。需要登录的接口用 `Authorization: Bearer <accessToken>`。

## 前提

- Server 的 `AGENT_SERVER_SECRET` 至少 32 个字符，且不是默认值。密钥用它派生的密钥加密后存库；不满足时开启接口返回 `409`，`detail.code = "secret_unconfigured"`。
- 更换 `AGENT_SERVER_SECRET` 后，已保存的密钥无法解密，相关用户需要由管理员重置两步验证后重新开启。
- 可选 `AGENT_SERVER_TOTP_ISSUER`：身份验证器里显示的发行方名称，默认 `Agents Anywhere`。

## 登录

1. `POST /auth/login` 与原来相同。账号未开启两步验证时直接返回 `AuthResponse`。
2. 已开启时返回 `401`：

   ```json
   {
     "detail": {
       "code": "totp_required",
       "message": "two-step verification code required",
       "challengeToken": "<签名令牌>",
       "expiresIn": 300
     }
   }
   ```

   密码错误仍返回 `401 {"detail": "invalid credentials"}`，不会给出 `challengeToken`。

3. `POST /auth/login/totp`，请求体 `{"challengeToken": "...", "code": "123456"}`。`code` 可以是 6 位验证码或恢复码（大小写、空格和连字符不敏感）。成功返回 `AuthResponse`。

| 状态 | `detail.code` | 含义 |
| --- | --- | --- |
| 401 | `totp_challenge_expired` | `challengeToken` 无效或超过 5 分钟，需要重新输入密码 |
| 401 | `totp_invalid_code` | 验证码或恢复码不正确 |
| 429 | `totp_locked` | 连续输错 5 次，锁定 5 分钟；带 `Retry-After` |

同一个 30 秒周期内已经用过的验证码不能再次使用。每个恢复码只能用一次。

不走密码的登录方式不受影响：OAuth 登录由提供方负责验证；手机扫码登录和移动端网页确认登录依赖已登录的网页会话，网页登录本身已经过两步验证。

## 管理自己的两步验证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/auth/totp` | `{enabled, pendingSetup, recoveryCodesRemaining}` |
| POST | `/auth/totp/setup` | 生成新密钥，返回 `{secret, otpauthUri}`；确认前不影响登录。已开启时 `409 totp_already_enabled` |
| DELETE | `/auth/totp/setup` | 放弃未确认的设置 |
| POST | `/auth/totp/enable` | `{code}`，用 App 显示的验证码确认开启，返回 `{recoveryCodes}`（10 个，只返回这一次） |
| POST | `/auth/totp/disable` | `{code}`，验证码或恢复码，关闭两步验证 |
| POST | `/auth/totp/recovery-codes` | `{code}`，验证码或恢复码，生成新的 10 个恢复码，旧的全部失效 |

`disable` 和 `recovery-codes` 输错同样计入锁定次数。

## 管理员重置

`DELETE /admin/users/{userId}/totp`（管理员）：直接关闭该用户的两步验证，用于用户丢失手机且没有恢复码的情况。成功返回 `204`。

## 存储

迁移 `v2_57` 新增两张表：

- `user_totp`：每个用户一行，加密后的密钥、开启时间、最后使用的周期、失败次数和锁定截止时间。
- `user_totp_recovery_codes`：恢复码的 SHA-256 哈希和使用时间。

删除用户时两张表的数据随之删除。

## 客户端

- Web：登录页在收到 `totp_required` 后显示验证码步骤；「设置 → 账号 → 两步验证」可以开启、关闭和重新生成恢复码。
- Desktop：登录通过系统浏览器打开 Web 完成，自动带上验证码步骤；设置页与 Web 相同。
- Android：只有扫码和网页确认登录，不需要改动。
- iOS：手动密码登录尚未支持验证码步骤；开启两步验证的账号请改用网页确认登录。
