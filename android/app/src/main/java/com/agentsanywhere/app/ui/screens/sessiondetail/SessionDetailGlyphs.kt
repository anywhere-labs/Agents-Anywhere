package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.dp

@Composable
internal fun PlusMiniGlyph(color: Color) = DetailGlyph(sizeDp = 20, color = color) {
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.20f), Offset(size.width * 0.50f, size.height * 0.80f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.20f, size.height * 0.50f), Offset(size.width * 0.80f, size.height * 0.50f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
internal fun ArrowUpGlyph(color: Color) = DetailGlyph(sizeDp = 18, color = color) {
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.78f), Offset(size.width * 0.50f, size.height * 0.24f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.24f), Offset(size.width * 0.28f, size.height * 0.46f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.24f), Offset(size.width * 0.72f, size.height * 0.46f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
internal fun ArrowDownGlyph(color: Color, sizeDp: Int = 18) = DetailGlyph(sizeDp = sizeDp, color = color) {
    val stroke = if (sizeDp > 18) 2.5.dp.toPx() else 2.dp.toPx()
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.18f), Offset(size.width * 0.50f, size.height * 0.78f), strokeWidth = stroke, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.78f), Offset(size.width * 0.26f, size.height * 0.54f), strokeWidth = stroke, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.78f), Offset(size.width * 0.74f, size.height * 0.54f), strokeWidth = stroke, cap = StrokeCap.Round)
}

@Composable
internal fun ChevronRightGlyph(color: Color) = DetailGlyph(sizeDp = 18, color = color) {
    drawLine(color, Offset(size.width * 0.38f, size.height * 0.28f), Offset(size.width * 0.62f, size.height * 0.50f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.62f, size.height * 0.50f), Offset(size.width * 0.38f, size.height * 0.72f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
internal fun ChevronDownGlyph(color: Color) = DetailGlyph(sizeDp = 18, color = color) {
    drawLine(color, Offset(size.width * 0.28f, size.height * 0.40f), Offset(size.width * 0.50f, size.height * 0.62f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.62f), Offset(size.width * 0.72f, size.height * 0.40f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
internal fun ChevronUpGlyph(color: Color) = DetailGlyph(sizeDp = 18, color = color) {
    drawLine(color, Offset(size.width * 0.28f, size.height * 0.60f), Offset(size.width * 0.50f, size.height * 0.38f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.50f, size.height * 0.38f), Offset(size.width * 0.72f, size.height * 0.60f), strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round)
}

@Composable
internal fun SparklesGlyph(color: Color) = DetailGlyph(sizeDp = 14, color = color) {
    val path = Path().apply {
        moveTo(size.width * 0.50f, size.height * 0.08f)
        lineTo(size.width * 0.59f, size.height * 0.41f)
        lineTo(size.width * 0.92f, size.height * 0.50f)
        lineTo(size.width * 0.59f, size.height * 0.59f)
        lineTo(size.width * 0.50f, size.height * 0.92f)
        lineTo(size.width * 0.41f, size.height * 0.59f)
        lineTo(size.width * 0.08f, size.height * 0.50f)
        lineTo(size.width * 0.41f, size.height * 0.41f)
        close()
    }
    drawPath(path, color)
}

@Composable
internal fun CameraGlyph(color: Color) = DetailGlyph(sizeDp = 21, color = color) {
    val stroke = 2.dp.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset(size.width * 0.17f, size.height * 0.29f),
        size = androidx.compose.ui.geometry.Size(size.width * 0.66f, size.height * 0.52f),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(3.dp.toPx(), 3.dp.toPx()),
        style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke),
    )
    drawRoundRect(
        color = color,
        topLeft = Offset(size.width * 0.34f, size.height * 0.16f),
        size = androidx.compose.ui.geometry.Size(size.width * 0.22f, size.height * 0.16f),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.dp.toPx(), 2.dp.toPx()),
        style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke),
    )
    drawCircle(color = color, radius = size.width * 0.13f, center = Offset(size.width * 0.50f, size.height * 0.56f), style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke))
}

@Composable
internal fun PhotoGlyph(color: Color) = DetailGlyph(sizeDp = 21, color = color) {
    val stroke = 2.dp.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset(size.width * 0.16f, size.height * 0.18f),
        size = androidx.compose.ui.geometry.Size(size.width * 0.68f, size.height * 0.64f),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(3.dp.toPx(), 3.dp.toPx()),
        style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke),
    )
    drawCircle(color = color, radius = size.width * 0.06f, center = Offset(size.width * 0.68f, size.height * 0.34f))
    val path = Path().apply {
        moveTo(size.width * 0.20f, size.height * 0.74f)
        lineTo(size.width * 0.40f, size.height * 0.54f)
        lineTo(size.width * 0.53f, size.height * 0.66f)
        lineTo(size.width * 0.62f, size.height * 0.56f)
        lineTo(size.width * 0.80f, size.height * 0.74f)
    }
    drawPath(path, color, style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = StrokeCap.Round))
}

