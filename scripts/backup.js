"use strict";
/**
 * نظام عيادة — backup / verify / restore toolkit (zero dependencies).
 * ==================================================================
 * Used by BOTH server.js (scheduled backups, `--restore`, `--verify-backup`)
 * and scripts/restore.js (offline CLI), so the rules live in exactly one place:
 *
 *   • every snapshot gets a `<file>.sha256` sidecar (integrity);
 *   • when `BACKUP_ENCRYPT_KEY` is set the snapshot is encrypted whole-file
 *     (AES-256-GCM, prefix `encbak:v1:`), so a leaked backup folder is useless;
 *   • a restore validates checksum + JSON + schema, snapshots the CURRENT
 *     db.json first, and refuses to run while a server is answering.
 *
 * Nothing here imports server.js, so the CLI can run without booting the app.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");

const SHA_PREFIX = "sha256:";
const ENC_PREFIX = "encbak:v1:";
const BACKUP_PREFIX = "db-";
const BACKUP_EXT = ".json";
const ENC_EXT = ".json.enc";

const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** sha256 of a file's (raw) bytes, prefixed for clarity. */
function checksumFile(file) {
  return SHA_PREFIX + sha256hex(fs.readFileSync(file));
}

/** Writes / refreshes the `<file>.sha256` sidecar next to a snapshot. */
function writeChecksum(file) {
  fs.writeFileSync(file + ".sha256", checksumFile(file), "utf8");
  return file + ".sha256";
}

function readChecksum(file) {
  try { return fs.readFileSync(file + ".sha256", "utf8").trim(); } catch { return null; }
}

/** Verify a snapshot against its sidecar (missing sidecar counts as unverified). */
function verifyChecksum(file) {
  const want = readChecksum(file);
  if (!want) return { ok: false, reason: "no-checksum" };
  const got = checksumFile(file);
  return { ok: got === want, reason: got === want ? "ok" : "checksum-mismatch", want, got };
}

/* ── whole-file AES-256-GCM (optional) ── */
const deriveKey = (secret) => crypto.createHash("sha256").update(String(secret)).digest();

function encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.from(
    ENC_PREFIX + [iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":"),
    "utf8"
  );
}

function decryptBuffer(data, key) {
  const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (!raw.startsWith(ENC_PREFIX)) return Buffer.from(raw, "utf8"); // not encrypted
  if (!key) throw new Error("backup is encrypted but BACKUP_ENCRYPT_KEY is not set");
  const [, , ivb, tagb, ctb] = raw.split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivb, "base64url"));
  d.setAuthTag(Buffer.from(tagb, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ctb, "base64url")), d.final()]);
}

function isEncrypted(file) {
  if (file.endsWith(ENC_EXT)) return true;
  try { return fs.readFileSync(file, "utf8").startsWith(ENC_PREFIX); } catch { return false; }
}

/* ── schema validation ── */
const CORE_COLLECTIONS = [
  "users", "clinics", "patients", "appointments", "invoices",
  "records", "inventory", "services", "tasks",
];

function validateDbShape(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, missing: CORE_COLLECTIONS.slice() };
  const missing = CORE_COLLECTIONS.filter((k) => !Array.isArray(obj[k]));
  return { ok: missing.length === 0, missing };
}

/** Read + (decrypt if needed) + parse + schema-check a snapshot. */
function readSnapshot(file, key) {
  const raw = decryptBuffer(fs.readFileSync(file), key);
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch { return { ok: false, reason: "not-json" }; }
  const shape = validateDbShape(parsed);
  if (!shape.ok) return { ok: false, reason: "bad-schema", missing: shape.missing };
  return { ok: true, db: parsed };
}

/* ── listing / rotation ── */
function listBackups(backupDir) {
  try {
    return fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && (f.endsWith(BACKUP_EXT) || f.endsWith(ENC_EXT)))
      .sort();
  } catch { return []; }
}

function newestBackup(backupDir) {
  const all = listBackups(backupDir);
  return all.length ? path.join(backupDir, all[all.length - 1]) : null;
}

/** Keep the newest `keep` snapshots (+ their sidecars), delete the rest. */
function rotateBackups(backupDir, keep) {
  const all = listBackups(backupDir);
  const removed = [];
  while (all.length > keep) {
    const f = all.shift();
    const full = path.join(backupDir, f);
    for (const p of [full, full + ".sha256"]) {
      try { fs.unlinkSync(p); removed.push(p); } catch { /* keep rotating */ }
    }
  }
  return removed;
}

/* ── running-server guard ── */
function isServerRunning(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const r = http.request({ host, port, path: "/api/health", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on("error", () => resolve(false));
    r.on("timeout", () => { r.destroy(); resolve(false); });
    r.end();
  });
}

/**
 * Restore a snapshot into dbFile.
 *  - refuses while the server answers on host:port (unless force)
 *  - validates checksum (unless the sidecar is missing) + JSON + schema
 *  - snapshots the CURRENT db.json before overwriting
 */
async function restore({ dbFile, backupDir, file, host = "127.0.0.1", port = 3000, key = null, force = false }) {
  if (!force && (await isServerRunning(host, port)))
    return { ok: false, reason: "server-running", port };

  if (!fs.existsSync(file)) return { ok: false, reason: "not-found", file };

  const sum = verifyChecksum(file);
  if (sum.reason === "checksum-mismatch") return { ok: false, reason: "checksum-mismatch", want: sum.want, got: sum.got };

  let snap;
  try { snap = readSnapshot(file, key); }
  catch (e) { return { ok: false, reason: "decrypt-failed", message: e.message }; }
  if (!snap.ok) return snap;

  // snapshot the current database first (best effort — a first restore has none)
  let preRestore = null;
  if (fs.existsSync(dbFile)) {
    fs.mkdirSync(backupDir, { recursive: true });
    preRestore = path.join(backupDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(dbFile, preRestore);
    writeChecksum(preRestore);
  }

  const tmp = dbFile + ".tmp";
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(snap.db, null, 2), "utf8");
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, dbFile);

  return { ok: true, checksumVerified: sum.ok, from: file, preRestore };
}

module.exports = {
  SHA_PREFIX, ENC_PREFIX, BACKUP_PREFIX, BACKUP_EXT, ENC_EXT, CORE_COLLECTIONS,
  sha256hex, checksumFile, writeChecksum, readChecksum, verifyChecksum,
  deriveKey, encryptBuffer, decryptBuffer, isEncrypted,
  validateDbShape, readSnapshot, listBackups, newestBackup, rotateBackups,
  isServerRunning, restore,
};
