import assert from "node:assert/strict";
import test from "node:test";
import { validateTitleBarColors, validateWindowTheme } from "./title-bar";

test("title bar accepts sidebar colors for both themes", () => {
  for (const colors of [
    { color: "#171717", symbolColor: "#fafafa" },
    { color: "#fafafa", symbolColor: "#0a0a0a" },
  ]) {
    assert.deepEqual(validateTitleBarColors(colors), colors);
  }
});

test("title bar rejects malformed IPC colors and ignores unrelated options", () => {
  for (const input of [null, undefined, "dark", {}, { color: "red", symbolColor: "#ffffff" },
    { color: "#171717", symbolColor: 123 }, { color: "#171717", symbolColor: "#fff" }]) {
    assert.throws(() => validateTitleBarColors(input), /Invalid title bar colors/);
  }
  assert.deepEqual(validateTitleBarColors({ color: "#171717", symbolColor: "#FAFAFA", height: 500 }),
    { color: "#171717", symbolColor: "#FAFAFA" });
});

test("window theme accepts system so the native theme keeps following the OS appearance", () => {
  for (const theme of ["light", "dark", "system"] as const) {
    assert.equal(validateWindowTheme(theme), theme);
  }
  for (const input of [null, undefined, "", "auto", "Dark", 1, {}]) {
    assert.throws(() => validateWindowTheme(input), /Invalid window theme/);
  }
});
