/**
 * Phase 4 suite — backups (checksum + optional encryption), verify/restore CLI,
 * and the liveness /api/health probe.
 *
 * Mixes in-process checks of scripts/backup.js with real CLI subprocesses
 * (`node server.js --verify-backup|--restore`) against throwaway DATA_DIRs, so
 * the whole backup → verify → restore cycle is exercised without a browser.
 *
 * Prints "PASS n   FAIL n" so run-suite.js can summarise it.
 */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const B = require(path.join(APP_DIR, "scripts", "backup.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-p4-"));
const TMP_ENC = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-p4enc-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";
const BK_KEY = "unit-test-backup-key-abcdefghijklmn";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(port, urlPath) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", timeout: 1500 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", () => resolve({ status: 0, json: null }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, json: null }); });
    r.end();
  });
}
function post(port, urlPath, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length }, timeout: 4000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", () => resolve({ status: 0, json: null }));
    if (data) r.write(data); r.end();
  });
}
async function waitHealthy(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await get(port, "/api/health");
    if (r.status === 200) return true;
    await sleep(400);
  }
  return false;
}
function startServer(port, dataDir, extraEnv = {}) {
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1", ENCRYPTION_KEY: ENC_KEY, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
  srv._out = () => out;
  return srv;
}
function runCli(args, dataDir, env = {}) {
  return spawnSync(process.execPath, ["server.js", ...args], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "3179", ENCRYPTION_KEY: ENC_KEY, ...env },
    encoding: "utf8",
  });
}
const newest = (dir) => B.newestBackup(path.join(dir, "backups"));
const cleanup = () => { for (const d of [TMP, TMP_ENC]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };

(async () => {
  /* ═════════════ 1. library: checksum + crypto + schema ═════════════ */
  const probe = path.join(TMP, "probe.json");
  fs.writeFileSync(probe, JSON.stringify({ hello: "world" }));
  B.writeChecksum(probe);
  check("checksum sidecar verifies", B.verifyChecksum(probe).ok === true);
  fs.appendFileSync(probe, " ");
  check("tampered file fails the checksum", B.verifyChecksum(probe).reason === "checksum-mismatch");
  fs.unlinkSync(probe + ".sha256");
  check("missing sidecar is reported as unverified", B.verifyChecksum(probe).reason === "no-checksum");

  const key = B.deriveKey(BK_KEY);
  const secret = Buffer.from(JSON.stringify({ users: [{ id: "u1", password: "hash" }] }));
  const enc = B.encryptBuffer(secret, key);
  check("encrypted backup carries the encbak prefix", enc.toString("utf8").startsWith(B.ENC_PREFIX));
  check("decrypt round-trips exactly", B.decryptBuffer(enc, key).equals(secret));
  let threw = false;
  try { B.decryptBuffer(enc, B.deriveKey("wrong-key")); } catch { threw = true; }
  check("decrypt with the wrong key throws", threw);
  let threwNoKey = false;
  try { B.decryptBuffer(enc, null); } catch { threwNoKey = true; }
  check("decrypt without a key throws", threwNoKey);

  check("schema rejects a non-db object", B.validateDbShape({ foo: 1 }).ok === false);
  fs.writeFileSync(probe, "{not-json");
  check("readSnapshot rejects malformed JSON", B.readSnapshot(probe, null).reason === "not-json");

  // rotation: keep N snapshots + drop their sidecars
  const rdir = path.join(TMP, "rot");
  fs.mkdirSync(rdir, { recursive: true });
  for (let i = 0; i < 5; i++) { const f = path.join(rdir, `db-2020-01-0${i}.json`); fs.writeFileSync(f, "{}"); B.writeChecksum(f); }
  B.rotateBackups(rdir, 3);
  check("rotation keeps the newest N snapshots", B.listBackups(rdir).length === 3);
  check("rotation deletes orphaned sidecars", fs.readdirSync(rdir).filter((f) => f.endsWith(".sha256")).length === 3);

  /* ═════════════ 2. health reports read/write + backup age ═════════════ */
  const PORT = 3191;
  const srv1 = startServer(PORT, TMP);
  if (!(await waitHealthy(PORT))) { console.log("server never healthy:\n" + srv1._out()); cleanup(); process.exit(1); }

  const health = await get(PORT, "/api/health");
  check("health is 200", health.status === 200);
  check("health reports dbRead", health.json && health.json.dbRead === true);
  check("health reports dbWrite", health.json && health.json.dbWrite === true);
  check("health reports backup age (sec)", health.json && typeof health.json.backupAgeSec === "number" && health.json.backupAgeSec >= 0);
  check("a boot backup exists", typeof health.json.backups === "number" && health.json.backups >= 1);

  const reg = await post(PORT, "/api/auth/register", {
    username: "t4user", password: "T4-Marker-Pass-2026", fullName: "مستخدم المرحلة 4", clinicName: "T4 Marker Clinic",
  });
  check("created a marker account/clinic", reg.status === 200);

  // save() persists asynchronously — wait for it to land before killing
  const dbLive = path.join(TMP, "db.json");
  for (let i = 0; i < 20 && !(fs.existsSync(dbLive) && fs.readFileSync(dbLive, "utf8").includes("T4 Marker Clinic")); i++) await sleep(150);
  check("marker persisted to disk", fs.readFileSync(dbLive, "utf8").includes("T4 Marker Clinic"));

  srv1.kill("SIGKILL");
  await sleep(300);

  /* ═════════════ 3. CLI verify + full restore cycle ═════════════ */
  // a second boot takes a fresh snapshot that already includes the marker
  const srv2 = startServer(PORT, TMP);
  if (!(await waitHealthy(PORT))) { console.log("server #2 never healthy:\n" + srv2._out()); cleanup(); process.exit(1); }
  srv2.kill("SIGKILL");
  await sleep(300);

  const snap = newest(TMP);
  check("a snapshot was written", !!snap, snap ? path.basename(snap) : "");

  const verify = runCli(["--verify-backup"], TMP);
  check("--verify-backup exits 0 on a good snapshot", verify.status === 0, `exit=${verify.status}`);
  check("--verify-backup reports checksum=ok", /checksum=ok/.test(verify.stdout || ""));

  // corrupt the live database, then restore the snapshot
  const dbFile = path.join(TMP, "db.json");
  fs.writeFileSync(dbFile, JSON.stringify({ users: [], clinics: [] }));
  const restore = runCli(["--restore", snap], TMP);
  check("--restore exits 0", restore.status === 0, `exit=${restore.status} ${restore.stderr || ""}`);
  const restored = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  check("restore brought the data back", Array.isArray(restored.clinics) && restored.clinics.some((c) => c.name === "T4 Marker Clinic"));
  check("restore snapshotted the previous db", fs.readdirSync(path.join(TMP, "backups")).some((f) => f.startsWith("pre-restore-")));

  // refuse while a server is answering
  const srv3 = startServer(PORT, TMP);
  if (!(await waitHealthy(PORT))) { console.log("server #3 never healthy:\n" + srv3._out()); cleanup(); process.exit(1); }
  const refused = runCli(["--restore", newest(TMP)], TMP, { PORT: String(PORT) });
  check("--restore refuses while a server is running (exit 1)", refused.status === 1, `exit=${refused.status}`);
  check("refusal explains itself", /refusing to restore/i.test(refused.stderr || ""));

  // scripts/restore.js --verify works standalone
  const verifyCli = spawnSync(process.execPath, ["scripts/restore.js", "--verify"], {
    cwd: APP_DIR, env: { ...process.env, DATA_DIR: TMP, HOST: "127.0.0.1", PORT: String(PORT) }, encoding: "utf8",
  });
  check("scripts/restore.js --verify exits 0", verifyCli.status === 0, `exit=${verifyCli.status}`);
  srv3.kill("SIGKILL");
  await sleep(200);

  /* ═════════════ 4. encrypted backups (BACKUP_ENCRYPT_KEY) ═════════════ */
  const srv4 = startServer(3192, TMP_ENC, { BACKUP_ENCRYPT_KEY: BK_KEY });
  if (!(await waitHealthy(3192))) { console.log("server #4 never healthy:\n" + srv4._out()); cleanup(); process.exit(1); }
  srv4.kill("SIGKILL");
  await sleep(300);

  const encSnap = newest(TMP_ENC);
  check("encrypted snapshot uses the .enc extension", !!encSnap && encSnap.endsWith(B.ENC_EXT), encSnap ? path.basename(encSnap) : "");
  check("encrypted snapshot has no plaintext db", !!encSnap && fs.readFileSync(encSnap, "utf8").startsWith(B.ENC_PREFIX));

  const vEnc = runCli(["--verify-backup"], TMP_ENC, { BACKUP_ENCRYPT_KEY: BK_KEY });
  check("--verify-backup decrypts an encrypted snapshot", vEnc.status === 0, `exit=${vEnc.status}`);

  fs.rmSync(path.join(TMP_ENC, "db.json"), { force: true });
  const rEnc = runCli(["--restore", encSnap], TMP_ENC, { BACKUP_ENCRYPT_KEY: BK_KEY, PORT: "3199" });
  check("--restore decrypts and restores", rEnc.status === 0 && fs.existsSync(path.join(TMP_ENC, "db.json")), `exit=${rEnc.status}`);

  fs.rmSync(path.join(TMP_ENC, "db.json"), { force: true });
  const rNoKey = runCli(["--restore", encSnap], TMP_ENC, { PORT: "3199" });
  check("--restore refuses an encrypted snapshot without the key", rNoKey.status === 1, `exit=${rNoKey.status}`);

  cleanup();
  console.log(`\n   PASS ${pass}   FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
