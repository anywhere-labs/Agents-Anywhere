import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const { name: packageId } = createRequire(import.meta.url)('./package.json') as { name: string }

export default defineConfig([
  {
    name: 'host',
    entry: { index: 'src/host/index.ts' },
    tsconfig: 'tsconfig.host.json',
    outDir: 'lib',
    platform: 'node',
    format: 'esm',
    target: 'es2023',
    clean: false,
    sourcemap: true,
    dts: true,
    deps: { neverBundle: true },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  {
    name: 'client',
    entry: { client: 'src/client/index.tsx' },
    tsconfig: 'tsconfig.client.json',
    outDir: 'lib',
    platform: 'browser',
    format: 'cjs',
    target: 'es2023',
    clean: false,
    sourcemap: true,
    dts: true,
    deps: {
      neverBundle: ['@deepseek-ai/cordis', 'react', 'react/jsx-runtime'],
    },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    // The browser wrapper must not be applied to the separate declaration build.
    outputOptions: (options, _format, { cjsDts }) => cjsDts ? options : {
      ...options,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
