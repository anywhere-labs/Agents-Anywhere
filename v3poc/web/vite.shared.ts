import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { UserConfig } from 'vite'

export const shared: UserConfig = {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@protocol': resolve(import.meta.dirname, '../protocol'),
      '@fixtures': resolve(import.meta.dirname, '../fixtures'),
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: { fs: { allow: [resolve(import.meta.dirname, '..')] } },
}
