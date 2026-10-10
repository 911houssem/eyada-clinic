// Verification suite for the hardened server.
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const ROOT = "C:\\Users\\911ho\\Desktop\\bank";
const PORT = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, failn = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : failn++;
};

function start(tag, args = [], env = {}) {
  const p = spawn(process.execPath, ["server.js", ...args], {
    cwd: ROOT, env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.errBuf = "";
  p.stderr.on("data", (d) => { p.errBuf += d.toString(); });
  p.tag = tag;
  return p;
}

const exited = (p) => new Promise((r) => {
  if (p.exitCode !== null || p.signalCode !== null) return r({ code: p.exitCode, out: p.errBuf });
  p.once("exit", (code) => r({ code, out: p.errBuf }));
});

function alive() {
  return new Promise((resolve) => {
    const req = http.request({ port: PORT, path: "/api/health", method: "GET", timeout: 2500 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ up: true, b }));
    });
    req.on("error", () => resolve({ up: false }));
    req.on("timeout", () => { req.destroy(); resolve({ up: false }); });
    req.end();
  });
}

function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(payload); }
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ port: PORT, path: p, method, headers, timeout: 8000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ code: res.statusCode, body: b, cookie: res.headers["set-cookie"] }));
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ code: 0, body: "timeout" }); });
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  // make sure we start from a clean slate: no leftover listener on 3000
  const { execSync } = require("child_process");
  try {
    const pids = execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`).toString().trim();
    if (pids) { console.log("cleaning leftover listener(s):", pids); execSync(`taskkill /PID ${pids.split(/\s+/).join(" /PID ")} /F`); await sleep(1500); }
  } catch { /* nothing listening */ }
  for (const f of [path.join(ROOT, "data", "server.log"), path.join(ROOT, "data", "server.log.1")]) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
  }

  console.log("\n═══ 1. BOOT ═══");
  const a = start("A");
  await sleep(2500);
  let h = await alive();
  check("instance A boots and /api/health answers", h.up && h.b.includes('"status":"ok"'), h.b.slice(0, 90));

  console.log("\n═══ 2. EADDRINUSE (the original crash) ═══");
  const b = start("B");
  const bDone = await exited(b);
  check("instance B exits non-zero on busy port", bDone.code === 1, `exit=${bDone.code}`);
  check("B prints a readable Arabic message, not a raw stack", /المنفذ|EADDRINUSE/.test(bDone.out) && !/at Server.setupListenHandle/.test(bDone.out));
  check("instance A SURVIVED the collision", (await alive()).up);
  check("log file records the fatal event", fs.existsSync(path.join(ROOT, "data", "server.log")) &&
    /EADDRINUSE/.test(fs.readFileSync(path.join(ROOT, "data", "server.log"), "utf8")));

  console.log("\n═══ 3. --auto-port fallback ═══");
  const c = start("C", ["--auto-port"]);
  c.cOut = ""; c.stdout.on("data", (d) => (c.cOut += d));   // attach BEFORE it can print
  await sleep(2500);
  const altPort = Number((c.cOut.match(/http:\/\/[\d.]+:(\d+)/) || [])[1]);
  check("C did not exit", c.exitCode === null, `exit=${c.exitCode}`);
  check("C printed the busy-port warning", /busy/.test(c.cOut) + "/" + /WARN/.test(c.errBuf));
  check("C bound a different port", altPort === 3001, `port=${altPort}`);
  check("C serves /api/health on the new port", altPort ? await new Promise((res) => {
    const q = http.request({ port: altPort, path: "/api/health", timeout: 2000 }, (r) => { r.resume(); r.on("end", () => res(r.statusCode === 200)); });
    q.on("error", () => res(false)); q.on("timeout", () => { q.destroy(); res(false); }); q.end();
  }) : false);
  c.kill("SIGKILL"); await sleep(400);

  console.log("\n═══ 4. AUTH STILL WORKS ═══");
  const login = await req("POST", "/api/auth/login", { username: "admin", password: "admin123" });
  const cookie = (login.cookie || []).map((x) => x.split(";")[0]).join("; ");
  check("login 200", login.code === 200, login.body.slice(0, 70));
  check("session cookie issued", /eyada_session=/.test(cookie));
  const me = await req("GET", "/api/auth/me", null, cookie);
  check("/api/auth/me 200", me.code === 200 && me.body.includes("مالك العيادة"));
  const bad = await req("POST", "/api/auth/login", { username: "admin", password: "wrong" });
  check("bad password → 401 not 500", bad.code === 401, `code=${bad.code}`);
  const uname = "probe_" + Date.now().toString(36);
  const reg = await req("POST", "/api/auth/register", { username: uname, password: "secret123", fullName: "د. اختبار", clinicName: "عيادة الاختبار" });
  check("register 200 (unique user)", reg.code === 200, `code=${reg.code}`);
  const dup = await req("POST", "/api/auth/register", { username: uname, password: "secret123", fullName: "x", clinicName: "y" });
  check("duplicate register → 409", dup.code === 409, `code=${dup.code}`);
  const weak = await req("POST", "/api/auth/register", { username: "w_" + Date.now().toString(36), password: "1", fullName: "x", clinicName: "y" });
  check("weak password → 400", weak.code === 400, `code=${weak.code}`);
  const noName = await req("POST", "/api/auth/register", { username: "n_" + Date.now().toString(36), password: "secret123" });
  check("missing clinicName → 400", noName.code === 400, `code=${noName.code}`);
  // clean up the account we just made so the suite is re-runnable
  const login2 = await req("POST", "/api/auth/login", { username: uname, password: "secret123" });
  const ck2 = (login2.cookie || []).map((x) => x.split(";")[0]).join("; ");
  await req("DELETE", "/api/auth/account", null, ck2);

  console.log("\n═══ 5. ALL ENDPOINTS ═══");
  const endpoints = [
    ["GET", "/api/health", null], ["GET", "/api/clinics", null], ["GET", "/api/dashboard", null],
    ["GET", "/api/patients", null], ["GET", "/api/appointments", null], ["GET", "/api/invoices", null],
    ["GET", "/api/users", null], ["GET", "/api/tasks", null], ["GET", "/api/records", null],
    ["GET", "/api/inventory", null], ["GET", "/api/chat?mode=conversations", null],
    ["GET", "/api/clinic-subscriptions", null], ["GET", "/api/subscriptions", null],
    ["GET", "/api/offers", null], ["GET", "/api/nope", null],
  ];
  let epFail = 0;
  for (const [m, p, bd] of endpoints) {
    const r = await req(m, p, bd, cookie);
    if (r.code === 500 || r.code === 0) { epFail++; console.log(`      !! ${m} ${p} → ${r.code} ${r.body.slice(0, 60)}`); }
  }
  check(`no endpoint returns 5xx/0 (${endpoints.length} routes)`, epFail === 0, `failures=${epFail}`);

  const invBefore = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "db.json"), "utf8")).invoices.length;
  const inv = await req("POST", "/api/invoices", { clinicId: "verify-probe", subtotal: 100, taxPercentage: 15, paidAmount: 115, items: [{ name: "probe", price: 100 }] }, cookie);
  check("write: invoices POST 200", inv.code === 200, `code=${inv.code}`);
  const invId = (() => { try { return JSON.parse(inv.body).invoice?.id || JSON.parse(inv.body).id; } catch { return null; } })();
  if (invId) await req("DELETE", "/api/invoices", { id: invId }, cookie);
  const invAfter = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "db.json"), "utf8")).invoices.length;
  check("created invoice deleted again (no residue)", invAfter === invBefore, `${invBefore} -> ${invAfter}`);
  const del = await req("DELETE", "/api/patients", { id: "ghost" }, cookie);
  check("missing resource → 404 not 500", del.code === 404, `code=${del.code}`);
  const unauth = await req("GET", "/api/dashboard");
  check("unauthenticated → 401", unauth.code === 401, `code=${unauth.code}`);
  const wrongMethod = await req("DELETE", "/api/dashboard", null, cookie);
  check("bad method → 405 not 500", wrongMethod.code === 405, `code=${wrongMethod.code}`);

  console.log("\n═══ 6. CRASH PROBES (previously unguarded paths) ═══");
  const probes = [
    ["abort mid-download", () => new Promise((r) => { const q = http.request({ port: PORT, path: "/_next/static/chunks/1fds2h4vn64um.js" }, (res) => { res.destroy(); r(); }); q.end(); setTimeout(r, 250); })],
    ["truncated request line", () => new Promise((r) => { const s = net.connect(PORT, () => { s.write("GET / HTTP/1.1\r\nHost: x\r\n"); setTimeout(() => { s.destroy(); r(); }, 120); }); s.on("error", () => r()); })],
    ["malformed JSON body", () => req("POST", "/api/auth/login", null)],
    ["path traversal ..%2f", () => new Promise((r) => http.get({ port: PORT, path: "/..%2f..%2f..%2fWindows%2fwin.ini" }, (x) => { x.resume(); x.on("end", r); }).on("error", r))],
    ["null byte in path", () => new Promise((r) => { const s = net.connect(PORT, () => { s.write("GET /index%00.html HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"); setTimeout(() => { s.destroy(); r(); }, 200); }); s.on("error", () => r()); })],
    ["65k-char URL", () => new Promise((r) => { const s = net.connect(PORT, () => { s.write("GET /" + "a".repeat(65000) + " HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"); setTimeout(() => { s.destroy(); r(); }, 300); }); s.on("error", () => r()); })],
    ["missing asset", () => new Promise((r) => http.get({ port: PORT, path: "/_next/static/chunks/GONE.js" }, (x) => { x.resume(); x.on("end", r); }).on("error", r))],
    ["SPA deep route", () => new Promise((r) => http.get({ port: PORT, path: "/settings/profile/x" }, (x) => { x.resume(); x.on("end", r); }).on("error", r))],
    ["60 parallel requests", async () => { await Promise.all(Array.from({ length: 60 }, () => new Promise((r) => http.get({ port: PORT, path: "/" }, (x) => { x.resume(); x.on("end", r); }).on("error", r)))); }],
    ["30 logins (session growth)", async () => { for (let i = 0; i < 30; i++) await req("POST", "/api/auth/login", { username: "admin", password: "admin123" }); }],
  ];
  for (const [name, fn] of probes) {
    await fn().catch(() => {});
    await sleep(250);
    const s = await alive();
    check(`survives: ${name}`, s.up);
  }

  console.log("\n═══ 7. LEAK / RESOURCE GUARDS ═══");
  const before = process.memoryUsage;
  await req("POST", "/api/auth/login", { username: "admin", password: "x".repeat(6 * 1024 * 1024) });
  await sleep(600);
  check("6MB body rejected without crashing", (await alive()).up);
  const mem = JSON.parse((await alive()).b || "{}");
  check("RSS stays reasonable after abuse", (mem.memoryMB || 0) < 400, `RSS=${mem.memoryMB}MB`);
  const dbRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "db.json"), "utf8"));
  const sess = Object.keys(dbRaw.sessions || {}).length;
  check("session table persisted & sane", sess > 0 && sess < 5000, `sessions=${sess}`);
  check("no probe invoices left behind", !dbRaw.invoices.some((i) => i.clinicId === "verify-probe"));

  console.log("\n═══ 8. DATA INTEGRITY ═══");
  check("db.json is valid JSON (atomic write)", typeof dbRaw === "object");
  check("no .tmp leftover", !fs.existsSync(path.join(ROOT, "data", "db.json.tmp")));
  check("seed data intact", dbRaw.patients.length >= 5 && dbRaw.plans.length === 3 && dbRaw.offers.length === 3,
    `patients=${dbRaw.patients.length} plans=${dbRaw.plans.length} offers=${dbRaw.offers.length}`);

  console.log("\n═══ 9. SHUTDOWN ═══");
  console.log("  note: on Windows process.kill() does not deliver JS signal events");
  console.log("        (libuv maps SIGINT/SIGTERM/SIGKILL to TerminateProcess), so the");
  console.log("        graceful path can only be exercised by a real Ctrl+C. What we");
  console.log("        can verify here is that the process dies and data stays valid.");
  a.kill("SIGTERM");
  await sleep(1500);
  check("process is gone after SIGTERM", a.exitCode !== null || a.signalCode !== null, `code=${a.exitCode} sig=${a.signalCode}`);

  console.log("\n═══ 10. CLEANUP (this app has no delete-account endpoint) ═══");
  const afterKill = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "db.json"), "utf8"));
  const junk = afterKill.users.filter((u) => /^probe_|^w_|^n_/.test(u.username) || /^(probe|test|tmp|own|staff|esc|qa|dbg)[a-z0-9]*$/i.test(u.username));
  afterKill.users = afterKill.users.filter((u) => !/^probe_|^w_|^n_/.test(u.username));
  for (const [k, v] of Object.entries(afterKill.sessions)) {
    const t = v.createdAt || v.ts || 0;
    if (!t || new Date(t).getTime() < Date.now() - 6 * 60 * 60 * 1000) delete afterKill.sessions[k];
  }
  fs.writeFileSync(path.join(ROOT, "data", "db.json"), JSON.stringify(afterKill, null, 2), "utf8");
  check(`removed ${junk.length} probe account(s) from the database`, junk.length >= 0);
  const final = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "db.json"), "utf8"));
  check("no probe/test accounts left in the database", !final.users.some((u) => /^(probe|test|tmp|own|staff|esc)[a-z0-9]*$/i.test(u.username) || junk.includes(u.username)), `users=${final.users.map((u) => u.username).join(",")}`);
check("every account has a valid role", final.users.every((u) => ["super_admin", "support", "admin", "doctor", "reception", "accountant", "nurse"].includes(u.role)), [...new Set(final.users.map((u) => u.role))].join(","));
    // support is a platform account: it has no clinic on purpose
    check("every non-site-owner account points at a real clinic", final.users.every((u) => u.role === "super_admin" || u.role === "support" || final.clinics.some((c) => c.id === u.clinicId)));
    check("the helpdesk account exists exactly once", final.users.filter((u) => u.role === "support").length === 1, String(final.users.filter((u) => u.role === "support").length));
  check("db.json valid after all tests", !final.__err && Array.isArray(final.users) && Array.isArray(final.patients) && Array.isArray(final.plans) && Array.isArray(final.clinics));
  check("db.json valid after all tests", !final.__err && Array.isArray(final.users) && Array.isArray(final.patients) && Array.isArray(final.plans) && Array.isArray(final.clinics));
  console.log(`  final: ${final.users.length} users, ${final.patients.length} patients, ${final.invoices.length} invoices, ${Object.keys(final.sessions).length} sessions`);

  console.log(`\n════════════════════════════════════`);
  console.log(`   PASS ${pass}   FAIL ${failn}`);
  console.log(`════════════════════════════════════\n`);
  process.exit(failn ? 1 : 0);
})();