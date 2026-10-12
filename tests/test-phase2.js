/**
 * Phase 2 suite — password reset, soft delete / trash, pagination.
 * Runs against a throwaway server (temp DATA_DIR, own port, dev mode) with the
 * default console notifier, so the reset link is recovered from server stdout.
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
const PORT = 3188;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-p2-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const sc = res.headers["set-cookie"] || [];
        const m = sc.map((c) => /eyada_session=([^;]+)/.exec(c)).find(Boolean);
        resolve({ status: res.statusCode, headers: res.headers, text: buf, json, token: m ? m[1] : null });
      });
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, text: String(e.message), json: null, token: null }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, text: "timeout", json: null, token: null }); });
    if (data) r.write(data);
    r.end();
  });
}

/* ── TOTP (mirrors the server, for the 2FA-gated reset) ── */
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
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | (mac[off + 3]);
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

(async () => {
  if (!(await portFree())) { console.log(`FAIL test-phase2.js — port ${PORT} busy`); process.exit(1); }

  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1", ENCRYPTION_KEY: ENC_KEY },
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

  /* ── login as the seeded demo owner ── */
  const owner = await req("POST", "/api/auth/login", { body: { username: "admin", password: "admin123" } });
  const staff = await req("POST", "/api/auth/login", { body: { username: "reception", password: "reception123" } });
  const A = owner.token, R = staff.token;
  check("demo owner + receptionist can sign in", owner.status === 200 && staff.status === 200);

  /* ═════════════ 1. PAGINATION ═════════════ */
  for (let i = 0; i < 7; i++) {
    await req("POST", "/api/patients", { token: A, body: { fullName: `مريض رقم ${i}`, phone: `05550000${i}` } });
  }
  const legacy = await req("GET", "/api/patients", { token: A });
  check("no page/limit -> legacy {patients,pages} shape",
    legacy.status === 200 && Array.isArray(legacy.json.patients) && typeof legacy.json.pages === "number");

  const pg = await req("GET", "/api/patients?page=1&limit=3", { token: A });
  check("page/limit -> {items,total,page,limit}",
    pg.status === 200 && Array.isArray(pg.json.items) && typeof pg.json.total === "number"
    && pg.json.page === 1 && pg.json.limit === 3);
  check("page length respects limit", pg.json.items.length <= 3, `items=${pg.json.items.length}`);
  check("total >= returned page", pg.json.total >= pg.json.items.length);

  const clamp = await req("GET", "/api/patients?limit=999", { token: A });
  check("limit clamped to 200", clamp.json.limit === 200, `limit=${clamp.json.limit}`);

  const searched = await req("GET", "/api/patients?limit=50&q=055500000", { token: A });
  check("q= filters the paged list", searched.json.total >= 1 && searched.json.items.every((p) => String(p.phone).includes("055500000")));

  const tasksPg = await req("GET", "/api/tasks?limit=1", { token: A });
  check("tasks support paging shape", tasksPg.status === 200 && tasksPg.json && Array.isArray(tasksPg.json.items));

  /* ═════════════ 2. SOFT DELETE + TRASH ═════════════ */
  const p1 = await req("POST", "/api/patients", { token: A, body: { fullName: "مريض للحذف", phone: "0555999999" } });
  const pid = p1.json.id;

  const inv = await req("POST", "/api/invoices", { token: A, body: { patientId: pid, subtotal: 100, total: 100, paidAmount: 0 } });
  check("invoice with a due balance created", inv.status === 200 && inv.json.dueAmount === 100);

  const delNoConfirm = await req("DELETE", "/api/patients", { token: A, body: { id: pid } });
  check("patient with unpaid invoice needs explicit confirm (409)", delNoConfirm.status === 409, `got ${delNoConfirm.status}`);

  const delOk = await req("DELETE", "/api/patients", { token: A, body: { id: pid, confirm: true } });
  check("patient soft-deleted with confirm", delOk.status === 200 && delOk.json.softDeleted === true);

  const listAfter = await req("GET", "/api/patients?limit=200", { token: A });
  check("deleted patient is hidden from the list", !listAfter.json.items.some((p) => p.id === pid));

  const trash = await req("GET", "/api/trash", { token: A });
  check("patient appears in /api/trash", trash.status === 200 && trash.json.items.some((t) => t.type === "patients" && t.id === pid));

  const restoreDenied = await req("POST", `/api/trash/patients/${pid}/restore`, { token: R });
  check("receptionist cannot restore (403)", restoreDenied.status === 403, `got ${restoreDenied.status}`);

  const restored = await req("POST", `/api/trash/patients/${pid}/restore`, { token: A });
  check("owner restores the patient", restored.status === 200);
  const listRestored = await req("GET", "/api/patients?limit=200", { token: A });
  check("restored patient is back in the list", listRestored.json.items.some((p) => p.id === pid));

  // appointment + task + service + inventory + record soft deletes
  // (fixed far-future start so it never collides with the seeded demo slots)
  const farFuture = new Date(Date.now() + 45 * 864e5).toISOString();
  const appt = await req("POST", "/api/appointments", { token: A, body: { patientId: pid, title: "موعد للحذف", startTime: farFuture } });
  const delAppt = await req("DELETE", "/api/appointments", { token: A, body: { id: appt.json.id } });
  const apptsAfter = await req("GET", "/api/appointments", { token: A });
  check("deleted appointment is hidden", delAppt.status === 200 && !apptsAfter.json.some((a) => a.id === appt.json.id));

  const task = await req("POST", "/api/tasks", { token: A, body: { title: "مهمة للحذف" } });
  const delTask = await req("DELETE", "/api/tasks", { token: A, body: { id: task.json.id } });
  const tasksAfter = await req("GET", "/api/tasks", { token: A });
  check("deleted task is hidden", delTask.status === 200 && !tasksAfter.json.some((t) => t.id === task.json.id));

  const svc = await req("POST", "/api/services", { token: A, body: { name: "خدمة للحذف" } });
  const invItem = await req("POST", "/api/inventory", { token: A, body: { itemName: "صنف للحذف", quantity: 5 } });
  const delSvc = await req("DELETE", "/api/services", { token: A, body: { id: svc.json.id } });
  const delInv = await req("DELETE", "/api/inventory", { token: A, body: { id: invItem.json.id } });
  const svcsAfter = await req("GET", "/api/services?all=true", { token: A });
  const invAfter = await req("GET", "/api/inventory", { token: A });
  check("deleted service + inventory item are hidden",
    delSvc.status === 200 && delInv.status === 200
    && !svcsAfter.json.some((s) => s.id === svc.json.id)
    && !invAfter.json.some((it) => it.id === invItem.json.id));

  const trashAll = await req("GET", "/api/trash", { token: A });
  const types = new Set(trashAll.json.items.map((t) => t.type));
  check("trash spans multiple entity types", types.has("services") && types.has("tasks") && types.has("appointments"));

  // records carry clinicId: trashed ones must be visible + restorable (regression)
  const rec = await req("POST", "/api/records", { token: A, body: { patientId: pid, chiefComplaint: "صداع", diagnosis: "توتر" } });
  const delRec = await req("DELETE", "/api/records", { token: A, body: { id: rec.json.id } });
  const trashRec = await req("GET", "/api/trash?type=records", { token: A });
  check("trashed record is visible in trash", delRec.status === 200 && (trashRec.json.items || []).some((t) => t.id === rec.json.id));
  const restRec = await req("POST", `/api/trash/records/${rec.json.id}/restore`, { token: A });
  check("trashed record restores", restRec.status === 200, `code=${restRec.status}`);

  /* ═════════════ 3. PASSWORD RESET ═════════════ */
  const reg = await req("POST", "/api/auth/register", {
    body: { username: "resetuser", password: "Reset-Secret-2026", fullName: "مستخدم الاختبار", clinicName: "عيادة الاستعادة" },
  });
  check("registered a throwaway account", reg.status === 200);

  const forgotUnknown = await req("POST", "/api/auth/forgot", { body: { username: "nobody-here" } });
  const forgotKnown = await req("POST", "/api/auth/forgot", { body: { username: "resetuser" } });
  check("forgot returns 200 for unknown + known",
    forgotUnknown.status === 200 && forgotKnown.status === 200);
  check("forgot response is identical (no enumeration)",
    forgotUnknown.json.message === forgotKnown.json.message && forgotKnown.json.message.length > 0);

  await sleep(400);
  const linkMatch = /resetToken=([0-9a-f]{64})/.exec(srvOut);
  check("reset link emitted via the console notifier", !!linkMatch);
  const token = linkMatch ? linkMatch[1] : "";

  const badToken = await req("POST", "/api/auth/reset", { body: { token: "deadbeef".repeat(8), newPassword: "Another-Secret-2026" } });
  check("unknown reset token rejected (400)", badToken.status === 400, `got ${badToken.status}`);

  const weak = await req("POST", "/api/auth/reset", { body: { token, newPassword: "short" } });
  check("weak new password rejected (400)", weak.status === 400, `got ${weak.status}`);

  const resetOk = await req("POST", "/api/auth/reset", { body: { token, newPassword: "Brand-New-Secret-2026" } });
  check("valid reset succeeds", resetOk.status === 200);

  const oldLogin = await req("POST", "/api/auth/login", { body: { username: "resetuser", password: "Reset-Secret-2026" } });
  const newLogin = await req("POST", "/api/auth/login", { body: { username: "resetuser", password: "Brand-New-Secret-2026" } });
  check("old password no longer works", oldLogin.status === 401, `got ${oldLogin.status}`);
  check("new password works", newLogin.status === 200 && !!newLogin.token);

  const reuse = await req("POST", "/api/auth/reset", { body: { token, newPassword: "Yet-Another-Secret-2026" } });
  check("reset token is single-use (400)", reuse.status === 400, `got ${reuse.status}`);

  /* 2FA-gated reset */
  const setup = await req("POST", "/api/auth/2fa/setup", { token: newLogin.token });
  const enable = await req("POST", "/api/auth/2fa/enable", { token: newLogin.token, body: { code: totp(setup.json.secret) } });
  check("2FA enabled on the throwaway account", enable.status === 200 && enable.json.enabled === true);

  const forgot2fa = await req("POST", "/api/auth/forgot", { body: { username: "resetuser" } });
  await sleep(400);
  const allTokens = [...srvOut.matchAll(/resetToken=([0-9a-f]{64})/g)].map((m) => m[1]);
  const token2 = allTokens[allTokens.length - 1];
  const noCode = await req("POST", "/api/auth/reset", { body: { token: token2, newPassword: "After-2FA-Secret-2026" } });
  check("reset without a 2FA code is refused (400)", noCode.status === 400, `got ${noCode.status}`);
  const withCode = await req("POST", "/api/auth/reset", { body: { token: token2, newPassword: "After-2FA-Secret-2026", twoFactorCode: totp(setup.json.secret) } });
  check("reset with a valid 2FA code succeeds", withCode.status === 200, `got ${withCode.status}`);

  /* ═════════════ 4. LOGOUT-ALL ═════════════ */
  const s1 = await req("POST", "/api/auth/login", { body: { username: "resetuser", password: "After-2FA-Secret-2026", twoFactorCode: totp(setup.json.secret) } });
  const s2 = await req("POST", "/api/auth/login", { body: { username: "resetuser", password: "After-2FA-Secret-2026", twoFactorCode: totp(setup.json.secret) } });
  check("two concurrent sessions established", s1.status === 200 && s2.status === 200 && !!s1.token && !!s2.token);

  const logoutAll = await req("POST", "/api/auth/logout-all", { token: s1.token });
  const check1 = await req("GET", "/api/auth/me", { token: s1.token });
  const check2 = await req("GET", "/api/auth/me", { token: s2.token });
  check("logout-all keeps the current session", logoutAll.status === 200 && check1.status === 200);
  check("logout-all revokes the other session", check2.status === 401, `got ${check2.status}`);

  finish(fail ? 1 : 0);
})();
