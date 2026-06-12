/** Tiny HTTP/WS helpers for the runtime panel — workspace fs + terminal endpoints.
 *
 * Runtime filesystem and user terminal operations are connector/workspace-scoped
 * so they can browse, edit, and run shell processes without tying the API shape
 * to a resumable session. Primary Claude terminals remain session-scoped.
 */

export class RuntimeApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    const msg =
      typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : `HTTP ${status}`;
    super(msg);
    this.status = status;
    this.detail = detail;
  }
}

export type FsListEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
  size: number | null;
};

export type FsListResult = {
  path: string;
  entries: FsListEntry[];
  truncated: boolean;
};

export type FsReadTextResult = {
  path: string;
  name: string;
  size: number;
  sha256: string;
  encoding: string;
  content: string;
  truncated: boolean;
  binary: boolean;
  serverTime: string;
};

export type FsReadFileResult = {
  path: string;
  name: string;
  size: number;
  sha256: string;
  transferId: string;
  token: string;
  downloadUrl: string;
};

export type FsWriteResult = {
  path: string;
  encoding: string;
  bytesWritten: number;
  sha256: string;
};

export type TerminalView = {
  terminalId: string;
  sessionId: string;
  label: string;
  cwd: string;
  cols: number;
  rows: number;
  purpose: "user" | "primary_claude";
  pid: number | null;
  status: "starting" | "running" | "exited";
  exitCode: number | null;
  scrollbackBytes: number;
  scrollbackSeq: number;
  ephemeralGroupId?: string | null;
  createdAt: string;
};

export type TerminalCreateArgs = {
  cols: number;
  rows: number;
  label?: string;
  cwd?: string;
  shell?: string;
  command?: string;
  args?: string[];
  profile?: string;
  ephemeralGroupId?: string;
};

export type DemoMode = boolean;

