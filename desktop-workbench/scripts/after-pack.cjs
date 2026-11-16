/**
 * electron-builder `afterPack` hook: copies the pre-installed Pi runtime
 * (`build/pi-runtime`, see prepare-pi-runtime.mjs) into the app's resources.
 *
 * extraResources cannot carry it: electron-builder drops every `node_modules`
 * directory there. This runs before signing, so macOS signs the native modules
 * inside like any other code in the bundle.
 */
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.resolve(__dirname, "..", "build", "pi-runtime");

exports.default = async function afterPack(context) {
  if (!fs.existsSync(path.join(SOURCE, "package.json"))) {
    throw new Error(`The Pi runtime bundle is missing: run \`yarn bundle:pi\` first (${SOURCE})`);
  }
  const resources = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const destination = path.join(resources, "pi-runtime");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(SOURCE, destination, { recursive: true, verbatimSymlinks: true });
  // The build stamp only decides whether to reinstall; the app does not read it.
  fs.rmSync(path.join(destination, "PI_RUNTIME.json"), { force: true });
};
