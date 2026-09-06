import assert from "node:assert/strict"
import test from "node:test"

import {
  findSessionFileTargetEntry,
  resolveSessionFilePath,
  resolveSessionFileTargetMetadata,
  sameSessionFilePath,
  sessionFileListRepresentsDirectory,
  sessionFileParentPath,
  sessionFilePathNeedsCanonicalHome,
  sessionFileTreeAllowed,
} from "../src/components/session/session-file-preview-model.ts"

test("message attachments never expose a device file tree", () => {
  assert.equal(sessionFileTreeAllowed(null), true)
  assert.equal(sessionFileTreeAllowed({
    source: "workspace",
    name: "main.ts",
    path: "src/main.ts",
    root: "/repo",
  }), true)
  assert.equal(sessionFileTreeAllowed({
    source: "attachment",
    name: "brief.pdf",
    path: "brief.pdf",
    root: "/repo",
    sourceUrl: "/api/attachments/brief.pdf",
  }), false)
})

test("workspace preview paths resolve relative POSIX segments and Windows separators", () => {
  assert.equal(resolveSessionFilePath("/repo/app", "src/../src/main.ts"), "/repo/app/src/main.ts")
  assert.equal(resolveSessionFilePath("C:\\Users\\Ada\\repo", "src\\Main.ts"), "C:/Users/Ada/repo/src/Main.ts")
  assert.equal(resolveSessionFilePath("C:\\Users\\Ada\\repo", "\\src\\Main.ts", true), "C:/src/Main.ts")
  assert.equal(resolveSessionFilePath("C:\\Users\\Ada\\repo", "C:src\\Main.ts", true), "C:/Users/Ada/repo/src/Main.ts")
  assert.equal(resolveSessionFilePath("\\\\server\\share\\repo", "\\src\\Main.ts", true), "//server/share/src/Main.ts")
  assert.equal(resolveSessionFilePath("/repo", "C:/temp/a.txt", false), "/repo/C:/temp/a.txt")
  assert.equal(resolveSessionFilePath("~", "../Shared"), "Shared")
  assert.equal(resolveSessionFilePath("~", "~/../Shared"), "~/../Shared")
  assert.equal(resolveSessionFilePath("~", "~/../Shared", false, "/Users/ada"), "/Users/Shared")
  assert.equal(resolveSessionFilePath("~", "."), "~")
  assert.equal(sessionFilePathNeedsCanonicalHome("~/project/main.ts"), true)
  assert.equal(sessionFilePathNeedsCanonicalHome("project/main.ts"), false)
  assert.equal(sessionFileParentPath("~"), "")
  assert.equal(sessionFileParentPath("C:\\Users\\Ada\\repo\\src\\Main.ts"), "C:/Users/Ada/repo/src")
})

test("connector list results distinguish directory targets from their parent directories", () => {
  assert.equal(sessionFileListRepresentsDirectory("/repo/src", "/repo", "src"), true)
  assert.equal(sessionFileListRepresentsDirectory("/repo/src", "/repo", "src/main.ts"), false)
  assert.equal(sessionFileListRepresentsDirectory("/Users/ada", "~", "."), true)
  assert.equal(sessionFileListRepresentsDirectory("/Users/ada/project", "~", "project"), true)
  assert.equal(sessionFileListRepresentsDirectory("/Users/ada/Shared", "~", "../Shared"), true)
  assert.equal(sessionFileListRepresentsDirectory("/Users/Shared", "~", "~/../Shared", false, "/Users/ada"), true)
  assert.equal(sessionFileListRepresentsDirectory("C:\\src", "C:\\Users\\Ada\\repo", "\\src", true), true)
  assert.equal(sessionFileListRepresentsDirectory("\\\\server\\share\\src", "\\\\server\\share\\repo", "\\src", true), true)
})

test("workspace target lookup returns the canonical connector entry", () => {
  const entries = [
    { name: "components", path: "/repo/src/components", type: "directory" },
    { name: "main.ts", path: "/repo/src/main.ts", type: "file", size: 42 },
  ]

  assert.deepEqual(
    findSessionFileTargetEntry(entries, "/repo", "src/main.ts"),
    entries[1],
  )
  assert.deepEqual(
    findSessionFileTargetEntry(entries, "/repo", "src/components"),
    entries[0],
  )
  assert.equal(findSessionFileTargetEntry(entries, "/repo", "src/missing.ts"), null)

  const windowsEntries = [
    { name: "Main.ts", path: "C:\\src\\Main.ts", type: "file", size: 42 },
  ]
  assert.deepEqual(
    findSessionFileTargetEntry(windowsEntries, "C:\\Users\\Ada\\repo", "\\src\\main.ts", true),
    windowsEntries[0],
  )
  assert.deepEqual(
    findSessionFileTargetEntry(
      [{ name: "notes.txt", path: "/Users/Shared/notes.txt", type: "file", size: 3 }],
      "~",
      "~/../Shared/notes.txt",
      false,
      "/Users/ada",
    ),
    { name: "notes.txt", path: "/Users/Shared/notes.txt", type: "file", size: 3 },
  )
  assert.equal(findSessionFileTargetEntry(
    [{ name: "main.ts", path: "/repo/main.ts", type: "file", size: 3 }],
    "/repo",
    "missing/deep/main.ts",
    false,
    "/repo",
  ), null)
})

