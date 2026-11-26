// electron-builder afterPack hook: copy the staged connector's node_modules into the app.
// electron-builder never copies `node_modules` directories through `extraResources`, but the bundled
// connector-v3 needs its dependency closure (meshcall, ws, zod, ajv, the platform's meshcall-router binary).

const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, "build", "connector", "node_modules");
  if (!existsSync(source)) throw new Error(`missing ${source}: run \`yarn build:connector\` first`);
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const target = path.join(resources, "connector", "node_modules");
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  console.log(`  • copied connector node_modules → ${path.relative(context.appOutDir, target)}`);
};
