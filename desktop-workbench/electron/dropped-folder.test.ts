import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { droppedFolderPath } from "./dropped-folder";

test("a dropped folder resolves to a local directory while files and missing paths are ignored", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aa-dropped-folder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "project");
  const file = path.join(root, "notes.txt");
  await fs.mkdir(directory);
  await fs.writeFile(file, "notes");
  assert.equal(await droppedFolderPath(directory), await fs.realpath(directory));
  assert.equal(await droppedFolderPath(file), null);
  assert.equal(await droppedFolderPath(path.join(root, "missing")), null);
  assert.equal(await droppedFolderPath("relative/project"), null);
  assert.equal(await droppedFolderPath(null), null);
});
