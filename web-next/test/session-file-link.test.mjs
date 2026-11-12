import assert from "node:assert/strict"
import test from "node:test"

import {
  decodePercentEscapes,
  inlineCodeFilePath,
  isExternalMarkdownHref,
  markdownUrlTransform,
  sessionFileLinkPath,
} from "../src/lib/session-file-link.ts"

test("markdownUrlTransform keeps file:// URIs instead of blanking them", () => {
  assert.equal(markdownUrlTransform("file:///tmp/report.pdf"), "file:///tmp/report.pdf")
  assert.equal(markdownUrlTransform("file:///C:/Users/me/报告.pdf"), "file:///C:/Users/me/报告.pdf")
})

test("markdownUrlTransform keeps relative and Windows-drive destinations", () => {
  assert.equal(markdownUrlTransform("out/report.pdf"), "out/report.pdf")
  assert.equal(markdownUrlTransform("../docs/a.md"), "../docs/a.md")
  assert.equal(markdownUrlTransform("C:\\Users\\me\\a.txt"), "C:\\Users\\me\\a.txt")
  assert.equal(markdownUrlTransform("~/a.txt"), "~/a.txt")
})

test("markdownUrlTransform keeps safe web schemes and strips dangerous ones", () => {
  assert.equal(markdownUrlTransform("https://example.com"), "https://example.com")
  assert.equal(markdownUrlTransform("mailto:a@example.com"), "mailto:a@example.com")
  assert.equal(markdownUrlTransform("javascript:alert(1)"), "")
  assert.equal(markdownUrlTransform("data:text/plain,hi"), "")
})

test("isExternalMarkdownHref classifies web, anchors and file destinations", () => {
  assert.equal(isExternalMarkdownHref("https://example.com"), true)
  assert.equal(isExternalMarkdownHref("mailto:a@example.com"), true)
  assert.equal(isExternalMarkdownHref("//cdn.example/x.js"), true)
  assert.equal(isExternalMarkdownHref("#L12"), true)
  assert.equal(isExternalMarkdownHref("file:///tmp/a.pdf"), false)
  assert.equal(isExternalMarkdownHref("out/a.pdf"), false)
  assert.equal(isExternalMarkdownHref("C:\\Users\\me\\a.txt"), false)
})

test("sessionFileLinkPath decodes file:// URIs including percent-encoding", () => {
  assert.equal(sessionFileLinkPath("file:///tmp/report.pdf"), "/tmp/report.pdf")
  assert.equal(sessionFileLinkPath("file://localhost/tmp/a.html"), "/tmp/a.html")
  assert.equal(sessionFileLinkPath("file:///Users/me/My%20Docs/%E6%8A%A5%E5%91%8A.pdf"), "/Users/me/My Docs/报告.pdf")
  assert.equal(sessionFileLinkPath("file:///C:/Users/me/%E6%8A%A5%E5%91%8A.docx"), "C:/Users/me/报告.docx")
  assert.equal(sessionFileLinkPath("file://server/share/deck.pptx"), "//server/share/deck.pptx")
})

test("sessionFileLinkPath handles plain, tilde, drive and spaced paths", () => {
  assert.equal(sessionFileLinkPath("/work/app.swift"), "/work/app.swift")
  assert.equal(sessionFileLinkPath("~/work/app.swift"), "~/work/app.swift")
  assert.equal(sessionFileLinkPath("C:\\Users\\me\\a.txt"), "C:\\Users\\me\\a.txt")
  assert.equal(sessionFileLinkPath("out/季度 报告.pdf"), "out/季度 报告.pdf")
  assert.equal(sessionFileLinkPath("<file:///tmp/a b.pdf>"), "/tmp/a b.pdf")
})

test("sessionFileLinkPath strips line and column suffixes", () => {
  assert.equal(sessionFileLinkPath("/work/app.swift:12"), "/work/app.swift")
  assert.equal(sessionFileLinkPath("/work/app.swift:12:3"), "/work/app.swift")
  assert.equal(sessionFileLinkPath("/work/app.swift#L12"), "/work/app.swift")
  assert.equal(sessionFileLinkPath("/work/app.swift#L8C3"), "/work/app.swift")
})

test("sessionFileLinkPath returns null for non-file destinations", () => {
  assert.equal(sessionFileLinkPath("https://example.com"), null)
  assert.equal(sessionFileLinkPath("mailto:a@example.com"), null)
  assert.equal(sessionFileLinkPath("//cdn.example/x.js"), null)
  assert.equal(sessionFileLinkPath("#top"), null)
  assert.equal(sessionFileLinkPath(""), null)
})

test("decodePercentEscapes round-trips UTF-8 and keeps invalid escapes raw", () => {
  assert.equal(decodePercentEscapes("%E6%8A%A5%E5%91%8A"), "报告")
  assert.equal(decodePercentEscapes("My%20Docs"), "My Docs")
  assert.equal(decodePercentEscapes("100%.md"), null)
  assert.equal(decodePercentEscapes("no escapes"), null)
})

test("inlineCodeFilePath keeps file references and rejects commands", () => {
  assert.equal(inlineCodeFilePath("docs/报告 终稿.pdf:3"), "docs/报告 终稿.pdf")
  assert.equal(inlineCodeFilePath("file:///tmp/a%20b.html"), "/tmp/a b.html")
  assert.equal(inlineCodeFilePath("报告.pdf"), "报告.pdf")
  assert.equal(inlineCodeFilePath("src/main.ts"), "src/main.ts")
  assert.equal(inlineCodeFilePath("console.log"), null)
  assert.equal(inlineCodeFilePath("ls -la out/report.pdf"), null)
  assert.equal(inlineCodeFilePath("open out/a.pdf"), null)
})