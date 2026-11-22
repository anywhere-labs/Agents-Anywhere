#!/usr/bin/env node
// Generate embed/protocol.schema.json (JSON Schema draft-07) from embed/src/protocol.ts: every `aa.render/2` message,
// either way. iOS / Android validate their fixtures and their own outgoing messages against it in tests; the web side
// checks it is current (tests/embed-protocol.test.ts).
//
//   node embed/scripts/gen-schema.mjs [--check]      (run from web-v3/)
import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { createGenerator } from "ts-json-schema-generator"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EMBED = path.join(HERE, "..")
const OUT = path.join(EMBED, "protocol.schema.json")

export function generateProtocolSchema() {
  const generator = createGenerator({
    path: path.join(EMBED, "src", "protocol.ts"),
    tsconfig: path.join(EMBED, "..", "tsconfig.json"),
    type: "BridgeMessage",
    expose: "export",
    topRef: true,
    jsDoc: "extended",
    skipTypeCheck: true,
    additionalProperties: true,
  })
  const schema = generator.createSchema("BridgeMessage")
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://agents-anywhere.dev/schemas/aa.render/2/protocol.schema.json",
    title: "aa.render/2 bridge messages",
    description:
      "Every message between the native iOS / Android apps and the WebView render bundle (docs/v3/mobile-bridge.md). Generated from web-v3/embed/src/protocol.ts by `corepack yarn embed:schema`; do not edit by hand.",
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema")),
  }
}

export function serialize(schema) {
  return JSON.stringify(schema, null, 2) + "\n"
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const next = serialize(generateProtocolSchema())
  if (process.argv.includes("--check")) {
    const current = readFileSync(OUT, "utf8")
    if (current !== next) {
      console.error("embed/protocol.schema.json is out of date: run `corepack yarn embed:schema`")
      process.exit(1)
    }
    console.log("embed/protocol.schema.json is current")
  } else {
    writeFileSync(OUT, next)
    console.log(`wrote ${path.relative(process.cwd(), OUT)} (${Object.keys(JSON.parse(next).definitions ?? {}).length} definitions)`)
  }
}