export function makeRuntimeApi(opts: {
  sessionId: string;
  connectorId?: string | null;
  root?: string | null;
  token: string | null;
  demo?: DemoMode;
}) {
  const { sessionId, connectorId, root, token, demo = false } = opts;
  const auth = () => (token ? { authorization: `Bearer ${token}` } : {});
  const connectorFsPath = (suffix: string) => {
    if (!connectorId || !root) {
      throw new RuntimeApiError(409, "workspace filesystem requires connectorId and root");
    }
    return `/connectors/${encodeURIComponent(connectorId)}/fs/${suffix}?root=${encodeURIComponent(root)}`;
  };
  const connectorTerminalPath = (suffix = "") => {
    if (!connectorId || !root) {
      return null;
    }
    const segment = suffix ? `/${suffix}` : "";
    return `/connectors/${encodeURIComponent(connectorId)}/terminals${segment}?root=${encodeURIComponent(root)}`;
  };

  async function call<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    for (const [k, v] of Object.entries(auth())) headers.set(k, v);
    let res: Response;
    try {
      res = await fetch(path, { ...init, headers });
    } catch (e) {
      throw new RuntimeApiError(0, e instanceof Error ? e.message : "network error");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const detail =
        body && typeof body === "object" && "detail" in body
          ? (body as { detail: unknown }).detail
          : body;
      throw new RuntimeApiError(res.status, detail ?? `HTTP ${res.status}`);
    }
    return body as T;
  }

  return {
    sessionId,
    demo,
    fsList(path: string | null): Promise<{ ok: boolean; result: FsListResult }> {
      if (demo) return Promise.resolve(demoFsList(path));
      return call(connectorFsPath("list"), {
        method: "POST",
        body: JSON.stringify({ path }),
      });
    },
    fsReadText(path: string, maxBytes = 1_048_576): Promise<FsReadTextResult> {
      if (demo) return Promise.resolve(demoFsReadText(path));
      return call(connectorFsPath("readText"), {
        method: "POST",
        body: JSON.stringify({ path, maxBytes }),
      });
    },
    fsReadFile(path: string): Promise<{ ok: boolean; result: FsReadFileResult }> {
      if (demo) return Promise.resolve(demoFsReadFile(path));
      return call(connectorFsPath("read"), {
        method: "POST",
        body: JSON.stringify({ path }),
      });
    },
    async fsDownloadBlob(downloadUrl: string): Promise<Blob> {
      const headers = new Headers();
      for (const [k, v] of Object.entries(auth())) headers.set(k, v);
      const res = await fetch(downloadUrl, { headers });
      if (!res.ok) throw new RuntimeApiError(res.status, await res.text());
      return await res.blob();
    },
    fsWrite(
      path: string,
      content: string,
      ifMatch: string | null,
    ): Promise<{ ok: boolean; result: FsWriteResult }> {
      if (demo) return Promise.resolve(demoFsWrite(path, content));
      return call(connectorFsPath("write"), {
        method: "POST",
        body: JSON.stringify({ path, content, ifMatch: ifMatch ?? undefined }),
      });
    },
    listTerminals(): Promise<{ terminals: TerminalView[]; serverTime: string }> {
      if (demo) return Promise.resolve({ terminals: [], serverTime: new Date().toISOString() });
      const connectorPath = connectorTerminalPath();
      if (connectorPath) return call(connectorPath);
      return call(`/sessions/${sessionId}/terminals`);
    },
    createTerminal(args: TerminalCreateArgs): Promise<{ terminal: TerminalView }> {
      if (demo) return Promise.resolve(demoCreateTerminal(args));
      const connectorPath = connectorTerminalPath();
      if (connectorPath) {
        return call(connectorPath, {
          method: "POST",
          body: JSON.stringify(args),
        });
      }
      return call(`/sessions/${sessionId}/terminals`, {
        method: "POST",
        body: JSON.stringify(args),
      });
    },
    ensurePrimaryTerminal(): Promise<{ terminal: TerminalView }> {
      if (demo) return Promise.resolve(demoCreateTerminal({ cols: 120, rows: 36, label: "Claude" }));
      return call(`/sessions/${sessionId}/terminal/ensure-primary`, {
        method: "POST",
      });
    },
    renameTerminal(tid: string, label: string): Promise<{ terminal: TerminalView }> {
      if (demo) return Promise.resolve({ terminal: { ...demoTerminal(tid), label } });
      const connectorPath = connectorTerminalPath(encodeURIComponent(tid));
      if (connectorPath) {
        return call(connectorPath, {
          method: "PATCH",
          body: JSON.stringify({ label }),
        });
      }
      return call(`/sessions/${sessionId}/terminals/${tid}`, {
        method: "PATCH",
        body: JSON.stringify({ label }),
      });
    },
    closeTerminal(tid: string): Promise<{ terminal: TerminalView }> {
      if (demo) return Promise.resolve({ terminal: { ...demoTerminal(tid), status: "exited" } });
      const connectorPath = connectorTerminalPath(encodeURIComponent(tid));
      if (connectorPath) return call(connectorPath, { method: "DELETE" });
      return call(`/sessions/${sessionId}/terminals/${tid}`, { method: "DELETE" });
    },
    resizeTerminal(tid: string, cols: number, rows: number): Promise<{ terminal: TerminalView }> {
      if (demo) return Promise.resolve({ terminal: { ...demoTerminal(tid), cols, rows } });
      const connectorPath = connectorTerminalPath(`${encodeURIComponent(tid)}/resize`);
      if (connectorPath) {
        return call(connectorPath, {
          method: "POST",
          body: JSON.stringify({ cols, rows }),
        });
      }
      return call(`/sessions/${sessionId}/terminals/${tid}/resize`, {
        method: "POST",
        body: JSON.stringify({ cols, rows }),
      });
    },
    streamUrl(tid: string, fromSeq = 0, scope: "workspace" | "session" = "workspace"): string {
      const base = window.location.origin.replace(/^http/, "ws");
      const t = token ? `&token=${encodeURIComponent(token)}` : "";
      if (scope === "workspace" && connectorId && root) {
        return `${base}/connectors/${encodeURIComponent(connectorId)}/terminals/${encodeURIComponent(tid)}/stream?fromSeq=${fromSeq}${t}`;
      }
      return `${base}/sessions/${sessionId}/terminals/${tid}/stream?fromSeq=${fromSeq}${t}`;
    },
  };
}

export type RuntimeApi = ReturnType<typeof makeRuntimeApi>;

// ─── Demo fixtures ────────────────────────────────────────────────────

