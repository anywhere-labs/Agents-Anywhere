package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.files.deliverableFileReferences
import com.agentsanywhere.app.feature.files.fileExtension
import com.agentsanywhere.app.feature.files.fileNameFromRemotePath
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.File
import com.composables.icons.lucide.FileCode
import com.composables.icons.lucide.FileSpreadsheet
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Presentation

/**
 * Cards for the documents an agent message links to (reports, decks, sheets,
 * HTML pages). Tapping one opens the file preview page, which also offers
 * Download, Share and Open with.
 */
@Composable
internal fun GeneratedFileCards(
    markdown: String,
    onOpenFile: (String) -> Unit,
) {
    val files = remember(markdown) { deliverableFileReferences(markdown) }
    if (files.isEmpty()) return
    Column(
        modifier = Modifier.padding(horizontal = 4.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        files.forEach { path -> GeneratedFileCard(path = path, onClick = { onOpenFile(path) }) }
    }
}

@Composable
private fun GeneratedFileCard(path: String, onClick: () -> Unit) {
    val colors = LocalAAColors.current
    val extension = fileExtension(path)
    val (icon, accent) = fileCardStyle(extension)
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier = Modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .clip(shape)
            .background(colors.sessionMessageBubble)
            .border(1.dp, colors.border, shape)
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(accent.copy(alpha = if (colors.isDark) 0.22f else 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.size(19.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = fileNameFromRemotePath(path),
                color = colors.ink,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            Text(
                text = listOf(extension.uppercase(), stringResource(R.string.file_preview_card_hint))
                    .filter { it.isNotBlank() }
                    .joinToString(" · "),
                color = colors.muted,
                fontSize = 12.sp,
                maxLines = 1,
            )
        }
        Icon(Lucide.ChevronRight, contentDescription = null, tint = colors.faint, modifier = Modifier.size(16.dp))
    }
}

private fun fileCardStyle(extension: String): Pair<ImageVector, Color> {
    return when (extension) {
        "pdf" -> Lucide.FileText to Color(0xFFE5484D)
        "doc", "docx", "rtf", "odt", "pages" -> Lucide.FileText to Color(0xFF2F6FDB)
        "ppt", "pptx", "pps", "ppsx", "odp", "key" -> Lucide.Presentation to Color(0xFFE07B24)
        "xls", "xlsx", "xlsm", "ods", "numbers", "csv", "tsv" -> Lucide.FileSpreadsheet to Color(0xFF2E9A5B)
        "html", "htm", "epub" -> Lucide.FileCode to Color(0xFF8B5CF6)
        else -> Lucide.File to Color(0xFF8A8984)
    }
}
