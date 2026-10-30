import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex, artifactStorageName } from "@career-agent/security";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import { createStore } from "./index.js";
import { fixtureFact, testCipher } from "./test-helpers.js";

function world() {
  const root = mkdtempSync(path.join(tmpdir(), "ca-backup-"));
  const dbFile = path.join(root, "data", "career-agent.sqlite");
  const artifactDir = path.join(root, "artifacts");
  mkdirSync(path.dirname(dbFile), { recursive: true });
  const cipher = testCipher();
  const store = createStore({ file: dbFile, cipher });
  const owner = store.users.ensureOwner("Owner");
  const fact = store.facts.add(
    owner.id,
    fixtureFact({ claim: "Holds a fictional clearance", sensitive: true }),
  );
  const bytes = Buffer.from("%PDF-1.4 fictional résumé");
  const sha = sha256Hex(bytes);
  const storagePath = artifactStorageName(sha, "pdf");
  mkdirSync(path.dirname(path.join(artifactDir, storagePath)), { recursive: true });
  writeFileSync(path.join(artifactDir, storagePath), bytes);
  store.artifacts.put({
    sha256: sha,
    mediaType: "application/pdf",
    byteSize: bytes.length,
    kind: "resume_pdf",
    storagePath,
  });
  return { root, dbFile, artifactDir, cipher, store, owner, fact, storagePath };
}

describe("backup and restore", () => {
  it("round-trips the database and artifacts; encrypted data needs the same key", async () => {
    const w = world();
    const { dir, manifest } = await createBackup(w.store, {
      artifactDir: w.artifactDir,
      outDir: path.join(w.root, "backups"),
    });
    expect(manifest.artifacts).toHaveLength(1);
    expect(verifyBackup(dir).database.sha256).toBe(manifest.database.sha256);
    w.store.close();

    // Restore into a fresh place, as after losing the machine.
    const fresh = path.join(w.root, "restored");
    const db2 = path.join(fresh, "career-agent.sqlite");
    restoreBackup(dir, { databaseFile: db2, artifactDir: path.join(fresh, "artifacts") });
    expect(existsSync(path.join(fresh, "artifacts", w.storagePath))).toBe(true);
    const back = createStore({ file: db2, cipher: w.cipher });
    expect(back.facts.get(w.fact.id)?.claim).toBe("Holds a fictional clearance");
    back.close();
    const wrongKey = createStore({ file: db2, cipher: testCipher() });
    expect(() => wrongKey.facts.get(w.fact.id)).toThrow();
    wrongKey.close();
  });

  it("refuses to overwrite a database unless forced, and keeps the old one aside", async () => {
    const w = world();
    const { dir } = await createBackup(w.store, {
      artifactDir: w.artifactDir,
      outDir: path.join(w.root, "backups"),
    });
    w.store.close();
    expect(() =>
      restoreBackup(dir, { databaseFile: w.dbFile, artifactDir: w.artifactDir }),
    ).toThrow(/--force/);
    const r = restoreBackup(dir, {
      databaseFile: w.dbFile,
      artifactDir: w.artifactDir,
      force: true,
    });
    expect(r.movedAside && existsSync(r.movedAside)).toBe(true);
  });

  it("detects a changed or incomplete backup", async () => {
    const w = world();
    const { dir } = await createBackup(w.store, {
      artifactDir: w.artifactDir,
      outDir: path.join(w.root, "backups"),
    });
    writeFileSync(path.join(dir, "artifacts", w.storagePath), "tampered");
    expect(() => verifyBackup(dir)).toThrow(/missing or changed/);
    expect(() =>
      restoreBackup(dir, {
        databaseFile: path.join(w.root, "x.sqlite"),
        artifactDir: w.artifactDir,
      }),
    ).toThrow();
    expect(() => verifyBackup(w.root)).toThrow(/not a Career Agent backup/);
  });
});
