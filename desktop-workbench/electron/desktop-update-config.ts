import fs from "node:fs";
import path from "node:path";
import {
  parseDesktopProductMetadata,
  type DesktopProductMetadata,
} from "./desktop-product-version";

export type DesktopUpdateRuntimeConfig = DesktopProductMetadata & {
  statePath: string;
  downloadDirectory: string;
  automaticCheckDelayMs: number | undefined;
};

type DesktopUpdateRuntimeConfigOptions = {
  packaged: boolean;
  packageMetadata: unknown;
  environment: NodeJS.ProcessEnv;
  userDataPath: string;
  tempPath: string;
};

const MAX_TEST_DELAY_MS = 24 * 60 * 60 * 1_000;

export function resolveDesktopUpdateRuntimeConfig(
  options: DesktopUpdateRuntimeConfigOptions,
): DesktopUpdateRuntimeConfig {
  const packagedMetadata = parseDesktopProductMetadata(options.packageMetadata);
  const defaults: DesktopUpdateRuntimeConfig = {
    ...packagedMetadata,
    statePath: path.join(options.userDataPath, "desktop-update-state.json"),
    downloadDirectory: path.join(options.userDataPath, "updates"),
    automaticCheckDelayMs: undefined,
  };
  if (options.packaged) return defaults;

  const productVersion = optionalEnvironmentValue(
    options.environment,
    "WORKBENCH_PRODUCT_VERSION_OVERRIDE",
  ) ?? packagedMetadata.productVersion;
  const versionCodeValue = optionalEnvironmentValue(
    options.environment,
    "WORKBENCH_VERSION_CODE_OVERRIDE",
  );
  const versionCode = versionCodeValue === undefined
    ? packagedMetadata.versionCode
    : parsePositiveInteger(versionCodeValue, "WORKBENCH_VERSION_CODE_OVERRIDE");
  const metadata = parseDesktopProductMetadata({ productVersion, versionCode });
  const statePathValue = optionalEnvironmentValue(
    options.environment,
    "WORKBENCH_UPDATE_STATE_PATH",
  );
  const downloadDirectoryValue = optionalEnvironmentValue(
    options.environment,
    "WORKBENCH_UPDATE_DOWNLOAD_DIR",
  );
  const delayValue = optionalEnvironmentValue(
    options.environment,
    "WORKBENCH_UPDATE_DELAY_MS",
  );

  return {
    ...metadata,
    statePath: statePathValue === undefined
      ? defaults.statePath
      : validateAbsoluteTestPath(statePathValue, {
          name: "WORKBENCH_UPDATE_STATE_PATH",
          requireJsonFile: true,
          allowedRoots: [options.userDataPath, options.tempPath],
        }),
    downloadDirectory: downloadDirectoryValue === undefined
      ? defaults.downloadDirectory
      : validateAbsoluteTestPath(downloadDirectoryValue, {
          name: "WORKBENCH_UPDATE_DOWNLOAD_DIR",
          requireJsonFile: false,
          allowedRoots: [options.userDataPath, options.tempPath],
        }),
    automaticCheckDelayMs: delayValue === undefined
      ? undefined
      : parseDelay(delayValue),
  };
}

function optionalEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function parseDelay(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("WORKBENCH_UPDATE_DELAY_MS must be a non-negative integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_TEST_DELAY_MS) {
    throw new Error(`WORKBENCH_UPDATE_DELAY_MS must not exceed ${MAX_TEST_DELAY_MS}.`);
  }
  return parsed;
}

function validateAbsoluteTestPath(
  value: string,
  options: { name: string; requireJsonFile: boolean; allowedRoots: string[] },
): string {
  if (value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(`${options.name} must be an absolute path.`);
  }
  const resolved = path.resolve(value);
  const allowed = options.allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    if (!isStrictDescendant(resolved, resolvedRoot)) return false;
    return isStrictDescendant(
      canonicalizePotentialPath(resolved),
      canonicalizePotentialPath(resolvedRoot),
    );
  });
  if (!allowed) {
    throw new Error(`${options.name} must be inside the app temp or userData directory.`);
  }
  if (options.requireJsonFile && path.extname(resolved).toLowerCase() !== ".json") {
    throw new Error(`${options.name} must point to a .json file.`);
  }
  return resolved;
}

function canonicalizePotentialPath(candidate: string): string {
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = fs.realpathSync.native(existing);
  return path.resolve(realExisting, path.relative(existing, candidate));
}

function isStrictDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative);
}
