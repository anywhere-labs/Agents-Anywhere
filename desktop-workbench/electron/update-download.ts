import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function downloadDesktopInstaller(options: {
  url: string;
  directory: string;
  platform: string;
  fetcher: typeof fetch;
  signal: AbortSignal;
  onProgress: (downloadedBytes: number, totalBytes: number | null) => void;
}): Promise<string> {
  const extension = { darwin: ".dmg", win32: ".exe", linux: ".AppImage" }[options.platform];
  if (!extension) throw new Error("Unsupported installer platform.");
  const url = new URL(options.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Installer URL must use HTTPS.");
  const response = await options.fetcher(url.href, {
    credentials: "omit", cache: "no-store", signal: options.signal,
  });
  if (!response.ok || !response.body || (response.url && !response.url.startsWith("https:"))) {
    await response.body?.cancel();
    throw new Error("Installer download failed.");
  }
  if (/text\/|json|xml/i.test(response.headers.get("content-type") ?? "")) {
    await response.body.cancel();
    throw new Error("The download address returned a page instead of an installer.");
  }
  const length = Number(response.headers.get("content-length"));
  const total = Number.isSafeInteger(length) && length > 0 && !response.headers.get("content-encoding") ? length : null;
  const reader = response.body.getReader();
  // Electron's fetch body needs explicit cancellation after headers have arrived.
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  options.signal.addEventListener("abort", cancel, { once: true });
  let partial: string | undefined;
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    options.signal.throwIfAborted();
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
    const target = path.join(options.directory, `Agents-Anywhere-${randomUUID()}${extension}`);
    partial = `${target}.part`;
    output = await fs.open(partial, "wx", 0o600);
    let received = 0;
    let lastPublished = 0;
    options.onProgress(0, total);
    while (true) {
      options.signal.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal.throwIfAborted();
      if (done) break;
      await output.writeFile(value);
      received += value.byteLength;
      if (Date.now() - lastPublished >= 100 || received === total) {
        options.onProgress(received, total);
        lastPublished = Date.now();
      }
    }
    if (!received || (total !== null && total !== received)) throw new Error("Installer download is incomplete.");
    await output.sync();
    await output.close();
    output = undefined;
    options.signal.throwIfAborted();
    await fs.rename(partial, target);
    partial = undefined;
    options.onProgress(received, total ?? received);
    return target;
  } finally {
    options.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    await output?.close();
    if (partial) await fs.rm(partial, { force: true });
  }
}
