import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Markdown } from "@/components/conversation/markdown"
import { driveHref } from "@/lib/drive/paths"
import { driveLocationOf, driveRefHref, driveRefOfHref, findDriveRefs, isDriveRef } from "@/lib/drive/refs"
import type { DriveFileView } from "@/lib/types/v3"

const refs = (text: string) => findDriveRefs(text).map((m) => m.ref)

describe("drive references in text", () => {
  it("ends a reference at whitespace, brackets and quotes, and leaves trailing punctuation out", () => {
    expect(refs("已保存到 drive:/报告/2026/q3.pdf。")).toEqual(["drive:/报告/2026/q3.pdf"])
    expect(refs("See drive:/a/b.txt, then drive:/c.")).toEqual(["drive:/a/b.txt", "drive:/c"])
    expect(refs("(drive:/Transfers/q3%20%281%29.pdf)")).toEqual(["drive:/Transfers/q3%20%281%29.pdf"])
    expect(refs('"drive:/x.md" | drive:/y.md')).toEqual(["drive:/x.md", "drive:/y.md"])
    expect(refs("根目录是 drive:/ 。")).toEqual(["drive:/"])
    expect(refs("DRIVE:/A.txt")).toEqual(["DRIVE:/A.txt"])
  })

  it("ends at Chinese sentence punctuation, which the next sentence follows without a space", () => {
    expect(refs("文件在 drive:/报告/q3.pdf。文件夹是 drive:/报告，备份在 drive:/备份、drive:/归档！")).toEqual([
      "drive:/报告/q3.pdf",
      "drive:/报告",
      "drive:/备份",
      "drive:/归档",
    ])
    expect(refs("纪要是drive:/纪要%EF%BC%8C第二版.md？")).toEqual(["drive:/纪要%EF%BC%8C第二版.md"])
  })

  it("keeps full-width brackets a name has, drops those around the reference", () => {
    expect(refs("文件在drive:/报告（终版）.pdf")).toEqual(["drive:/报告（终版）.pdf"])
    expect(refs("（见 drive:/报告/q3.pdf）")).toEqual(["drive:/报告/q3.pdf"])
    expect(refs("“drive:/a/b.md”和「drive:/c（1）.md」")).toEqual(["drive:/a/b.md", "drive:/c（1）.md"])
  })

  it("keeps a name's own punctuation inside angle brackets", () => {
    const text = "见 <drive:/报告/终版.> 。"
    expect(findDriveRefs(text)).toEqual([{ start: text.indexOf("<"), end: text.indexOf(">") + 1, ref: "drive:/报告/终版." }])
  })

  it("takes nothing inside a word or a URL, nor drive://", () => {
    expect(refs("mydrive:/x https://h.dev/drive:/y drive://acct/z")).toEqual([])
    expect(isDriveRef("drive://acct/z")).toBe(false)
    expect(isDriveRef("drive:/a b.pdf")).toBe(true)
  })
})

describe("drive reference links", () => {
  it("round-trips a reference through its link to the drive page", () => {
    for (const ref of ["drive:/报告/q3.pdf", "drive:/Transfers/q3%20%281%29.pdf", "drive:/"]) {
      expect(driveRefOfHref(driveRefHref(ref))).toBe(ref)
    }
    expect(driveRefOfHref("https://example.com/drive?ref=x")).toBeNull()
    expect(driveRefOfHref("/drive?path=/a")).toBeNull()
  })

  it("opens a folder itself and a file in its folder", () => {
    const file = (id: string, parent: string) => ({ id, parent_path: parent }) as DriveFileView
    expect(driveLocationOf({ kind: "folder", path: "/报告/2026", file: null })).toBe(driveHref("/报告/2026"))
    expect(driveLocationOf({ kind: "file", path: "/q3.pdf", file: file("f1", "/") })).toBe("/drive?file=f1")
    expect(driveLocationOf({ kind: "file", path: "/报告/q3.pdf", file: file("f 2", "/报告") })).toBe(`${driveHref("/报告")}&file=f%202`)
  })

  it("links references in a reply, link targets and whole inline code spans, and nothing else", () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {[
          "已保存到 drive:/报告/q3.pdf。",
          "[季报](drive:/报告/q3.pdf) 和 <drive:/报告/终版.>",
          "`drive:/报告` 和 `npm run drive:/x`",
          "```\ndrive:/in/a/code/block\n```",
          "[说明 drive:/inside](https://example.com)",
        ].join("\n\n")}
      </Markdown>
    )
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&"))
    expect(hrefs).toEqual([
      driveRefHref("drive:/报告/q3.pdf"),
      driveRefHref("drive:/报告/q3.pdf"),
      driveRefHref("drive:/报告/终版."),
      driveRefHref("drive:/报告"),
      // Streamdown normalizes web links.
      "https://example.com/",
    ])
    expect(html).toContain(">drive:/报告/q3.pdf</a>。")
    expect(html).toContain("drive:/in/a/code/block")
  })
})