const DEMO_TREE: Record<string, FsListEntry[]> = {
  ".": [
    { name: "apps", path: "apps", type: "directory", size: null },
    { name: "packages", path: "packages", type: "directory", size: null },
    { name: "pnpm-workspace.yaml", path: "pnpm-workspace.yaml", type: "file", size: 88 },
    { name: "README.md", path: "README.md", type: "file", size: 1240 },
  ],
  "apps": [
    { name: "webapp", path: "apps/webapp", type: "directory", size: null },
    { name: "docs", path: "apps/docs", type: "directory", size: null },
  ],
  "apps/webapp": [
    { name: "src", path: "apps/webapp/src", type: "directory", size: null },
    { name: "package.json", path: "apps/webapp/package.json", type: "file", size: 562 },
    { name: "tsconfig.json", path: "apps/webapp/tsconfig.json", type: "file", size: 240 },
  ],
  "apps/webapp/src": [
    { name: "app", path: "apps/webapp/src/app", type: "directory", size: null },
    { name: "lib", path: "apps/webapp/src/lib", type: "directory", size: null },
    { name: "components", path: "apps/webapp/src/components", type: "directory", size: null },
  ],
  "apps/webapp/src/lib": [
    { name: "auth.ts", path: "apps/webapp/src/lib/auth.ts", type: "file", size: 612 },
    { name: "db.ts", path: "apps/webapp/src/lib/db.ts", type: "file", size: 240 },
    { name: "session.ts", path: "apps/webapp/src/lib/session.ts", type: "file", size: 384 },
  ],
  "apps/webapp/src/app": [
    { name: "layout.tsx", path: "apps/webapp/src/app/layout.tsx", type: "file", size: 412 },
    { name: "page.tsx", path: "apps/webapp/src/app/page.tsx", type: "file", size: 312 },
  ],
  "apps/webapp/src/components": [
    { name: "LoginForm.tsx", path: "apps/webapp/src/components/LoginForm.tsx", type: "file", size: 980 },
  ],
  "apps/docs": [],
  "packages": [
    { name: "happy-cli", path: "packages/happy-cli", type: "directory", size: null },
    { name: "happy-server", path: "packages/happy-server", type: "directory", size: null },
  ],
  "packages/happy-cli": [],
  "packages/happy-server": [],
};

const DEMO_FILE_CONTENT: Record<string, string> = {
  "apps/webapp/src/lib/auth.ts": `import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import GitHub from "next-auth/providers/github"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "./db"

export const { auth, handlers, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    GitHub({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
    }),
    Credentials({
      async authorize(creds) {
        // ...
      },
    }),
  ],
  session: { strategy: "jwt" },
})
`,
  "apps/webapp/src/lib/db.ts": `import { PrismaClient } from "@prisma/client"
export const prisma = new PrismaClient()
`,
  "apps/webapp/src/lib/session.ts": `import { auth } from "./auth"
export async function getSession() {
  return auth()
}
`,
  "apps/webapp/package.json": `{
  "name": "webapp",
  "version": "0.4.2",
  "private": true,
  "dependencies": {
    "next": "15.0.3",
    "next-auth": "^5.0.0-beta.20",
    "@auth/prisma-adapter": "^2.7.2"
  }
}
`,
  "README.md": `# happy

Local-first happy monorepo.
`,
};

function demoFsList(path: string | null) {
  const key = path && path !== "." ? stripLeading(path) : ".";
  const entries = DEMO_TREE[key];
  if (!entries) {
    return Promise.reject(new RuntimeApiError(404, `demo: no such directory ${key}`));
  }
  return { ok: true, result: { path: key, entries, truncated: false } };
}

function demoFsReadText(path: string): FsReadTextResult {
  const key = stripLeading(path);
  const content = DEMO_FILE_CONTENT[key];
  if (content === undefined) {
    throw new RuntimeApiError(404, `demo: no such file ${key}`);
  }
  const enc = new TextEncoder().encode(content);
  return {
    path: key,
    name: key.split("/").pop() ?? key,
    size: enc.length,
    sha256: demoSha256(content),
    encoding: "utf8",
    content,
    truncated: false,
    binary: false,
    serverTime: new Date().toISOString(),
  };
}

function demoFsWrite(path: string, content: string) {
  const key = stripLeading(path);
  DEMO_FILE_CONTENT[key] = content;
  const enc = new TextEncoder().encode(content);
  return {
    ok: true,
    result: {
      path: key,
      encoding: "utf8",
      bytesWritten: enc.length,
      sha256: demoSha256(content),
    },
  };
}

function demoFsReadFile(path: string): { ok: boolean; result: FsReadFileResult } {
  const text = demoFsReadText(path);
  return {
    ok: true,
    result: {
      path: text.path,
      name: text.name,
      size: text.size,
      sha256: text.sha256,
      transferId: `demo:${text.path}`,
      token: "demo",
      downloadUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(text.content)}`,
    },
  };
}

function demoTerminal(tid: string): TerminalView {
  return {
    terminalId: tid,
    sessionId: "demo",
    label: "zsh",
    cwd: "/",
    cols: 80,
    rows: 24,
    purpose: "user",
    pid: 1234,
    status: "running",
    exitCode: null,
    scrollbackBytes: 0,
    scrollbackSeq: 0,
    createdAt: new Date().toISOString(),
  };
}

function demoCreateTerminal(args: TerminalCreateArgs) {
  return {
    terminal: { ...demoTerminal(`trm_demo_${Math.random().toString(36).slice(2, 8)}`), ...args, label: args.label || "zsh" },
  };
}

function stripLeading(p: string) {
  return p.replace(/^\/+/, "").replace(/^\.\/+/, "");
}

function demoSha256(s: string) {
  // Cheap deterministic stand-in for the real sha256 — only used inside the
  // demo, so the UI can pass it back as ifMatch and still pretend.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(64, "0");
}