@Composable
internal fun PaperclipGlyph(color: Color) = DetailGlyph(sizeDp = 21, color = color) {
    val stroke = 2.1.dp.toPx()
    val path = Path().apply {
        moveTo(size.width * 0.62f, size.height * 0.25f)
        cubicTo(size.width * 0.84f, size.height * 0.44f, size.width * 0.75f, size.height * 0.83f, size.width * 0.48f, size.height * 0.84f)
        cubicTo(size.width * 0.25f, size.height * 0.85f, size.width * 0.17f, size.height * 0.55f, size.width * 0.35f, size.height * 0.38f)
        lineTo(size.width * 0.55f, size.height * 0.20f)
        cubicTo(size.width * 0.68f, size.height * 0.08f, size.width * 0.89f, size.height * 0.23f, size.width * 0.76f, size.height * 0.42f)
        lineTo(size.width * 0.48f, size.height * 0.70f)
        cubicTo(size.width * 0.37f, size.height * 0.80f, size.width * 0.21f, size.height * 0.66f, size.width * 0.32f, size.height * 0.54f)
        lineTo(size.width * 0.58f, size.height * 0.28f)
    }
    drawPath(path, color, style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = StrokeCap.Round))
}

@Composable
internal fun RefreshCameraGlyph(color: Color) = DetailGlyph(sizeDp = 28, color = color) {
    val stroke = 2.5.dp.toPx()
    drawArc(
        color = color,
        startAngle = 28f,
        sweepAngle = 240f,
        useCenter = false,
        style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke, cap = StrokeCap.Round),
    )
    drawLine(color, Offset(size.width * 0.22f, size.height * 0.32f), Offset(size.width * 0.18f, size.height * 0.57f), strokeWidth = stroke, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.22f, size.height * 0.32f), Offset(size.width * 0.42f, size.height * 0.44f), strokeWidth = stroke, cap = StrokeCap.Round)
}

@Composable
internal fun XGlyph(color: Color, sizeDp: Int = 24) = DetailGlyph(sizeDp = sizeDp, color = color) {
    val stroke = if (sizeDp >= 24) 2.8.dp.toPx() else 2.dp.toPx()
    drawLine(color, Offset(size.width * 0.24f, size.height * 0.24f), Offset(size.width * 0.76f, size.height * 0.76f), strokeWidth = stroke, cap = StrokeCap.Round)
    drawLine(color, Offset(size.width * 0.76f, size.height * 0.24f), Offset(size.width * 0.24f, size.height * 0.76f), strokeWidth = stroke, cap = StrokeCap.Round)
}

@Composable
private fun DetailGlyph(
    sizeDp: Int = 20,
    color: Color,
    draw: DrawScope.() -> Unit,
) {
    Canvas(modifier = Modifier.size(sizeDp.dp)) {
        draw()
    }
}
