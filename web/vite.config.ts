import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.AGENTS_ANYWHERE_API || "http://127.0.0.1:8000";
  const allowedHosts = (env.AGENTS_ANYWHERE_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  return {
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
  };
});
