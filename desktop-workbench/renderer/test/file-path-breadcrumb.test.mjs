import assert from "node:assert/strict"
import test from "node:test"

import { filePathBreadcrumbParent, filePathBreadcrumbSegments } from "../src/lib/file-path-breadcrumb.ts"

test("breadcrumb navigation preserves absolute, relative, and home paths", () => {
  for (const [path, targets] of [
    ["/Users/ada/project/a.md", ["/Users", "/Users/ada", "/Users/ada/project", "/Users/ada/project/a.md"]],
    ["src/lib/a.ts", ["src", "src/lib", "src/lib/a.ts"]],
    ["~/project", ["~", "~/project"]],
    ["/", ["/"]],
    ["", ["."]],
  ]) {
    assert.deepEqual(filePathBreadcrumbSegments(path).map((segment) => segment.path), targets)
  }
})

test("picker lists siblings without navigating above filesystem roots", () => {
  for (const [path, parent] of [
    ["/repo/src/components", "/repo/src"],
    ["/repo/src/a.ts", "/repo/src"],
    ["/Users", "/"],
    ["/", "/"],
    ["C:\\Users", "C:/"],
    ["C:/", "C:/"],
    ["//server/share", "//server/share"],
    ["//server/share/docs", "//server/share"],
    ["~/src", "~"],
    ["~", "~"],
    ["src", "."],
  ]) assert.equal(filePathBreadcrumbParent(path), parent)
})

test("Windows drive and UNC roots remain valid directory destinations", () => {
  assert.deepEqual(filePathBreadcrumbSegments("C:\\Users\\Ada").map((segment) => segment.path), [
    "C:/", "C:/Users", "C:/Users/Ada",
  ])
  assert.deepEqual(filePathBreadcrumbSegments("\\\\server\\share\\docs\\a.md"), [
    { label: "server/share", path: "//server/share" },
    { label: "docs", path: "//server/share/docs" },
    { label: "a.md", path: "//server/share/docs/a.md" },
  ])
})
