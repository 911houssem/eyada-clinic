/**
 * Privacy suite — consent stamping, clinic policy/terms, export/erase with
 * audit, retention config + manual run, and --rotate-sessions.
 * Own throwaway server. Prints "PASS n   FAIL n".
 */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3205;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-priv-"));

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
const cookieOf = (r) => (r.headers?.["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const auditLog = () => {
  try { return fs.readFileSync(path.join(TMP, "audit.log"), "utf8"); } catch { return ""; }
};

(async () => {
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let srvOut = "";
  srv.stdout.on("data", (d) => (srvOut += d));
  srv.stderr.on("data", (d) => (srvOut += d));
  const finish = (code) => {
    try { srv.kill("SIGKILL"); } catch { /* gone */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\n   PASS ${pass}   FAIL ${fail}`);
    process.exit(code);
  };
  if (!(await waitHealthy())) { console.log("server never became healthy:\n" + srvOut); finish(1); return; }

  const login = await req("POST", "/api/auth/login", { body: { username: "houssem", password: "houssem123" } });
  const A = cookieOf(login);
  check("seeded owner signs in", login.status === 200 && !!A, `code=${login.status}`);
  const me = await req("GET", "/api/auth/me", { cookie: A });
  const clinicId = me.json?.currentClinicId || me.json?.user?.clinicId;

  // ── consent ──
  const p1 = await req("POST", "/api/patients", { cookie: A, body: { fullName: "Consent Probe", phone: "0555000501", consent: true } });
  check("consent stamped on create", p1.status === 200 && !!p1.json?.consentAt && p1.json?.consentVersion === "v1", `code=${p1.status}`);
  const pid = p1.json?.id;
  const p2 = await req("POST", "/api/patients", { cookie: A, body: { fullName: "NoConsent Probe", phone: "0555000502" } });
  check("no consent without opt-in", p2.status === 200 && !p2.json?.consentAt);

  // ── policy / terms ──
  const pub0 = await req("GET", "/api/public/booking/al-noor-clinic/policy");
  check("public policy serves starters", pub0.status === 200 && pub0.text.includes("مراجعة قانونية") && pub0.json?.customized === false, `code=${pub0.status}`);
  const upd = await req("PUT", "/api/clinics", { cookie: A, body: { id: clinicId, privacyPolicy: "سياستنا الخاصة.", terms: "شروطنا." } });
  check("owner customizes policy", upd.status === 200, `code=${upd.status}`);
  const pub1 = await req("GET", "/api/public/booking/al-noor-clinic/policy");
  check("custom policy reflected", pub1.json?.privacyPolicy === "سياستنا الخاصة." && pub1.json?.customized === true);

  // ── export / erase ──
  await req("POST", "/api/appointments", { cookie: A, body: { patientId: pid, title: "كشف", startTime: new Date(Date.now() + 864e5).toISOString() } });
  await req("POST", "/api/records", { cookie: A, body: { patientId: pid, chiefComplaint: "صداع" } });
  await req("POST", "/api/prescriptions", { cookie: A, body: { patientId: pid, items: [{ name: "Med" }] } });
  const inv = await req("POST", "/api/invoices", { cookie: A, body: { patientId: pid, subtotal: 100, total: 100, paidAmount: 0 } });
  const exp = await req("GET", `/api/patients/${pid}/export`, { cookie: A });
  check("export bundles everything", exp.status === 200 && exp.json?.patient?.id === pid &&
    exp.json.appointments.length === 1 && exp.json.records.length === 1 &&
    exp.json.prescriptions.length === 1 && exp.json.invoices.length === 1 &&
    Array.isArray(exp.json.files), `code=${exp.status}`);
  const reg = await req("POST", "/api/auth/register", { body: { username: "privb", password: "Priv-B-2026!", fullName: "B Owner", clinicName: "Clinic B Priv" } });
  const B = cookieOf(reg);
  const bExp = await req("GET", `/api/patients/${pid}/export`, { cookie: B });
  check("IDOR: clinic B cannot export A's patient (403)", bExp.status === 403, `code=${bExp.status}`);

  const era = await req("POST", `/api/patients/${pid}/erase`, { cookie: A });
  check("erase succeeds", era.status === 200 && era.json?.success === true, `code=${era.status}`);
  const after = await req("GET", "/api/patients", { cookie: A });
  const arr = Array.isArray(after.json) ? after.json : (after.json?.patients || after.json?.items || []);
  const gone = arr.find((x) => x.id === pid);
  check("identity anonymized", gone && String(gone.fullName).startsWith("محذوف") && !gone.phone && !gone.email);
  const invStill = await req("GET", "/api/invoices", { cookie: A });
  const iarr = Array.isArray(invStill.json) ? invStill.json : (invStill.json?.invoices || invStill.json?.items || []);
  check("financial trail survives (invoice kept)", iarr.some((x) => x.id === inv.json?.id));
  const rxGone = await req("GET", `/api/prescriptions?patientId=${pid}`, { cookie: A });
  check("prescriptions destroyed", rxGone.status === 200 && (Array.isArray(rxGone.json) ? rxGone.json : []).length === 0);
  const bEra = await req("POST", `/api/patients/${p2.json?.id}/erase`, { cookie: B });
  check("IDOR: clinic B cannot erase A's patient (403)", bEra.status === 403, `code=${bEra.status}`);
  await sleep(500);
  check("erase audited", auditLog().includes("patient.erase"));
  check("export audited", auditLog().includes("patient.export"));

  // ── retention ──
  const badRet = await req("PUT", "/api/clinics", { cookie: A, body: { id: clinicId, retentionDays: -5 } });
  check("retention rejects negative", badRet.status === 400, `code=${badRet.status}`);
  const setRet = await req("PUT", "/api/clinics", { cookie: A, body: { id: clinicId, retentionDays: 3650 } });
  check("retention configured", setRet.status === 200, `code=${setRet.status}`);
  const run = await req("POST", "/api/retention/run", { cookie: A });
  check("manual retention run (nothing old)", run.status === 200 &&
    Object.values(run.json?.purged || {}).every((n) => n === 0), JSON.stringify(run.json?.purged));
  await sleep(500);
  check("retention run audited", auditLog().includes("retention.run"));

  // ── --rotate-sessions ──
  const me1 = await req("GET", "/api/auth/me", { cookie: A });
  check("session alive before rotation", me1.status === 200, `code=${me1.status}`);
  const rot = spawnSync(process.execPath, ["server.js", "--rotate-sessions"], {
    cwd: APP_DIR, env: { ...process.env, DATA_DIR: TMP }, encoding: "utf8",
  });
  check("--rotate-sessions exits 0", rot.status === 0, `exit=${rot.status} ${(rot.stderr || "").slice(0, 120)}`);
  // the live server still holds sessions in memory, but the FILE store is empty:
  // any restart would log everyone out — prove the file state
  await sleep(400);
  let sessFile = "";
  try { sessFile = fs.readFileSync(path.join(TMP, "sessions.json"), "utf8"); } catch { /* missing */ }
  check("session store cleared on disk", sessFile.trim() === "{}" || sessFile.trim() === "", sessFile.slice(0, 40));

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
