/**
 * Encryption-coverage suite — proves every free-text MEDICAL field is sealed
 * at rest while identity/contact fields stay searchable plaintext BY DESIGN.
 *
 * It writes a patient + appointment + record (valid patient first, so the
 * record path is really exercised) stamped with unique markers in EVERY text
 * field, flushes, then asserts:
 *   - medical markers are ABSENT from db.json AND from a fresh boot backup,
 *   - non-medical markers are PRESENT (guards against a false-green where
 *     nothing was written at all),
 * and prints the deliberately-plaintext field list for human review.
 *
 * Prints "PASS n   FAIL n" so run-suite.js can summarise it.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3195;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-encov-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";
const TAG = `COV${Date.now().toString(36)}`.toUpperCase();

// field -> marker. medical:true means "must be sealed at rest".
const FIELDS = [
  ["patients.fullName", `WsM ${TAG}Nm`, true],
  ["patients.phone", `05${String(Math.floor(Math.random() * 90000000) + 10000000)}`, true],
  ["patients.email", `${TAG.toLowerCase()}@example.test`, false],
  ["patients.bloodType", `BT-${TAG}`, true],
  ["patients.allergies", `AL-${TAG}`, true],
  ["patients.insuranceNumber", `IN-${TAG}`, false],
  ["patients.insuranceCompany", `IC-${TAG}`, false],
  ["patients.notes", `PN-${TAG}`, true],
  ["appointments.title", `TI-${TAG}`, false],
  ["appointments.notes", `AN-${TAG}`, true],
  ["records.chiefComplaint", `CC-${TAG}`, true],
  ["records.diagnosis", `DG-${TAG}`, true],
  ["records.treatment", `TR-${TAG}`, true],
  ["records.notes", `RN-${TAG}`, true],
];
const byField = Object.fromEntries(FIELDS.map(([f, m, med]) => [f, { marker: m, medical: med }]));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    if (cookie) h["Cookie"] = cookie;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json: j, text: buf }); });
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, json: null, text: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, json: null, text: "timeout" }); });
    if (data) r.write(data); r.end();
  });
}
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", method: "GET", timeout: 1000 },
        (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
      r.end();
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}
function startServer() {
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1", ENCRYPTION_KEY: ENC_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
  srv._out = () => out;
  return srv;
}
const newestBackup = () => {
  const dir = path.join(TMP, "backups");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("db-") && f.endsWith(".json")).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
};

(async () => {
  let srv = startServer();
  const finish = (code) => {
    try { srv.kill("SIGKILL"); } catch { /* gone */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\n   PASS ${pass}   FAIL ${fail}`);
    process.exit(code);
  };
  if (!(await waitHealthy())) { console.log("server never became healthy:\n" + srv._out()); finish(1); return; }

  const login = await req("POST", "/api/auth/login", { body: { username: "houssem", password: "houssem123" } });
  const sc = (login.headers?.["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  check("seeded owner signs in", login.status === 200 && !!sc, `code=${login.status}`);
  if (!sc) { finish(1); return; }

  // patient first: the record endpoint requires a VALID patientId
  const p = await req("POST", "/api/patients", { cookie: sc, body: {
    fullName: byField["patients.fullName"].marker, phone: byField["patients.phone"].marker,
    email: byField["patients.email"].marker, gender: "male", age: 40,
    bloodType: byField["patients.bloodType"].marker, allergies: byField["patients.allergies"].marker,
    insuranceNumber: byField["patients.insuranceNumber"].marker, insuranceCompany: byField["patients.insuranceCompany"].marker,
    notes: byField["patients.notes"].marker,
  } });
  check("patient created", p.status === 200 && !!p.json?.id, `code=${p.status}`);
  const pid = p.json?.id;

  const day = new Date(Date.now() + 60 * 864e5); day.setHours(12, 0, 0, 0);
  const a = await req("POST", "/api/appointments", { cookie: sc, body: {
    patientId: pid, title: byField["appointments.title"].marker,
    startTime: day.toISOString(), notes: byField["appointments.notes"].marker,
  } });
  check("appointment created", a.status === 200 && !!a.json?.id, `code=${a.status}`);

  const r = await req("POST", "/api/records", { cookie: sc, body: {
    patientId: pid, chiefComplaint: byField["records.chiefComplaint"].marker,
    diagnosis: byField["records.diagnosis"].marker, treatment: byField["records.treatment"].marker,
    notes: byField["records.notes"].marker,
  } });
  check("record created (valid patient)", r.status === 200 && !!r.json?.id, `code=${r.status}`);

  // API still serves plaintext (encryption is at-rest only)
  const got = await req("GET", "/api/patients", { cookie: sc });
  const plist = Array.isArray(got.json) ? got.json : (got.json?.patients || got.json?.items || []);
  const row = plist.find((x) => x.id === pid);
  check("API returns the medical notes in clear", row && row.notes === byField["patients.notes"].marker);
  check("API returns the patient name in clear", row && row.fullName === byField["patients.fullName"].marker);

  await sleep(900); // let the debounced flush land
  const raw = fs.readFileSync(path.join(TMP, "db.json"), "utf8");
  const dbj = JSON.parse(raw);
  const savedPat = dbj.patients.find((x) => x.id === pid);
  check("phone sealed on disk", savedPat && savedPat.phone !== byField["patients.phone"].marker && String(savedPat.phone).startsWith("enc:v1:"));
  const crypto = require("crypto");
  const wantIdx = crypto.createHash("sha256").update(byField["patients.phone"].marker.replace(/\D/g, "")).digest("hex");
  check("blind phone index maintained (sha256 of digits)", savedPat && savedPat.phoneIdx === wantIdx, savedPat?.phoneIdx);

  for (const [field, { marker, medical }] of Object.entries(byField)) {
    const present = raw.includes(marker);
    if (medical) check(`sealed at rest: ${field}`, !present, present ? "MARKER LEAKED" : "");
    else check(`searchable plaintext (by design): ${field}`, present, present ? "" : "NOT WRITTEN?");
  }

  console.log("  ..   deliberately-plaintext fields (human review list): " +
    FIELDS.filter(([, , med]) => !med).map(([f]) => f).join(", "));

  // backups are byte-copies of db.json: reboot so a fresh boot snapshot
  // contains the sealed rows, then scan the newest snapshot too
  srv.kill("SIGKILL");
  await sleep(400);
  srv = startServer();
  if (!(await waitHealthy())) { console.log("reboot never became healthy:\n" + srv._out()); finish(1); return; }
  srv.kill("SIGKILL");
  await sleep(400);
  const snap = newestBackup();
  check("a boot backup exists for the scan", !!snap, snap ? path.basename(snap) : "");
  if (snap) {
    const snapRaw = fs.readFileSync(snap, "utf8");
    const leaked = FIELDS.filter(([, , med]) => med).filter(([, m]) => snapRaw.includes(m));
    check("no medical marker in the backup", leaked.length === 0,
      leaked.length ? `leaked: ${leaked.map(([f]) => f).join(", ")}` : "");
  }

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
