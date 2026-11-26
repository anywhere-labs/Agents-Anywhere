import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  attachmentDir,
  DeviceOpsError,
  fetchDriveFile,
  removeSessionAttachments,
  saveAttachment,
  type DriveDownload,
} from "../src/runtime/device-ops.js";

let root: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aa-v3-attach-"));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function fresh(name: string): Promise<{ dataDir: string; project: string }> {
  const base = await fs.mkdtemp(path.join(root, `${name}-`));
  const project = path.join(base, "project");
  await fs.mkdir(project);
  return { dataDir: path.join(base, "data"), project };
}

function driveOf(bytes: Uint8Array, extra: Partial<DriveDownload["file"]> = {}): { info: DriveDownload; fetchImpl: typeof fetch } {
  const info: DriveDownload = {
    file: { id: "f1", size_bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), filename: "big.bin", ...extra },
    download: { method: "GET", url: "https://drive.example/f1", headers: {} },
  };
  const fetchImpl = (async () => new Response(Buffer.from(bytes))) as unknown as typeof fetch;
  return { info, fetchImpl };
}

describe("attachments", () => {
  test("go to <project>/.agents-anywhere/attachments/<session>/ with a catch-all .gitignore", async () => {
    const { dataDir, project } = await fresh("project");
    const saved = await saveAttachment(dataDir, {
      name: "shot.png",
      base64: Buffer.from("png").toString("base64"),
      location: { sessionId: "s_1", projectDir: project },
    });
    assert.equal(path.dirname(saved.path), path.join(project, ".agents-anywhere", "attachments", "s_1"));
    assert.equal(saved.mime, "image/png");
    assert.equal(await fs.readFile(path.join(project, ".agents-anywhere", ".gitignore"), "utf8").then((t) => t.trim().split("\n").at(-1)), "*");
  });

  test("fall back to the data directory when the project folder is missing", async () => {
    const { dataDir, project } = await fresh("missing");
    const dir = await attachmentDir(dataDir, { sessionId: "s_2", projectDir: path.join(project, "gone") });
    assert.equal(dir, path.join(dataDir, "attachments", "s_2"));
    await assert.rejects(fs.stat(path.join(project, "gone")));
  });

  test("never use a session id as a path", async () => {
    const { dataDir } = await fresh("evil");
    assert.equal(await attachmentDir(dataDir, { sessionId: "../../etc" }), path.join(dataDir, "attachments", "unsorted"));
    assert.equal(await attachmentDir(dataDir, { sessionId: ".." }), path.join(dataDir, "attachments", "unsorted"));
  });

  test("are removed with their conversation", async () => {
    const { dataDir, project } = await fresh("remove");
    const keep = await saveAttachment(dataDir, { name: "a.txt", base64: "YQ==", location: { sessionId: "keep", projectDir: project } });
    const gone = await saveAttachment(dataDir, { name: "b.txt", base64: "Yg==", location: { sessionId: "gone", projectDir: project } });
    await removeSessionAttachments(dataDir, { sessionId: "gone", projectDir: project });
    await assert.rejects(fs.stat(gone.path));
    assert.ok((await fs.stat(keep.path)).isFile());
  });
});

describe("fetchDriveFile", () => {
  test("downloads, checks size and sha256, and stores it with the conversation", async () => {
    const { dataDir, project } = await fresh("drive");
    const bytes = randomBytes(64 * 1024);
    const { info, fetchImpl } = driveOf(bytes);
    const saved = await fetchDriveFile(dataDir, { fileId: "f1", location: { sessionId: "s", projectDir: project } }, async () => info, fetchImpl);
    assert.equal(saved.name, "big.bin");
    assert.equal(path.dirname(saved.path), path.join(project, ".agents-anywhere", "attachments", "s"));
    assert.deepEqual(await fs.readFile(saved.path), bytes);
  });

  test("rejects a tampered download", async () => {
    const { dataDir } = await fresh("tamper");
    const { info } = driveOf(Buffer.from("original"));
    const tampered = (async () => new Response(Buffer.from("tampered"))) as unknown as typeof fetch;
    await assert.rejects(
      fetchDriveFile(dataDir, { fileId: "f1" }, async () => info, tampered),
      (err: unknown) => err instanceof DeviceOpsError && err.code === "integrity_failed",
    );
  });

  test("decrypts ephemeral_key files (AES-256-GCM, nonce from the drive record, tag appended)", async () => {
    const { dataDir } = await fresh("encrypted");
    const plain = Buffer.from("secret attachment body");
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const stored = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const { info, fetchImpl } = driveOf(stored, { encryption_mode: "ephemeral_key", encryption_nonce: nonce.toString("base64url"), filename: null });
    const saved = await fetchDriveFile(
      dataDir,
      { fileId: "f1", name: "notes.txt", fileKey: key.toString("base64url") },
      async () => info,
      fetchImpl,
    );
    assert.equal(saved.name, "notes.txt");
    assert.equal(saved.mime, "text/plain");
    assert.deepEqual(await fs.readFile(saved.path), plain);

    await assert.rejects(
      fetchDriveFile(dataDir, { fileId: "f1", fileKey: randomBytes(32).toString("base64url") }, async () => info, fetchImpl),
      (err: unknown) => err instanceof DeviceOpsError && err.code === "integrity_failed",
    );
    await assert.rejects(
      fetchDriveFile(dataDir, { fileId: "f1" }, async () => info, fetchImpl),
      (err: unknown) => err instanceof DeviceOpsError && err.code === "invalid_argument",
    );
  });

  test("refuses assistant workspace files", async () => {
    const { dataDir } = await fresh("dek");
    const { info, fetchImpl } = driveOf(Buffer.from("x"), { encryption_mode: "account_dek" });
    await assert.rejects(fetchDriveFile(dataDir, { fileId: "f1" }, async () => info, fetchImpl), /assistant workspace/);
  });
});
