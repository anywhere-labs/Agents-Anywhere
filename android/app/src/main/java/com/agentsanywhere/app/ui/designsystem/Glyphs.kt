package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp

@Composable
fun QrGlyph() {
    Canvas(modifier = Modifier.fillMaxSize()) {
        val stroke = Stroke(width = 6f, cap = StrokeCap.Round)
        val block = size.minDimension / 5f
        fun finder(x: Float, y: Float) {
            drawRoundRect(
                color = AAColor.Ink,
                topLeft = Offset(x, y),
                size = Size(block * 1.35f, block * 1.35f),
                cornerRadius = CornerRadius(10f, 10f),
                style = stroke,
            )
            drawCircle(AAColor.Ink, radius = 6f, center = Offset(x + block * 0.68f, y + block * 0.68f))
        }
        finder(0f, 0f)
        finder(size.width - block * 1.35f, 0f)
        finder(0f, size.height - block * 1.35f)
        drawRoundRect(AAColor.Ink, topLeft = Offset(block * 2.1f, block * 2.1f), size = Size(block * 0.8f, block * 0.8f), cornerRadius = CornerRadius(7f, 7f))
        drawRoundRect(AAColor.Ink, topLeft = Offset(block * 3.3f, block * 2.7f), size = Size(block * 0.55f, block * 1.4f), cornerRadius = CornerRadius(7f, 7f))
        drawRoundRect(AAColor.Ink, topLeft = Offset(block * 2.2f, block * 3.8f), size = Size(block * 1.4f, block * 0.5f), cornerRadius = CornerRadius(7f, 7f))
    }
}

@Composable
fun PasswordKeyGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    drawCircle(
        color = lineColor,
        radius = size.minDimension * 0.17f,
        center = Offset(size.width * 0.30f, size.height * 0.50f),
        style = Stroke(width = 1.6f),
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.47f, size.height * 0.50f),
        end = Offset(size.width * 0.88f, size.height * 0.50f),
        strokeWidth = 1.8f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.72f, size.height * 0.50f),
        end = Offset(size.width * 0.72f, size.height * 0.70f),
        strokeWidth = 1.8f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.72f, size.height * 0.70f),
        end = Offset(size.width * 0.88f, size.height * 0.70f),
        strokeWidth = 1.8f,
        cap = StrokeCap.Round,
    )
}

@Composable
fun SmallQrGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    val finderSize = size.minDimension * 0.27f
    val stroke = Stroke(width = 1.55f)

    fun finder(x: Float, y: Float) {
        drawRoundRect(
            color = lineColor,
            topLeft = Offset(x, y),
            size = Size(finderSize, finderSize),
            cornerRadius = CornerRadius(1.4f, 1.4f),
            style = stroke,
        )
        drawRoundRect(
            color = lineColor,
            topLeft = Offset(x + finderSize * 0.33f, y + finderSize * 0.33f),
            size = Size(finderSize * 0.34f, finderSize * 0.34f),
            cornerRadius = CornerRadius(0.7f, 0.7f),
        )
    }

    finder(size.width * 0.11f, size.height * 0.11f)
    finder(size.width * 0.62f, size.height * 0.11f)
    finder(size.width * 0.11f, size.height * 0.62f)
    finder(size.width * 0.62f, size.height * 0.62f)
}

@Composable
fun ShieldCheckGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    val shield = Path().apply {
        moveTo(size.width * 0.50f, size.height * 0.13f)
        lineTo(size.width * 0.77f, size.height * 0.24f)
        lineTo(size.width * 0.77f, size.height * 0.48f)
        cubicTo(
            size.width * 0.77f,
            size.height * 0.70f,
            size.width * 0.64f,
            size.height * 0.84f,
            size.width * 0.50f,
            size.height * 0.90f,
        )
        cubicTo(
            size.width * 0.36f,
            size.height * 0.84f,
            size.width * 0.23f,
            size.height * 0.70f,
            size.width * 0.23f,
            size.height * 0.48f,
        )
        lineTo(size.width * 0.23f, size.height * 0.24f)
        close()
    }
    drawPath(
        path = shield,
        color = lineColor,
        style = Stroke(width = 1.65f, cap = StrokeCap.Round),
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.36f, size.height * 0.55f),
        end = Offset(size.width * 0.46f, size.height * 0.64f),
        strokeWidth = 1.8f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.46f, size.height * 0.64f),
        end = Offset(size.width * 0.66f, size.height * 0.47f),
        strokeWidth = 1.8f,
        cap = StrokeCap.Round,
    )
}

