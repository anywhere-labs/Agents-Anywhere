package com.agentsanywhere.app.ui.designsystem

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.dp

@Composable
fun SearchGlyph(color: Color = AAColor.Ink) = LineGlyph(color = color) { color ->
    drawCircle(color, radius = size.minDimension * 0.27f, center = Offset(size.width * 0.44f, size.height * 0.42f), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3.5f))
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
private fun LineGlyph(
    sizeDp: Int = 22,
    color: Color = AAColor.Ink,
    draw: DrawScope.(Color) -> Unit,
) {
    Canvas(modifier = Modifier.size(sizeDp.dp)) {
        draw(color)
    }
}
