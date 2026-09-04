import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDesktopUpdateRuntimeConfig } from "./desktop-update-config";

const PACKAGE_METADATA = { productVersion: "0.1.7.2", versionCode: 6 };

test("development update overrides are validated and isolated", () => {
  const harness = createPathHarness();
  try {
    const statePath = path.join(harness.tempPath, "update-test", "choice.json");
    const downloadDirectory = path.join(harness.userDataPath, "update-test", "downloads");
    const config = resolveDesktopUpdateRuntimeConfig({
      packaged: false,
      packageMetadata: PACKAGE_METADATA,
      environment: {
        WORKBENCH_PRODUCT_VERSION_OVERRIDE: "0.1.7.1",
        WORKBENCH_VERSION_CODE_OVERRIDE: "5",
        WORKBENCH_UPDATE_DELAY_MS: "0",
        WORKBENCH_UPDATE_STATE_PATH: statePath,
        WORKBENCH_UPDATE_DOWNLOAD_DIR: downloadDirectory,
      },
      userDataPath: harness.userDataPath,
      tempPath: harness.tempPath,
    });

    assert.deepEqual(config, {
      productVersion: "0.1.7.1",
      versionCode: 5,
      statePath,
      downloadDirectory,
      automaticCheckDelayMs: 0,
    });
  } finally {
    harness.cleanup();
  }
});

test("packaged builds ignore every development update override", () => {
  const harness = createPathHarness();
  try {
    const config = resolveDesktopUpdateRuntimeConfig({
      packaged: true,
      packageMetadata: PACKAGE_METADATA,
      environment: {
        WORKBENCH_PRODUCT_VERSION_OVERRIDE: "not-a-version",
        WORKBENCH_VERSION_CODE_OVERRIDE: "not-an-integer",
        WORKBENCH_UPDATE_DELAY_MS: "not-a-delay",
        WORKBENCH_UPDATE_STATE_PATH: "/",
        WORKBENCH_UPDATE_DOWNLOAD_DIR: "/",
      },
      userDataPath: harness.userDataPath,
      tempPath: harness.tempPath,
    });

    assert.deepEqual(config, {
      productVersion: "0.1.7.2",
      versionCode: 6,
      statePath: path.join(harness.userDataPath, "desktop-update-state.json"),
      downloadDirectory: path.join(harness.userDataPath, "updates"),
      automaticCheckDelayMs: undefined,
    });
  } finally {
    harness.cleanup();
  }
});

test("development update paths cannot escape temp or userData", () => {
  const harness = createPathHarness();
  try {
    const outside = path.join(harness.root, "outside");
    fs.mkdirSync(outside);
    assert.throws(
      () => resolveConfig(harness, {
        WORKBENCH_UPDATE_DOWNLOAD_DIR: outside,
      }),
      /inside the app temp or userData/,
    );
    assert.throws(
      () => resolveConfig(harness, {
        WORKBENCH_UPDATE_STATE_PATH: path.join(harness.tempPath, "state.txt"),
      }),
      /\.json file/,
    );
    assert.throws(
      () => resolveConfig(harness, {
        WORKBENCH_UPDATE_DOWNLOAD_DIR: harness.tempPath,
      }),
      /inside the app temp or userData/,
    );

    const symlink = path.join(harness.tempPath, "outside-link");
    fs.symlinkSync(outside, symlink, "dir");
    assert.throws(
      () => resolveConfig(harness, {
        WORKBENCH_UPDATE_DOWNLOAD_DIR: path.join(symlink, "downloads"),
      }),
      /inside the app temp or userData/,
    );
  } finally {
    harness.cleanup();
  }
});

test("development numeric overrides reject malformed or excessive values", () => {
  const harness = createPathHarness();
  try {
    assert.throws(
      () => resolveConfig(harness, { WORKBENCH_VERSION_CODE_OVERRIDE: "5.5" }),
      /positive integer/,
    );
    assert.throws(
      () => resolveConfig(harness, { WORKBENCH_UPDATE_DELAY_MS: "-1" }),
      /non-negative integer/,
    );
    assert.throws(
      () => resolveConfig(harness, { WORKBENCH_UPDATE_DELAY_MS: "86400001" }),
      /must not exceed/,
    );
  } finally {
    harness.cleanup();
  }
});

function createPathHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aa-desktop-update-config-"));
  const userDataPath = path.join(root, "user-data");
  const tempPath = path.join(root, "temp");
  fs.mkdirSync(userDataPath);
  fs.mkdirSync(tempPath);
  return {
    root,
    userDataPath,
    tempPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function resolveConfig(
  harness: ReturnType<typeof createPathHarness>,
  environment: NodeJS.ProcessEnv,
) {
  return resolveDesktopUpdateRuntimeConfig({
    packaged: false,
    packageMetadata: PACKAGE_METADATA,
    environment,
    userDataPath: harness.userDataPath,
    tempPath: harness.tempPath,
  });
}
