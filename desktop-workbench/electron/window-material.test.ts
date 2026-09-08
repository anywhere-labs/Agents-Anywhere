import assert from "node:assert/strict";
import test from "node:test";
import { windowMaterial, windowMaterialOptions } from "./window-material";

test("Mica is gated at Windows 11 22H2 and never makes the window frameless", () => {
  for (const version of ["10.0.19045", "10.0.22000", "10.0.22620", "unknown"]) {
    assert.equal(windowMaterial("win32", version), "opaque");
    assert.equal(windowMaterialOptions("win32", version).backgroundMaterial, undefined);
  }
  for (const version of ["10.0.22621", "10.0.26100"]) {
    const options = windowMaterialOptions("win32", version);
    assert.equal(windowMaterial("win32", version), "mica");
    assert.equal(options.backgroundMaterial, "mica");
    assert.equal(options.backgroundColor, "#00000000");
    assert.equal(options.transparent, undefined);
    assert.equal(options.frame, undefined);
  }
});

test("macOS uses native sidebar vibrancy while Linux keeps an opaque fallback", () => {
  const mac = windowMaterialOptions("darwin", "25.0.0");
  assert.equal(mac.vibrancy, "sidebar");
  assert.equal(mac.transparent, true);
  assert.equal(mac.visualEffectState, "followWindow");
  const linux = windowMaterialOptions("linux", "6.0.0");
  assert.equal(linux.backgroundColor, "#171717");
  assert.equal(linux.vibrancy, undefined);
  assert.equal(linux.backgroundMaterial, undefined);
});
