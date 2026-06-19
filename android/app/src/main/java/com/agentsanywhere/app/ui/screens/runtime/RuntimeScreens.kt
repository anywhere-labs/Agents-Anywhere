package com.agentsanywhere.app.ui.screens.runtime

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.ui.designsystem.AAColor
import com.agentsanywhere.app.ui.designsystem.BackPill
import com.agentsanywhere.app.ui.designsystem.Chip
import com.agentsanywhere.app.ui.designsystem.FileGlyph
import com.agentsanywhere.app.ui.designsystem.ForwardGlyph
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.navigation.AppDestination

@Composable
fun RuntimeFilesScreen(navigate: (AppDestination) -> Unit) {
    RuntimeFrame(
        title = "Files",
        onBack = { navigate(AppDestination.SessionDetail) },
    ) {
        Text(
            "agents-anywhere-code / web / src",
            color = AAColor.Muted,
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
        )
        listOf(
            "SessionDetailPage.tsx",
            "FilesPanel.tsx",
            "RuntimeWindow.tsx",
            "api.ts",
            "theme.ts",
        ).forEach { name ->
            FileRow(name = name) {
                navigate(AppDestination.CodePreview)
            }
        }
    }
}

@Composable
fun RuntimeTerminalScreen(navigate: (AppDestination) -> Unit) {
    RuntimeFrame(
        title = "Terminal",
        onBack = { navigate(AppDestination.SessionDetail) },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(374.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(Color.White)
                .border(1.dp, AAColor.Border, RoundedCornerShape(18.dp))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            TerminalLine("$ cd web")
            TerminalLine("$ yarn typecheck")
            TerminalLine("Done in 3.2s")
            TerminalLine("$")
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("esc", "tab", "ctrl", "cmd").forEach { label ->
                Chip(label)
            }
        }
    }
}

@Composable
fun CodePreviewScreen(navigate: (AppDestination) -> Unit) {
    RuntimeFrame(
        title = "Code Preview",
        onBack = { navigate(AppDestination.RuntimeFiles) },
    ) {
        Text(
            "web / src / pages / SessionDetailPage.tsx",
            color = AAColor.Muted,
            fontSize = 13.sp,
            fontFamily = FontFamily.Monospace,
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .clip(RoundedCornerShape(16.dp))
                .background(Color.White)
                .border(1.dp, AAColor.Border, RoundedCornerShape(16.dp))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            sampleCode.forEachIndexed { index, code ->
                CodeLine(index + 1, code)
            }
        }
    }
}

@Composable
private fun RuntimeFrame(
    title: String,
    onBack: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ScreenScaffold {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(58.dp)
                .padding(horizontal = 18.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BackPill(label = "Detail", onClick = onBack)
            Text(title, color = AAColor.Ink, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
private fun FileRow(name: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(Color.White)
            .border(1.dp, AAColor.Border, RoundedCornerShape(16.dp))
            .noRippleClickable(onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        FileGlyph()
        Text(
            name,
            color = AAColor.Ink,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        ForwardGlyph()
    }
}

@Composable
private fun TerminalLine(text: String) {
    Text(
        text,
        color = if (text.startsWith("$")) AAColor.Ink else AAColor.Muted,
        fontSize = 13.sp,
        fontFamily = FontFamily.Monospace,
    )
}

@Composable
private fun CodeLine(number: Int, code: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            number.toString().padStart(2, '0'),
            color = AAColor.Faint,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
        )
        Text(
            code,
            color = AAColor.Ink,
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private val sampleCode = listOf(
    "const route = useMemo(() => session?.id, [session])",
    "return <RuntimeWindow sessionId={route} />",
    "await api.sessions.sync(sessionId)",
    "setTimeline((prev) => reconcile(prev, next))",
)
