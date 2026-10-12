"use strict";
/**
 * نظام عيادة — offline restore / verify CLI.
 *
 *   node scripts/restore.js <backup-file>        # restore (refuses if server is up)
 *   node scripts/restore.js --verify [file]      # verify newest (or a given) snapshot
 *   node scripts/restore.js <file> --force       # restore even if a server answers
 *
 * Env: DATA_DIR, PORT, HOST, BACKUP_ENCRYPT_KEY (for encrypted snapshots).
 * Same behaviour is also reachable as `node server.js --restore <file>` /
 * `node server.js --verify-backup [file]`.
 */
const fs = require("fs");
const path = require("path");
const B = require("./backup.js");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const valueOf = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || valueOf("port") || 3000);
const KEY = process.env.BACKUP_ENCRYPT_KEY ? B.deriveKey(process.env.BACKUP_ENCRYPT_KEY) : null;
const positional = argv.filter((a) => !a.startsWith("--"));

(async () => {
  if (flag("verify")) {
    const file = valueOf("verify") || positional[0] || B.newestBackup(BACKUP_DIR);
    if (!file || !fs.existsSync(file)) { console.error("no backup to verify (looked in " + BACKUP_DIR + ")"); process.exit(2); }
    const sum = B.verifyChecksum(file);
    let snap;
    try { snap = B.readSnapshot(file, KEY); }
    catch (e) { snap = { ok: false, reason: "decrypt-failed", message: e.message }; }
    const ok = snap.ok && sum.reason !== "checksum-mismatch";
    console.log(
      `${ok ? "OK" : "FAIL"} ${path.basename(file)}  ` +
      `checksum=${sum.reason} json=${snap.ok ? "ok" : snap.reason}`
    );
    process.exit(ok ? 0 : 1);
  }

  const file = positional[0] || B.newestBackup(BACKUP_DIR);
  if (!file) { console.error("usage: node scripts/restore.js <backup-file> [--force]"); process.exit(2); }

  const res = await B.restore({ dbFile: DB_FILE, backupDir: BACKUP_DIR, file, host: HOST, port: PORT, key: KEY, force: flag("force") });
  if (!res.ok) {
    const msg = {
      "server-running": `refusing to restore: a server is answering on ${HOST}:${PORT}. Stop it first (or pass --force).`,
      "checksum-mismatch": `refusing to restore: checksum mismatch (want ${res.want} got ${res.got}).`,
      "not-found": `backup not found: ${res.file}`,
      "not-json": "refusing to restore: snapshot is not valid JSON.",
      "bad-schema": `refusing to restore: missing collections [${(res.missing || []).join(", ")}].`,
      "decrypt-failed": `refusing to restore: ${res.message}`,
    }[res.reason] || `restore failed: ${res.reason}`;
    console.error(msg);
    process.exit(1);
  }
  console.log(`restored ${path.basename(res.from)} → ${DB_FILE}`);
  console.log(`  checksum verified: ${res.checksumVerified}`);
  if (res.preRestore) console.log(`  previous database snapshotted: ${path.basename(res.preRestore)}`);
  process.exit(0);
})();
