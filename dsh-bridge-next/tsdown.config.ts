import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import ts from 'typescript'
import { clientCss } from './scripts/client-css.ts'

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
    // Oxc currently preserves standard decorators. Lower only the Remote
    // service with TypeScript so the published Host runs in plain Node.js.
    plugins: [{
      name: 'standard-remote-decorators',
      transform(code, id) {
        // Module ids keep the platform separator, so compare a normalized path.
        if (!id.replaceAll('\\', '/').endsWith('/rpc/service.ts')) return
        const output = ts.transpileModule(code, {
          fileName: id,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true, experimentalDecorators: false },
        })
        return { code: output.outputText, map: output.sourceMapText! }
      },
    }],
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
      neverBundle: ['@deepseek-ai/cordis', 'react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
      alwaysBundle: ['clsx', 'lucide-react'],
    },
    plugins: [clientCss(packageId, fileURLToPath(new URL('.', import.meta.url)))],
    // tsdown selects Node resolution for CJS output. Prefer ESM dependencies
    // in this browser factory so unused Lucide icons are tree-shaken away.
    inputOptions: (options, _format, { cjsDts }) => cjsDts ? options : {
      ...options,
      resolve: { ...options.resolve, mainFields: ['browser', 'module', 'main'] },
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
