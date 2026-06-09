import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (globalThis as any).process?.env ?? {};
const apiTarget = (env.AGENTS_ANYWHERE_API as string | undefined) ?? "http://127.0.0.1:8000";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Surface the backend URL the dev proxy points at so the auth-screen chip
  // can display the *real* backend, not the vite dev origin. In production
  // builds the frontend is served by the backend itself, so we leave this
  // empty and the UI falls back to window.location.origin.
  define: {
    __BACKEND_PUBLIC_URL__: JSON.stringify(command === "serve" ? apiTarget : ""),
  },
  server: {
    port: 5173,
    proxy: {
      "/auth": apiTarget,
      "/admin": apiTarget,
      "/health": apiTarget,
      "/agents": apiTarget,
      "/approvals": apiTarget,
      "/connectors": apiTarget,
      "/pairing": apiTarget,
      "/sessions": { target: apiTarget, ws: true, changeOrigin: true },
      "/connector": { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
}));
