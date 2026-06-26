import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (globalThis as any).process?.env ?? {};
const apiTarget = (env.AGENTS_ANYWHERE_API as string | undefined) ?? "http://127.0.0.1:8000";
const allowedHosts = ((env.AGENTS_ANYWHERE_ALLOWED_HOSTS as string | undefined) ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig(() => ({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts,
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
