package com.agentsanywhere.app.ui.screens.profile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.AAAppearanceMode
import com.agentsanywhere.app.ui.designsystem.AALanguageMode
import com.agentsanywhere.app.ui.screens.home.HomeSidebarViewMode
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
internal fun String.labelForAppearance(): String = when (this) {
    AAAppearanceMode.Light -> stringResource(R.string.profile_light)
    AAAppearanceMode.Dark -> stringResource(R.string.profile_dark)
    else -> stringResource(R.string.profile_system)
}

@Composable
internal fun String.labelForLanguage(): String = when (this) {
    AALanguageMode.English -> stringResource(R.string.profile_english)
    AALanguageMode.SimplifiedChinese -> stringResource(R.string.profile_simplified_chinese)
    else -> stringResource(R.string.profile_language_follow_system)
}

@Composable
internal fun String.labelForSidebarView(): String = when (this) {
    HomeSidebarViewMode.Session -> stringResource(R.string.profile_session_view)
    else -> stringResource(R.string.profile_project_view)
}

@Composable
internal fun String.prettyRole(): String = when (lowercase()) {
    "admin" -> stringResource(R.string.profile_role_admin)
    "member" -> stringResource(R.string.profile_role_member)
    else -> replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
}

internal suspend fun Context.avatarDataUrl(uri: Uri): String? = withContext(Dispatchers.IO) {
    val bitmap = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return@withContext null
    val scale = minOf(1f, 256f / max(bitmap.width, bitmap.height).toFloat())
    val width = max(1, (bitmap.width * scale).roundToInt())
    val height = max(1, (bitmap.height * scale).roundToInt())
    val scaled = if (width == bitmap.width && height == bitmap.height) {
        bitmap
    } else {
        Bitmap.createScaledBitmap(bitmap, width, height, true)
    }
    val data = ByteArrayOutputStream().use { output ->
        scaled.compress(Bitmap.CompressFormat.PNG, 100, output)
        output.toByteArray()
    }
    if (scaled !== bitmap) scaled.recycle()
    bitmap.recycle()
    "data:image/png;base64,${Base64.encodeToString(data, Base64.NO_WRAP)}"
}

internal fun Context.appVersionName(): String {
    return runCatching {
        packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
    }.getOrDefault("0.1.7.2")
}
