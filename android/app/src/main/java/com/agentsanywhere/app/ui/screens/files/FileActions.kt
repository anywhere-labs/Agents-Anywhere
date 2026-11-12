package com.agentsanywhere.app.ui.screens.files

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.files.fileMimeType
import com.agentsanywhere.app.feature.files.saveFileToDownloads
import com.agentsanywhere.app.feature.files.savingDownloadsNeedsPermission
import com.agentsanywhere.app.ui.designsystem.AAToastVisuals
import kotlinx.coroutines.launch
import java.io.File

/** The explicit entry points the preview page offers for every file. */
internal enum class FileAction {
    Download,
    Share,
    OpenWith,
}

/** A downloaded file ready to hand to an action, with its original name. */
internal data class ActionFile(
    val file: File,
    val name: String,
    val mediaType: String,
)

/**
 * Performs [FileAction]s: saving to `Download/Agents Anywhere`, the system
 * share sheet, and "open with" another app. Results are reported through
 * [toastHostState].
 */
@Composable
internal fun rememberFileActionPerformer(toastHostState: SnackbarHostState): (FileAction, ActionFile) -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pendingSave by remember { mutableStateOf<ActionFile?>(null) }

    fun toast(message: String, isError: Boolean = false) {
        scope.launch {
            toastHostState.showSnackbar(
                AAToastVisuals(
                    message = message,
                    isError = isError,
                    duration = if (isError) SnackbarDuration.Long else SnackbarDuration.Short,
                    timeoutMillis = if (isError) null else 2_600L,
                ),
            )
        }
    }

    fun save(target: ActionFile) {
        scope.launch {
            saveFileToDownloads(context, target.file, target.name)
                .onSuccess { saved -> toast(context.getString(R.string.file_preview_saved, saved.displayName)) }
                .onFailure { toast(context.getString(R.string.file_preview_save_failed), isError = true) }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val target = pendingSave
        pendingSave = null
        if (granted && target != null) {
            save(target)
        } else if (!granted) {
            toast(context.getString(R.string.file_preview_save_permission_required), isError = true)
        }
    }

    return remember(context, toastHostState) {
        { action, target ->
            when (action) {
                FileAction.Download -> {
                    val needsPermission = savingDownloadsNeedsPermission() &&
                        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
                        PackageManager.PERMISSION_GRANTED
                    if (needsPermission) {
                        pendingSave = target
                        permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    } else {
                        save(target)
                    }
                }
                FileAction.Share -> runCatching { shareFile(context, target) }
                    .onFailure { toast(context.getString(R.string.file_preview_share_failed), isError = true) }
                FileAction.OpenWith -> runCatching { openFileWith(context, target) }
                    .onFailure { error ->
                        val message = if (error is ActivityNotFoundException) {
                            R.string.file_preview_no_app
                        } else {
                            R.string.file_preview_failed
                        }
                        toast(context.getString(message), isError = true)
                    }
            }
        }
    }
}

private fun contentUri(context: Context, file: File): Uri {
    // The FileProvider exposes the cached file under its original name, so the
    // receiving app sees `报告 终稿.pdf` rather than a generated one.
    return FileProvider.getUriForFile(context, "${context.packageName}.attachments", file)
}

private fun actionMimeType(target: ActionFile): String {
    return fileMimeType(target.name, target.mediaType) { extension ->
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
    }
}

private fun shareFile(context: Context, target: ActionFile) {
    val uri = contentUri(context, target.file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = actionMimeType(target)
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, target.name)
        clipData = ClipData.newRawUri(target.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(
        Intent.createChooser(send, context.getString(R.string.file_preview_share_chooser))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
    )
}

private fun openFileWith(context: Context, target: ActionFile) {
    val uri = contentUri(context, target.file)
    val view = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, actionMimeType(target))
        clipData = ClipData.newRawUri(target.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(
        Intent.createChooser(view, context.getString(R.string.file_preview_open_chooser))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
    )
}

/** Opens a web or mail link from a document in the user's browser or mail app. */
internal fun openExternalUrl(context: Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
