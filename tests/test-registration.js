/**
 * Registration-hardening suite — REGISTRATION=open|invite|closed, the strict
 * per-IP rate limit, single-use invite codes, and the pending-clinic cap.
 *
 * Each mode runs on its own throwaway server (temp DATA_DIR, dev mode).
 * Prints "PASS n   FAIL n" so run-suite.js can summarise it.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3197;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uniq = 0;
const U = (p) => `${p}${Date.now().toString(36)}${uniq++}`;

function req(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    if (cookie) h["Cookie"] = cookie;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let j = null; try { j = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json: j, text: buf });
      });
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
const regBody = (u) => ({ username: u, password: "Reg-Test-2026!", fullName: `Owner ${u}`, clinicName: `Clinic ${u}` });

async function withServer(env, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-reg-"));
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
  try {
    if (!(await waitHealthy())) { console.log("server never became healthy:\n" + out); fail++; return; }
    await fn();
  } finally {
    try { srv.kill("SIGKILL"); } catch { /* gone */ }
    await sleep(400);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

(async () => {
  // ── A. open mode + pending-clinic cap ──
  await withServer({ REGISTRATION: "open", REGISTER_MAX_PER_HOUR: "1000", MAX_PENDING_CLINICS: "1" }, async () => {
    console.log("  .. mode=open, pending cap=1");
    const r1 = await req("POST", "/api/auth/register", { body: regBody(U("cap1")) });
    check("open: first registration works", r1.status === 200, `code=${r1.status}`);
    const r2 = await req("POST", "/api/auth/register", { body: regBody(U("cap2")) });
    check("open: second blocked by the pending-clinic cap (429)", r2.status === 429, `code=${r2.status}`);
  });

  // ── B. invite mode ──
  await withServer({ REGISTRATION: "invite", REGISTER_MAX_PER_HOUR: "1000" }, async () => {
    console.log("  .. mode=invite");
    const noCode = await req("POST", "/api/auth/register", { body: regBody(U("inv0")) });
    check("invite: registration without a code is refused (403)", noCode.status === 403, `code=${noCode.status}`);
    const badCode = await req("POST", "/api/auth/register", { body: { ...regBody(U("invX")), inviteCode: "INV-NOPE" } });
    check("invite: bogus code is refused (403)", badCode.status === 403, `code=${badCode.status}`);

    const admin = await req("POST", "/api/auth/login", { body: { username: "houssem", password: "houssem123" } });
    const ac = cookieOf(admin);
    check("site owner signs in", admin.status === 200 && !!ac, `code=${admin.status}`);
    const mk = await req("POST", "/api/invites", { cookie: ac, body: {} });
    const code = mk.json?.code;
    check("site owner mints an invite code", mk.status === 200 && /^INV-/.test(code || ""), `code=${mk.status}`);
    const list = await req("GET", "/api/invites", { cookie: ac });
    check("invite listed", list.status === 200 && (list.json || []).some((x) => x.code === code));

    const ok = await req("POST", "/api/auth/register", { body: { ...regBody(U("inv1")), inviteCode: code } });
    check("invite: valid code registers (200)", ok.status === 200, `code=${ok.status}`);
    const reuse = await req("POST", "/api/auth/register", { body: { ...regBody(U("inv2")), inviteCode: code } });
    check("invite: code is single-use (403 on reuse)", reuse.status === 403, `code=${reuse.status}`);

    const ownerCookie = cookieOf(ok);
    const staffTry = await req("POST", "/api/invites", { cookie: ownerCookie, body: {} });
    check("invite: clinic owner cannot mint codes (403)", staffTry.status === 403, `code=${staffTry.status}`);
  });

  // ── C. closed mode ──
  await withServer({ REGISTRATION: "closed" }, async () => {
    console.log("  .. mode=closed");
    const r = await req("POST", "/api/auth/register", { body: regBody(U("clo1")) });
    check("closed: registration refused (403)", r.status === 403, `code=${r.status}`);
    const login = await req("POST", "/api/auth/login", { body: { username: "houssem", password: "houssem123" } });
    check("closed: login still works", login.status === 200, `code=${login.status}`);
  });

  // ── D. strict per-IP rate limit (defaults: 3/hour) ──
  await withServer({}, async () => {
    console.log("  .. default rate limit (3/hour)");
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await req("POST", "/api/auth/register", { body: regBody(U(`rl${i}`)) })).status);
    check("first three registrations pass", codes.slice(0, 3).every((c) => c === 200), codes.join(","));
    check("fourth registration is rate-limited (429)", codes[3] === 429, `code=${codes[3]}`);
  });

  console.log(`\n   PASS ${pass}   FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
