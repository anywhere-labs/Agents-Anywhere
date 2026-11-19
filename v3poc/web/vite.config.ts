import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { shared } from './vite.shared.ts'

// The demo web app (index.html). renderer.html is also served in dev; its single-file build is vite.renderer.config.ts.
export default defineConfig({
  ...shared,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html') } },
  },
})
