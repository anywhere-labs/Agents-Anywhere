// Test-only module hooks for code that runs outside vitest (worker threads): resolves `./x.js` to `./x.ts`
// when only the TypeScript source exists. Node strips the types (`--experimental-transform-types`).
import { register } from 'node:module'

register(new URL('./ts-resolve-hooks.mjs', import.meta.url))
