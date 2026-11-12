package com.agentsanywhere.app.feature.files.preview

/**
 * Wraps converted content in a mobile page: documents are drawn as white
 * "paper" cards so they read the same on the light and the dark app canvas.
 */
internal fun previewHtmlPage(body: String, darkCanvas: Boolean): String {
    val canvas = if (darkCanvas) "#09090B" else "#F1F0ED"
    val muted = if (darkCanvas) "#A3A3A3" else "#6F6E69"
    return """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.5, maximum-scale=5">
<style>
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: $canvas; }
body {
  font-family: -apple-system, Roboto, "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", sans-serif;
  color: #1F1F1F; -webkit-text-size-adjust: 100%; padding: 4px 0 24px;
}
.notice { margin: 10px 14px 0; font-size: 12px; line-height: 1.5; color: $muted; }
.page, .slide {
  background: #FFFFFF; margin: 12px; padding: 20px 18px; border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14); line-height: 1.6; font-size: 15px;
  overflow-wrap: anywhere; word-break: normal;
}
.page p, .page li, .slide p { margin: 0 0 0.55em; white-space: pre-wrap; tab-size: 4; }
.page p.empty { min-height: 0.8em; margin: 0; }
.page img, .slide img { max-width: 100%; height: auto; }
h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 0.9em 0 0.45em; font-weight: 700; }
h1 { font-size: 1.55em; } h2 { font-size: 1.32em; } h3 { font-size: 1.16em; }
h4, h5, h6 { font-size: 1.04em; }
.page > :first-child, .slide > :first-child { margin-top: 0; }
a { color: #1A5FB4; text-decoration: underline; }
.li { display: flex; gap: 0.45em; }
.li .marker { flex: none; min-width: 1.1em; color: #444; }
.li .content { flex: 1; min-width: 0; }
.table-wrap { overflow-x: auto; margin: 0.6em 0 0.8em; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; font-size: 0.92em; }
td, th { border: 1px solid #D4D2CC; padding: 5px 8px; vertical-align: top; text-align: left; }
td p, th p { margin: 0 0 0.3em; }
td p:last-child, th p:last-child { margin-bottom: 0; }
.textbox { border: 1px dashed #C9C7C0; border-radius: 6px; padding: 8px 10px; margin: 0.4em 0 0.8em; }
.placeholder { display: inline-block; padding: 6px 10px; margin: 4px 0; border-radius: 6px;
  background: #F1F0ED; color: #6F6E69; font-size: 13px; }
.page-break { border: none; border-top: 1px dashed #C9C7C0; margin: 1.2em 0; }
.slide-label { font-size: 12px; font-weight: 700; color: #8A8984; margin-bottom: 10px; letter-spacing: 0.02em; }
.slide-title { font-size: 1.3em; margin: 0 0 0.5em; }
.slide-subtitle { font-size: 1.05em; color: #555; margin: 0 0 0.6em; }
.slide .shape { margin: 0 0 0.6em; }
.slide .images { display: flex; flex-wrap: wrap; gap: 8px; margin: 0.4em 0; }
.slide .images img { max-height: 320px; object-fit: contain; border-radius: 4px; }
.sheet-tabs { margin: 12px 14px 0; display: flex; flex-wrap: wrap; gap: 6px; }
.sheet-tabs a { font-size: 13px; text-decoration: none; color: #2B2B2B; background: #FFFFFF;
  border-radius: 999px; padding: 4px 12px; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12); }
.sheet { margin: 12px; background: #FFFFFF; border-radius: 12px; padding: 14px 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.14); }
.sheet h2 { font-size: 1.05em; margin: 0 0 8px; }
.sheet table { font-size: 13px; }
.sheet td { white-space: pre-wrap; min-width: 3em; max-width: 22em; }
.sheet th { background: #F4F3F0; color: #6F6E69; font-weight: 600; text-align: center; position: sticky; top: 0; }
.sheet th.row { position: sticky; left: 0; }
.sheet td.num { text-align: right; font-variant-numeric: tabular-nums; }
.sheet-note { font-size: 12px; color: #8A8984; margin-top: 8px; }
.plain { white-space: pre-wrap; font-size: 14px; line-height: 1.6; }
.markdown p, .markdown li { white-space: normal; }
.markdown ul, .markdown ol { padding-left: 1.4em; margin: 0 0 0.6em; }
.markdown li { margin: 0.15em 0; }
.markdown li > p { margin: 0 0 0.3em; }
.markdown pre { background: #F6F5F2; border-radius: 8px; padding: 10px 12px; overflow-x: auto;
  font-size: 13px; line-height: 1.5; }
.markdown code { font-family: ui-monospace, "SFMono-Regular", Menlo, "Roboto Mono", monospace;
  background: #F1F0ED; border-radius: 4px; padding: 0.1em 0.35em; font-size: 0.9em; }
.markdown pre code { background: none; padding: 0; white-space: pre; }
.markdown blockquote { margin: 0.6em 0; padding: 0.1em 0.9em; border-left: 3px solid #D4D2CC; color: #555; }
.markdown hr { border: none; border-top: 1px solid #E2E0DA; margin: 1.2em 0; }
.markdown table { margin: 0.6em 0; display: block; overflow-x: auto; }
.markdown th { background: #F4F3F0; }
.markdown input[type=checkbox] { margin: 0 0.4em 0 0; }
.markdown table.front-matter { display: table; font-size: 12px; color: #6F6E69; margin: 0 0 1em; }
.markdown table.front-matter th { background: #F4F3F0; font-weight: 600; }
</style>
</head>
<body>
$body
</body>
</html>"""
}

internal fun noticeHtml(text: String): String = "<div class=\"notice\">${text.htmlEscape()}</div>"

/** Relative URL the SVG preview page loads the image from; the viewer serves the file there. */
const val SVG_PREVIEW_SOURCE = "source.svg"

/**
 * SVG files are shown through an `<img>` element, which scales them to the
 * screen and never runs scripts embedded in the drawing.
 */
fun svgPreviewHtml(darkCanvas: Boolean): String = previewHtmlPage(
    "<div class=\"page\" style=\"padding:10px\"><img src=\"$SVG_PREVIEW_SOURCE\" style=\"width:100%;height:auto\" alt=\"\"></div>",
    darkCanvas,
)