@Composable
fun ServerGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    drawRoundRect(
        color = lineColor,
        topLeft = Offset(size.width * 0.23f, size.height * 0.20f),
        size = Size(size.width * 0.54f, size.height * 0.24f),
        cornerRadius = CornerRadius(2.8f, 2.8f),
        style = Stroke(width = 1.6f),
    )
    drawRoundRect(
        color = lineColor,
        topLeft = Offset(size.width * 0.23f, size.height * 0.56f),
        size = Size(size.width * 0.54f, size.height * 0.24f),
        cornerRadius = CornerRadius(2.8f, 2.8f),
        style = Stroke(width = 1.6f),
    )
    drawCircle(lineColor, radius = 1.2f, center = Offset(size.width * 0.34f, size.height * 0.32f))
    drawCircle(lineColor, radius = 1.2f, center = Offset(size.width * 0.34f, size.height * 0.68f))
}

@Composable
fun AccountGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    drawCircle(
        color = lineColor,
        radius = size.minDimension * 0.17f,
        center = Offset(size.width * 0.50f, size.height * 0.34f),
        style = Stroke(width = 1.55f),
    )
    val shoulders = Path().apply {
        moveTo(size.width * 0.24f, size.height * 0.84f)
        cubicTo(
            size.width * 0.31f,
            size.height * 0.62f,
            size.width * 0.69f,
            size.height * 0.62f,
            size.width * 0.76f,
            size.height * 0.84f,
        )
    }
    drawPath(
        path = shoulders,
        color = lineColor,
        style = Stroke(width = 1.55f, cap = StrokeCap.Round),
    )
}

@Composable
fun SearchGlyph(color: Color = AAColor.Ink) = LineGlyph(color = color) { color ->
    drawCircle(color, radius = size.minDimension * 0.27f, center = Offset(size.width * 0.44f, size.height * 0.42f), style = Stroke(width = 3.5f))
    drawLine(color, Offset(size.width * 0.63f, size.height * 0.63f), Offset(size.width * 0.82f, size.height * 0.82f), strokeWidth = 3.5f, cap = StrokeCap.Round)
}

@Composable
fun BackGlyph(color: Color = AAColor.Ink) = LineGlyph(color = color) { color ->
    drawLine(color, Offset(size.width * 0.66f, size.height * 0.22f), Offset(size.width * 0.34f, size.height * 0.50f), strokeWidth = 3.5f, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.34f, size.height * 0.50f), Offset(size.width * 0.66f, size.height * 0.78f), strokeWidth = 3.5f, cap = StrokeCap.Round)
}

@Composable
fun ForwardGlyph(color: Color = AAColor.Ink) = LineGlyph(color = color) { color ->
    drawLine(color, Offset(size.width * 0.38f, size.height * 0.22f), Offset(size.width * 0.66f, size.height * 0.50f), strokeWidth = 3.2f, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.66f, size.height * 0.50f), Offset(size.width * 0.38f, size.height * 0.78f), strokeWidth = 3.2f, cap = StrokeCap.Round)
}

@Composable
fun DownGlyph(color: Color = AAColor.Muted) = LineGlyph(sizeDp = 18, color = color) { color ->
    drawLine(color, Offset(size.width * 0.25f, size.height * 0.38f), Offset(size.width * 0.50f, size.height * 0.64f), strokeWidth = 3f, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.64f), Offset(size.width * 0.75f, size.height * 0.38f), strokeWidth = 3f, cap = StrokeCap.Round)
}

@Composable
fun PlusGlyph(sizeDp: Int = 28, color: Color = Color.White) = LineGlyph(sizeDp = sizeDp, color = color) { color ->
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.22f), Offset(size.width * 0.50f, size.height * 0.78f), strokeWidth = 4f, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.22f, size.height * 0.50f), Offset(size.width * 0.78f, size.height * 0.50f), strokeWidth = 4f, cap = StrokeCap.Round)
}

@Composable
fun MoreGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 24, color = color) { color ->
    val radius = size.minDimension * 0.085f
    drawCircle(color, radius = radius, center = Offset(size.width * 0.50f, size.height * 0.25f))
    drawCircle(color, radius = radius, center = Offset(size.width * 0.50f, size.height * 0.50f))
    drawCircle(color, radius = radius, center = Offset(size.width * 0.50f, size.height * 0.75f))
}

