/** Desktop-local environment lifecycle; independent of Connector ownership. */
export type ConnectorEnvironmentState = {
  status: "unknown" | "checking" | "preparing" | "ready" | "stale" | "failed" | "cancelled";
  phase: "checking" | "downloading" | "resolving" | "building" | "syncing" | "ready" | "failed" | "cancelled";
  event: string;
  message: string;
  startedAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  stalled: boolean;
  mirrors?: { pypiIndexUrl: string; pythonInstallMirror: string; downloadsPython: boolean };
  progress?: { package?: string; totalBytes?: number; downloadedBytes?: number; completedPackages?: number; totalPackages?: number };
  error?: { kind: "network" | "resolution" | "permission" | "disk" | "process" | "busy" | "unknown"; message: string };
  exitCode?: number | null;
  stderr?: string;
};
