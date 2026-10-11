/**
 * Automated security suite — runs against a throwaway server (temp DATA_DIR, its
 * own port) with no browser. Covers:
 *   1. IDOR / clinic isolation across every collection
 *   2. Role boundaries + deny-by-default for unlisted routes
 *   3. XSS: booking payloads, output context, CSP, booking-page escaping
 *   4. Account/clinic enumeration + login lockout + CORS reflection
 *   5. Static file leakage (db, source, tests, path traversal)
 *   6. TOTP secret sealed at rest when ENCRYPTION_KEY is set
 *
 * Prints "PASS n   FAIL n" so run-suite.js can summarise it.
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3187;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-sec-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── tiny HTTP client with a cookie jar ── */
function req(method, urlPath, { body, token, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = { ...headers };
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    if (token) h["Cookie"] = `eyada_session=${token}`;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not json */ }
        const setCookie = res.headers["set-cookie"] || [];
        const m = setCookie.map((c) => /eyada_session=([^;]+)/.exec(c)).find(Boolean);
        resolve({ status: res.statusCode, headers: res.headers, text: buf, json, token: m ? m[1] : null });
      });
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, text: String(e.message), json: null, token: null }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, text: "timeout", json: null, token: null }); });
    if (data) r.write(data);
    r.end();
  });
}

/* ── TOTP (mirrors the server, for the encryption-at-rest check) ── */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac("sha1", b32decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1000000).padStart(6, "0");
}

function portFree() {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", method: "GET", timeout: 800 },
      (res) => { res.resume(); resolve(false); });
    r.on("error", () => resolve(true));
    r.on("timeout", () => { r.destroy(); resolve(true); });
    r.end();
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

const isDenied = (st) => st === 403 || st === 404;