@Composable
fun PencilGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    val stroke = Stroke(width = 2.2f, cap = StrokeCap.Round)
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.24f, size.height * 0.76f),
        end = Offset(size.width * 0.72f, size.height * 0.28f),
        strokeWidth = 2.2f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.62f, size.height * 0.18f),
        end = Offset(size.width * 0.82f, size.height * 0.38f),
        strokeWidth = 2.2f,
        cap = StrokeCap.Round,
    )
    drawRoundRect(
        color = lineColor,
        topLeft = Offset(size.width * 0.20f, size.height * 0.72f),
        size = Size(size.width * 0.16f, size.height * 0.08f),
        cornerRadius = CornerRadius(1.4f, 1.4f),
        style = stroke,
    )
}

@Composable
fun PinGlyph(color: Color = AAColor.Ink, off: Boolean = false) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    val strokeWidth = 2.1f
    val path = Path().apply {
        moveTo(size.width * 0.34f, size.height * 0.16f)
        lineTo(size.width * 0.68f, size.height * 0.16f)
        lineTo(size.width * 0.60f, size.height * 0.42f)
        lineTo(size.width * 0.76f, size.height * 0.60f)
        lineTo(size.width * 0.52f, size.height * 0.60f)
        lineTo(size.width * 0.50f, size.height * 0.86f)
        lineTo(size.width * 0.44f, size.height * 0.60f)
        lineTo(size.width * 0.20f, size.height * 0.60f)
        lineTo(size.width * 0.38f, size.height * 0.42f)
        close()
    }
    drawPath(path, lineColor, style = Stroke(width = strokeWidth, cap = StrokeCap.Round))
    if (off) {
        drawLine(
            color = lineColor,
            start = Offset(size.width * 0.18f, size.height * 0.16f),
            end = Offset(size.width * 0.84f, size.height * 0.84f),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
fun ArchiveGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 22, color = color) { lineColor ->
    drawRoundRect(
        color = lineColor,
        topLeft = Offset(size.width * 0.18f, size.height * 0.30f),
        size = Size(size.width * 0.64f, size.height * 0.50f),
        cornerRadius = CornerRadius(3.4f, 3.4f),
        style = Stroke(width = 2.1f, cap = StrokeCap.Round),
    )
    drawRoundRect(
        color = lineColor,
        topLeft = Offset(size.width * 0.15f, size.height * 0.18f),
        size = Size(size.width * 0.70f, size.height * 0.18f),
        cornerRadius = CornerRadius(3.2f, 3.2f),
        style = Stroke(width = 2.1f, cap = StrokeCap.Round),
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.40f, size.height * 0.48f),
        end = Offset(size.width * 0.60f, size.height * 0.48f),
        strokeWidth = 2.1f,
        cap = StrokeCap.Round,
    )
}

@Composable
fun CloseGlyph(color: Color = AAColor.Ink, sizeDp: Int = 18) = LineGlyph(sizeDp = sizeDp, color = color) { lineColor ->
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.28f, size.height * 0.28f),
        end = Offset(size.width * 0.72f, size.height * 0.72f),
        strokeWidth = 2.4f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.72f, size.height * 0.28f),
        end = Offset(size.width * 0.28f, size.height * 0.72f),
        strokeWidth = 2.4f,
        cap = StrokeCap.Round,
    )
}

@Composable
fun CheckGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 16, color = color) { lineColor ->
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.22f, size.height * 0.52f),
        end = Offset(size.width * 0.42f, size.height * 0.70f),
        strokeWidth = 2.3f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.42f, size.height * 0.70f),
        end = Offset(size.width * 0.78f, size.height * 0.30f),
        strokeWidth = 2.3f,
        cap = StrokeCap.Round,
    )
}

@Composable
fun SessionsGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 24, color = color) { lineColor ->
    drawRoundRect(lineColor, Offset(size.width * 0.18f, size.height * 0.2f), Size(size.width * 0.64f, size.height * 0.18f), CornerRadius(5f, 5f), style = Stroke(width = 3f))
    drawRoundRect(lineColor, Offset(size.width * 0.18f, size.height * 0.48f), Size(size.width * 0.64f, size.height * 0.18f), CornerRadius(5f, 5f), style = Stroke(width = 3f))
}

@Composable
fun DeviceGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 24, color = color) { lineColor ->
    drawRoundRect(lineColor, Offset(size.width * 0.18f, size.height * 0.18f), Size(size.width * 0.64f, size.height * 0.46f), CornerRadius(5f, 5f), style = Stroke(width = 3f))
    drawLine(lineColor, Offset(size.width * 0.42f, size.height * 0.78f), Offset(size.width * 0.58f, size.height * 0.78f), strokeWidth = 3f, cap = StrokeCap.Round)
    drawLine(lineColor, Offset(size.width * 0.50f, size.height * 0.64f), Offset(size.width * 0.50f, size.height * 0.78f), strokeWidth = 3f, cap = StrokeCap.Round)
}

