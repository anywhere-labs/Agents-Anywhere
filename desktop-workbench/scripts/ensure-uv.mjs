import { ensureUvBundle } from "./prepare-uv.mjs";

ensureUvBundle({ log: (message) => console.log(message) })
  .then((paths) => {
    for (const executablePath of paths) console.log(`uv bundle ready: ${executablePath}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
