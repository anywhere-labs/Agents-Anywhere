package com.agentsanywhere.app.ui.screens.sessiondetail

internal data class DiffPreviewText(
    val text: String,
    val highlights: Map<Int, DiffLineTone>,
)

internal fun diffPreview(diff: String): DiffPreviewText {
    val textLines = mutableListOf<String>()
    val highlights = mutableMapOf<Int, DiffLineTone>()

    diff.lineSequence().forEach { raw ->
        when {
            raw.startsWith("diff --git ") ||
                raw.startsWith("index ") ||
                raw.startsWith("--- ") ||
                raw.startsWith("+++ ") -> Unit

            raw.startsWith("@@") -> {
                textLines += raw
            }

            raw.startsWith("+") && !raw.startsWith("+++") -> {
                highlights[textLines.size] = DiffLineTone.Added
                textLines += raw.removePrefix("+").ifEmpty { " " }
            }

            raw.startsWith("-") && !raw.startsWith("---") -> {
                highlights[textLines.size] = DiffLineTone.Deleted
                textLines += raw.removePrefix("-").ifEmpty { " " }
            }

            raw.isBlank() -> {
                textLines += " "
            }

            else -> {
                textLines += raw.removePrefix(" ")
            }
        }
    }

    return DiffPreviewText(
        text = textLines.joinToString("\n").trimEnd(),
        highlights = highlights,
    )
}
