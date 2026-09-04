import assert from "node:assert/strict";
import test from "node:test";
import {
  compareProductVersions,
  isNumericProductVersion,
  parseDesktopProductMetadata,
} from "./desktop-product-version";

test("product versions compare every numeric component", () => {
  assert.equal(compareProductVersions("0.1.7.2", "0.1.7.1"), 1);
  assert.equal(compareProductVersions("0.1.7.2", "0.1.8"), -1);
  assert.equal(compareProductVersions("1.2", "1.2.0.0"), 0);
});

test("desktop product metadata keeps npm and product versions independent", () => {
  assert.deepEqual(
    parseDesktopProductMetadata({
      version: "0.1.7-2",
      productVersion: "0.1.7.2",
      versionCode: 6,
    }),
    { productVersion: "0.1.7.2", versionCode: 6 },
  );
  assert.equal(isNumericProductVersion("0.1.7.2"), true);
  assert.equal(isNumericProductVersion("0.1.7-2"), false);
  assert.equal(isNumericProductVersion("999999999999999999999.1"), false);
  assert.throws(
    () => parseDesktopProductMetadata({ productVersion: "0.1.7-2", versionCode: 6 }),
    /productVersion/,
  );
  assert.throws(
    () => parseDesktopProductMetadata({ productVersion: "0.1.7.2", versionCode: 0 }),
    /versionCode/,
  );
});