(async () => {
  if (!(await portFree())) { console.log(`FAIL test-security.js — port ${PORT} busy`); process.exit(1); }

  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1", ENCRYPTION_KEY: ENC_KEY, LOGIN_MAX: "12" },
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

  if (!(await waitHealthy())) {
    console.log("server never became healthy:\n" + srvOut);
    finish(1);
    return;
  }

  try {
    /* ── 0. baseline ── */
    const health = await req("GET", "/api/health");
    check("GET /api/health is 200", health.status === 200, `got ${health.status}`);

    /* ── register two clinics (A and B) with distinct owners ── */
    const regA = await req("POST", "/api/auth/register",
      { body: { username: "ownerA", password: "Clinic-A-Secret-2026", fullName: "مالك أ", clinicName: "Clinic Alpha" } });
    const regB = await req("POST", "/api/auth/register",
      { body: { username: "ownerB", password: "Clinic-B-Secret-2026", fullName: "مالك ب", clinicName: "Clinic Beta" } });
    check("register clinic A returns a session", regA.status === 200 && !!regA.token, `got ${regA.status}`);
    check("register clinic B returns a session", regB.status === 200 && !!regB.token, `got ${regB.status}`);
    const A = { token: regA.token, clinic: regA.json && regA.json.currentClinicId, user: regA.json && regA.json.user && regA.json.user.id };
    const B = { token: regB.token, clinic: regB.json && regB.json.currentClinicId, user: regB.json && regB.json.user && regB.json.user.id };
    check("A and B are different clinics", A.clinic && B.clinic && A.clinic !== B.clinic);

    /* ── create one entity of each kind in clinic A ── */
    const patA = await req("POST", "/api/patients", { token: A.token, body: { fullName: "Patient Alpha", phone: "0500000001" } });
    check("A can create a patient", patA.status === 200 && patA.json && patA.json.id, `got ${patA.status}`);
    const patientA = patA.json && patA.json.id;

    const apptA = await req("POST", "/api/appointments", { token: A.token, body: { patientId: patientA, title: "Alpha visit", startTime: new Date(Date.now() + 3600000).toISOString(), duration: 30 } });
    check("A can create an appointment", apptA.status === 200 && apptA.json && apptA.json.id, `got ${apptA.status}`);
    const apptId = apptA.json && apptA.json.id;

    const invA = await req("POST", "/api/invoices", { token: A.token, body: { patientId: patientA, subtotal: 100, taxPercentage: 15, paidAmount: 0 } });
    check("A can create an invoice", invA.status === 200 && invA.json && invA.json.id, `got ${invA.status}`);
    const invId = invA.json && invA.json.id;

    const recA = await req("POST", "/api/records", { token: A.token, body: { patientId: patientA, diagnosis: "Alpha dx" } });
    check("A can create a record", recA.status === 200 && recA.json && recA.json.id, `got ${recA.status}`);
    const recId = recA.json && recA.json.id;

    const itemA = await req("POST", "/api/inventory", { token: A.token, body: { itemName: "Alpha item", quantity: 3 } });
    check("A can create an inventory item", itemA.status === 200 && itemA.json && itemA.json.id, `got ${itemA.status}`);
    const itemId = itemA.json && itemA.json.id;

    const taskA = await req("POST", "/api/tasks", { token: A.token, body: { title: "Alpha task" } });
    check("A can create a task", taskA.status === 200 && taskA.json && taskA.json.id, `got ${taskA.status}`);
    const taskId = taskA.json && taskA.json.id;

    const svcA = await req("POST", "/api/services", { token: A.token, body: { name: "Alpha service", durationMin: 20, price: 100 } });
    check("A can create a service", svcA.status === 200 && svcA.json && svcA.json.id, `got ${svcA.status}`);
    const svcId = svcA.json && svcA.json.id;

    /* ───────────────────────── 1. IDOR ───────────────────────── */
    const put = (p, id) => req("PUT", p, { token: B.token, body: { id, notes: "pwned", title: "pwned", diagnosis: "pwned", name: "pwned", itemName: "pwned", patientId: patientA } });
    const del = (p, id) => req("DELETE", p, { token: B.token, body: { id } });

    const idorCases = [
      ["patients", "/api/patients", patientA],
      ["appointments", "/api/appointments", apptId],
      ["invoices", "/api/invoices", invId],
      ["records", "/api/records", recId],
      ["inventory", "/api/inventory", itemId],
      ["tasks", "/api/tasks", taskId],
      ["services", "/api/services", svcId],
    ];
    for (const [label, p, id] of idorCases) {
      const u = await put(p, id);
      const d = await del(p, id);
      check(`IDOR: B cannot PUT ${label} of A`, isDenied(u.status), `got ${u.status}`);
      check(`IDOR: B cannot DELETE ${label} of A`, isDenied(d.status), `got ${d.status}`);
    }

    // cross-clinic create: B tries to inject clinicId=A
    const injectPat = await req("POST", "/api/patients", { token: B.token, body: { fullName: "Injected", clinicId: A.clinic } });
    check("IDOR: B cannot create a patient into clinic A", injectPat.status === 403 || (injectPat.json && injectPat.json.clinicId !== A.clinic), `status ${injectPat.status}`);
    const injectTask = await req("POST", "/api/tasks", { token: B.token, body: { title: "Injected task", clinicId: A.clinic } });
    check("IDOR: B cannot create a task into clinic A", injectTask.json && injectTask.json.clinicId !== A.clinic);
    const injectSvc = await req("POST", "/api/services", { token: B.token, body: { name: "Injected", clinicId: A.clinic } });
    check("IDOR: B cannot create a service into clinic A", isDenied(injectSvc.status) || (injectSvc.json && injectSvc.json.clinicId !== A.clinic), `status ${injectSvc.status}`);

    // list scoping: B's lists must not contain any of A's ids
    const lists = [["/api/patients", "patients"], ["/api/appointments", null], ["/api/invoices", "invoices"], ["/api/inventory", null], ["/api/tasks", null], ["/api/services", null]];
    const aIds = new Set([patientA, apptId, invId, itemId, taskId, svcId]);
    for (const [p] of lists) {
      const r = await req("GET", p, { token: B.token });
      const arr = Array.isArray(r.json) ? r.json : (r.json && (r.json.patients || r.json.invoices || []));
      const leaked = (arr || []).some((x) => aIds.has(x.id));
      check(`IDOR: B list ${p} leaks nothing from A`, r.status === 200 && !leaked, `status ${r.status}`);
    }

    // B cannot read A's records via ?patientId=
    const recLeak = await req("GET", `/api/records?patientId=${patientA}`, { token: B.token });
    const recArr = Array.isArray(recLeak.json) ? recLeak.json : [];
    check("IDOR: B cannot read A's records via patientId", recLeak.status === 200 && recArr.length === 0, `n=${recArr.length}`);

    // users: B must not see or edit A's account
    const usersB = await req("GET", "/api/users", { token: B.token });
    const seesA = (usersB.json || []).some((u) => u.id === A.user);
    check("IDOR: B's user list hides A's account", usersB.status === 200 && !seesA);
    const editA = await req("PUT", "/api/users", { token: B.token, body: { id: A.user, fullName: "pwned" } });
    check("IDOR: B cannot edit A's account", isDenied(editA.status), `got ${editA.status}`);
    const delA = await req("DELETE", "/api/users", { token: B.token, body: { id: A.user } });
    check("IDOR: B cannot delete A's account", isDenied(delA.status) || delA.status === 402, `got ${delA.status}`);

    // chat: B cannot message a non-support user from A
    const chat = await req("POST", "/api/chat", { token: B.token, body: { receiverId: A.user, message: "hello" } });
    check("IDOR: B cannot chat with A's owner", chat.status === 403 || chat.status === 404, `got ${chat.status}`);

    // A's data must be intact after all the attacks
    const patAfter = await req("GET", "/api/patients", { token: A.token });
    const stillThere = (patAfter.json.patients || []).some((x) => x.id === patientA);
    check("IDOR: A's patient survived every attack", stillThere);

    /* ── anonymous access is refused ── */
    const anonPat = await req("GET", "/api/patients");
    check("anon GET /api/patients is 401", anonPat.status === 401, `got ${anonPat.status}`);
    const anonStaff = await req("GET", "/api/staff");
    check("deny-by-default: anon GET /api/staff is 401", anonStaff.status === 401, `got ${anonStaff.status}`);

    /* ───────────────────────── 2. ROLES ─────────────────────────
     * Use the seeded demo accounts: their clinic has a paid subscription, so a
     * role check is reached rather than the "trial clinics cannot hire" 402. */
    const roleLogin = async (u, p) => (await req("POST", "/api/auth/login", { body: { username: u, password: p } })).token;

    const recToken = await roleLogin("reception", "reception123");
    check("seeded receptionist can sign in", !!recToken);
    const recHire = await req("POST", "/api/users", { token: recToken, body: { username: "x1", password: "Whatever-Secret-2026", fullName: "x", role: "doctor" } });
    check("receptionist cannot hire staff (403)", recHire.status === 403, `got ${recHire.status}`);
    const recCross = await req("PUT", "/api/patients", { token: recToken, body: { id: patientA, fullName: "hacked" } });
    check("receptionist cannot touch another clinic's patient", isDenied(recCross.status), `got ${recCross.status}`);
    const recOwn = await req("GET", "/api/patients", { token: recToken });
    check("receptionist can read their own clinic's patients", recOwn.status === 200);

    const docToken = await roleLogin("doctor", "doctor123");
    check("seeded doctor can sign in", !!docToken);
    const docHire = await req("POST", "/api/users", { token: docToken, body: { username: "x2", password: "Whatever-Secret-2026", fullName: "x", role: "reception" } });
    check("doctor cannot hire staff (403)", docHire.status === 403, `got ${docHire.status}`);
    const docCross = await req("DELETE", "/api/patients", { token: docToken, body: { id: patientA } });
    check("doctor cannot delete another clinic's patient", isDenied(docCross.status), `got ${docCross.status}`);

    const supToken = await roleLogin("support", "support123");
    check("seeded support can sign in", !!supToken);
    const supTasks = await req("GET", "/api/tasks", { token: supToken });
    check("support cannot read clinic tasks (403)", supTasks.status === 403, `got ${supTasks.status}`);

    /* ───────────────────────── 3. XSS + CSP ───────────────────────── */
    const PAY = '<script>alert(1)</script>"><img src=x onerror=alert(2)>javascript:alert(3)';
    const xssPat = await req("POST", "/api/patients", { token: A.token, body: { fullName: PAY, notes: PAY } });
    check("XSS: payload stored as JSON, not executed server-side", xssPat.status === 200 && xssPat.headers["content-type"].includes("application/json"));
    const apiOut = await req("GET", "/api/patients", { token: A.token });
    check("XSS: API stays JSON (browser won't render it as HTML)", apiOut.headers["content-type"].includes("application/json"));

    const bookA = await req("GET", "/booking/clinic-alpha");
    check("booking page renders for clinic A", bookA.status === 200 && bookA.headers["content-type"].includes("text/html"));
    check("XSS: booking page shell does not inline the payload", !bookA.text.includes("<script>alert(1)</script>"));
    check("XSS: booking page has a JS escape helper", bookA.text.includes("function esc("));

    const csp = bookA.headers["content-security-policy"] || "";
    check("CSP: default-src 'self'", csp.includes("default-src 'self'"));
    check("CSP: object-src 'none'", csp.includes("object-src 'none'"));
    check("CSP: no unsafe-eval", !csp.includes("unsafe-eval"));
    const shell = await req("GET", "/");
    check("CSP present on the SPA shell too", (shell.headers["content-security-policy"] || "").includes("default-src 'self'"));
    check("nosniff header present", shell.headers["x-content-type-options"] === "nosniff");

    /* ───────────────────────── 4. ENUMERATION + CORS ───────────────────────── */
    const wrongPw = await req("POST", "/api/auth/login", { body: { username: "ownerA", password: "definitely-wrong" } });
    const noUser = await req("POST", "/api/auth/login", { body: { username: "ghost-user-xyz", password: "definitely-wrong" } });
    check("enumeration: same status for wrong-pw and unknown user", wrongPw.status === noUser.status && wrongPw.status === 401, `${wrongPw.status}/${noUser.status}`);
    check("enumeration: identical message", wrongPw.json && noUser.json && wrongPw.json.error === noUser.json.error);

    const evil = await req("GET", "/api/health", { headers: { Origin: "https://evil.example" } });
    check("CORS: foreign Origin is not reflected", !evil.headers["access-control-allow-origin"], String(evil.headers["access-control-allow-origin"]));
    const evilOpt = await req("OPTIONS", "/api/patients", { headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    check("CORS: foreign Origin not reflected on OPTIONS", !evilOpt.headers["access-control-allow-origin"], String(evilOpt.headers["access-control-allow-origin"]));
    const same = await req("GET", "/api/health", { headers: { Origin: BASE } });
    check("CORS: same-host Origin is allowed", same.headers["access-control-allow-origin"] === BASE, String(same.headers["access-control-allow-origin"]));

    // login lockout (LOGIN_MAX=12 -> 429 by attempt 13)
    let locked = false;
    for (let i = 0; i < 14; i++) {
      const r = await req("POST", "/api/auth/login", { body: { username: "lockme", password: "nope" } });
      if (r.status === 429) { locked = true; break; }
    }
    check("lockout: repeated failures eventually 429", locked);

    /* ───────────────────────── 5. STATIC LEAKAGE ───────────────────────── */
    const leaks = ["/data/db.json", "/server.js", "/tests/test-security.js", "/.gitignore", "/data%2fdb.json", "/%2e%2e/server.js", "/..%2fserver.js"];
    for (const p of leaks) {
      const r = await req("GET", p);
      check(`static: ${p} does not leak`, r.status === 404, `got ${r.status}`);
    }

    /* ───────────────────────── 6. TOTP SECRET SEALED AT REST ───────────────────────── */
    const setup = await req("POST", "/api/auth/2fa/setup", { token: A.token });
    check("2FA setup returns a secret", setup.status === 200 && setup.json && setup.json.secret);
    const secret = setup.json && setup.json.secret;
    const code = totp(secret);
    const enable = await req("POST", "/api/auth/2fa/enable", { token: A.token, body: { code } });
    check("2FA can be enabled with a valid code", enable.status === 200, `got ${enable.status}`);
    await sleep(300); // let the debounced flush land
    const onDisk = fs.readFileSync(path.join(TMP, "db.json"), "utf8");
    check("2FA: secret is NOT stored in clear on disk", !onDisk.includes(secret));
    check("2FA: secret is sealed with enc:v1:", onDisk.includes("enc:v1:"));

    // the API must never expose the secret
    const me = await req("GET", "/api/auth/me", { token: A.token });
    check("2FA: /api/auth/me never exposes twoFactorSecret", !me.text.includes("twoFactorSecret"));
    const usersList = await req("GET", "/api/users", { token: A.token });
    check("2FA: user list never exposes twoFactorSecret", !usersList.text.includes("twoFactorSecret"));

    finish(fail ? 1 : 0);
  } catch (e) {
    console.log("EXCEPTION:", e && e.stack || e);
    console.log(srvOut.split(/\r?\n/).slice(-15).join("\n"));
    finish(1);
  }
})();