test("path comparison tolerates unresolved home roots and Windows casing", () => {
  assert.equal(sameSessionFilePath("/Users/ada/project/main.ts", "~/project/main.ts"), true)
  assert.equal(sameSessionFilePath("C:\\Users\\ADA\\Main.ts", "c:/users/ada/main.ts", true), true)
  assert.equal(sameSessionFilePath("/repo/C:/Temp/a.txt", "/repo/C:/temp/a.txt"), false)
})

test("connector target metadata preserves canonical directory and file identities", () => {
  assert.deepEqual(resolveSessionFileTargetMetadata({
    path: "/private/tmp/project/src",
    targetPath: "/private/tmp/project/src",
    targetType: "directory",
    entries: [{ name: "main.ts", path: "/private/tmp/project/src/main.ts", type: "file" }],
  }), {
    kind: "directory",
    browsePath: "/private/tmp/project/src",
    targetPath: "/private/tmp/project/src",
    entry: null,
  })

  const mainEntry = { name: "main.ts", path: "/private/tmp/project/src/main.ts", type: "file", size: 42 }
  assert.deepEqual(resolveSessionFileTargetMetadata({
    path: "/private/tmp/project/src",
    targetPath: "/private/tmp/project/src/main.ts",
    targetType: "file",
    entries: [mainEntry],
  }), {
    kind: "file",
    browsePath: "/private/tmp/project/src",
    targetPath: "/private/tmp/project/src/main.ts",
    entry: mainEntry,
  })
})

test("connector target metadata follows absolute and final symlink targets", () => {
  const absoluteEntry = { name: "a.md", path: "/real/docs/a.md", type: "file" }
  assert.deepEqual(resolveSessionFileTargetMetadata({
    path: "/real/docs",
    targetPath: "/real/docs/a.md",
    targetType: "file",
    entries: [absoluteEntry],
  })?.entry, absoluteEntry)

  assert.equal(resolveSessionFileTargetMetadata({
    path: "/real/dir",
    targetPath: "/real/dir",
    targetType: "directory",
    entries: [],
  })?.kind, "directory")

  const symlinkFileEntry = { name: "README.md", path: "/real/docs/README.md", type: "file" }
  const symlinkFile = resolveSessionFileTargetMetadata({
    path: "/real/docs",
    targetPath: "/real/docs/README.md",
    targetType: "file",
    entries: [symlinkFileEntry],
  })
  assert.equal(symlinkFile?.targetPath, "/real/docs/README.md")
  assert.deepEqual(symlinkFile?.entry, symlinkFileEntry)
})

test("missing connector targets never select a same-named ancestor entry", () => {
  assert.deepEqual(resolveSessionFileTargetMetadata({
    path: "/real/repo",
    targetPath: "/real/repo/missing/deep/main.ts",
    targetType: "missing",
    entries: [{ name: "main.ts", path: "/real/repo/main.ts", type: "file" }],
  }), {
    kind: "unresolved",
    browsePath: "/real/repo",
    targetPath: "/real/repo/missing/deep/main.ts",
    entry: null,
  })

  assert.equal(resolveSessionFileTargetMetadata({
    path: "/real/repo",
    targetPath: "/real/repo/missing-target",
    targetType: "missing",
    entries: [],
  })?.kind, "unresolved")
  assert.equal(resolveSessionFileTargetMetadata({
    path: "/repo",
    entries: [],
  }), null)
})

test("connector target metadata matches canonical Windows entries case-insensitively", () => {
  const entry = { name: "Main.ts", path: "C:\\Users\\Ada\\repo\\src\\Main.ts", type: "file" }
  assert.deepEqual(resolveSessionFileTargetMetadata({
    path: "C:\\Users\\Ada\\repo\\src",
    targetPath: "c:\\users\\ada\\repo\\src\\main.ts",
    targetType: "file",
    entries: [entry],
  }, true)?.entry, entry)
})
