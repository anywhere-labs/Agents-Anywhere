import assert from "node:assert/strict";
import test from "node:test";
import { validateTitleBarColors } from "./title-bar";

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