@Composable
fun WebMonitorGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 64, color = color) { lineColor ->
    drawRoundRect(
        color = lineColor,
        topLeft = Offset(size.width * 0.31f, size.height * 0.20f),
        size = Size(size.width * 0.38f, size.height * 0.30f),
        cornerRadius = CornerRadius(4f, 4f),
        style = Stroke(width = 2.4f),
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.50f, size.height * 0.50f),
        end = Offset(size.width * 0.50f, size.height * 0.62f),
        strokeWidth = 2.4f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.41f, size.height * 0.64f),
        end = Offset(size.width * 0.59f, size.height * 0.64f),
        strokeWidth = 2.4f,
        cap = StrokeCap.Round,
    )
    drawLine(
        color = lineColor,
        start = Offset(size.width * 0.42f, size.height * 0.35f),
        end = Offset(size.width * 0.58f, size.height * 0.35f),
        strokeWidth = 1.8f,
        cap = StrokeCap.Round,
    )
}

@Composable
fun ProfileGlyph(color: Color = AAColor.Ink) = LineGlyph(sizeDp = 24, color = color) { lineColor ->
    drawCircle(lineColor, radius = size.width * 0.16f, center = Offset(size.width * 0.50f, size.height * 0.34f), style = Stroke(width = 3f))
    val path = Path().apply {
        moveTo(size.width * 0.25f, size.height * 0.80f)
        cubicTo(size.width * 0.30f, size.height * 0.60f, size.width * 0.70f, size.height * 0.60f, size.width * 0.75f, size.height * 0.80f)
    }
    drawPath(path, lineColor, style = Stroke(width = 3f, cap = StrokeCap.Round))
}

@Composable
fun AgentGlyph() = LineGlyph { color ->
    drawRoundRect(color, Offset(size.width * 0.22f, size.height * 0.28f), Size(size.width * 0.56f, size.height * 0.42f), CornerRadius(7f, 7f), style = Stroke(width = 3.2f))
    drawCircle(color, radius = 2.7f, center = Offset(size.width * 0.40f, size.height * 0.48f))
    drawCircle(color, radius = 2.7f, center = Offset(size.width * 0.60f, size.height * 0.48f))
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.18f), Offset(size.width * 0.50f, size.height * 0.28f), strokeWidth = 3.2f, cap = StrokeCap.Round)
}

@Composable
fun ToolGlyph() = LineGlyph(sizeDp = 20) { color ->
    drawRoundRect(color, Offset(size.width * 0.20f, size.height * 0.22f), Size(size.width * 0.60f, size.height * 0.56f), CornerRadius(5f, 5f), style = Stroke(width = 3f))
    drawLine(color, Offset(size.width * 0.33f, size.height * 0.42f), Offset(size.width * 0.45f, size.height * 0.52f), strokeWidth = 2.7f, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.45f, size.height * 0.52f), Offset(size.width * 0.33f, size.height * 0.62f), strokeWidth = 2.7f, cap = StrokeCap.Round)
}

@Composable
fun FileGlyph() = LineGlyph(sizeDp = 22) { color ->
    drawRoundRect(color, Offset(size.width * 0.26f, size.height * 0.14f), Size(size.width * 0.48f, size.height * 0.72f), CornerRadius(5f, 5f), style = Stroke(width = 3f))
    drawLine(color, Offset(size.width * 0.36f, size.height * 0.38f), Offset(size.width * 0.64f, size.height * 0.38f), strokeWidth = 2.7f, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.36f, size.height * 0.54f), Offset(size.width * 0.64f, size.height * 0.54f), strokeWidth = 2.7f, cap = StrokeCap.Round)
}

@Composable
fun SendGlyph() = LineGlyph(sizeDp = 18, color = Color.White) { color ->
    val path = Path().apply {
        moveTo(size.width * 0.18f, size.height * 0.18f)
        lineTo(size.width * 0.84f, size.height * 0.50f)
        lineTo(size.width * 0.18f, size.height * 0.82f)
        lineTo(size.width * 0.34f, size.height * 0.50f)
        close()
    }
    drawPath(path, color)
}

@Composable
private fun LineGlyph(
    sizeDp: Int = 22,
    color: Color = AAColor.Ink,
    draw: DrawScope.(Color) -> Unit,
) {
    Canvas(modifier = Modifier.size(sizeDp.dp)) {
        draw(color)
    }
}
