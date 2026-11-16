package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.RemoteDisplayEnvelope
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.api.e2ee.DisplaySlot
import com.agentsanywhere.app.feature.e2ee.DisplayFields
import com.agentsanywhere.app.feature.e2ee.DisplayOpenResult
import com.agentsanywhere.app.feature.e2ee.SessionDisplayDecryptor

/**
 * 会话在列表里显示的标题与工作目录（与 Web/Desktop #762 的 `features/e2ee/display.ts` 同一规则）。
 *
 * - [encrypted]：至少有一个展示信封是 `sealed`。这时只用本机解开的密封信封，旁边的 `plain` 信封和 Server 的
 *   明文 `title` / `cwd` 都来自 Server，一律忽略。
 * - 标题 = `displayUser.title ?? displayDevice.title`；`displayUser` 打不开时不拿设备原生标题顶替。
 *   标题因此缺失、且有信封打不开时 [titleLocked]，显示「加密中」占位；`displayDevice` 打不开时 [cwdLocked]，工作目录为空。
 * - 没有密封信封（普通模式）时：标题 = `displayUser.title ?? displayDevice.title ?? Server 的 title`，
 *   工作目录 = `displayDevice.cwd ?? Server 的 cwd`，即 `plain` 信封优先、Server 明文只补空缺（契约 #720）。
 *   不认识的 `mode` 当作没有这个信封；完全没有信封时与之前一样。
 *   普通模式改名后显示正确的标题，依赖 Server 改名时同时写 `plain` 的 displayUser（随 #759 跟进）。
 */
internal data class ResolvedSessionDisplay(
    val title: String?,
    val cwd: String?,
    val titleLocked: Boolean = false,
    val cwdLocked: Boolean = false,
    val encrypted: Boolean = false,
)

/** 进程内共用的解密器与占位文案；App 启动时由 `app` 层装上（未装时密封的信封都显示占位）。 */
object SessionDisplayEnvironment {
    @Volatile
    var decryptor: SessionDisplayDecryptor = SessionDisplayDecryptor(keyFor = { null })

    /** 「加密中」占位；App 按当前语言设置。 */
    @Volatile
    var lockedLabel: String = "Encrypted — shown once the device is online"
}

internal fun RemoteSession.resolveDisplay(decryptor: SessionDisplayDecryptor): ResolvedSessionDisplay {
    val deviceSealed = displayDevice?.takeIf { it.mode == RemoteDisplayEnvelope.MODE_SEALED }
    val userSealed = displayUser?.takeIf { it.mode == RemoteDisplayEnvelope.MODE_SEALED }
    if (deviceSealed == null && userSealed == null) {
        val deviceFields = displayDevice?.plainFields()
        val userFields = displayUser?.plainFields()
        return ResolvedSessionDisplay(
            title = userFields?.title ?: deviceFields?.title ?: title?.takeIf { it.isNotBlank() },
            cwd = deviceFields?.cwd ?: cwd?.takeIf { it.isNotBlank() },
        )
    }
    val device = deviceSealed?.let { decryptor.open(connectorId, id, DisplaySlot.Device, it) }
    val user = userSealed?.let { decryptor.open(connectorId, id, DisplaySlot.User, it) }
    val deviceFields = (device as? DisplayOpenResult.Opened)?.fields
    val userFields = (user as? DisplayOpenResult.Opened)?.fields
    val deviceLocked = device == DisplayOpenResult.Locked
    val userLocked = user == DisplayOpenResult.Locked
    val resolvedTitle = userFields?.title ?: if (userLocked) null else deviceFields?.title
    return ResolvedSessionDisplay(
        title = resolvedTitle,
        cwd = deviceFields?.cwd,
        titleLocked = resolvedTitle == null && (deviceLocked || userLocked),
        cwdLocked = deviceLocked,
        encrypted = true,
    )
}

private fun RemoteDisplayEnvelope.plainFields(): DisplayFields? = if (isPlain) DisplayFields.parse(payload) else null
