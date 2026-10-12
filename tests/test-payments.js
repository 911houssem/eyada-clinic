/**
 * Payments suite — cash/transfer/mock intents, server-recomputed totals,
 * idempotency keys, signed-webhook confirmation with replay safety, and
 * clinic isolation. Own throwaway server. Prints "PASS n   FAIL n".
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3204;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-pay-"));
const SECRET = "unit-test-webhook-secret-xyz";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (id, status) => crypto.createHmac("sha256", SECRET).update(`${id}.${status}`).digest("hex");

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

(async () => {
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1", PAYMENTS_WEBHOOK_SECRET: SECRET },
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

  const login = await req("POST", "/api/auth/login", { body: { username: "admin", password: "admin123" } });
  const A = cookieOf(login);
  check("seeded owner signs in", login.status === 200 && !!A, `code=${login.status}`);
  const p = await req("POST", "/api/patients", { cookie: A, body: { fullName: "Pay Probe", phone: "0555000401" } });
  const pid = p.json?.id;
  const mkInv = (total, paid) => req("POST", "/api/invoices", { cookie: A, body: { patientId: pid, subtotal: total, total, paidAmount: paid } });
  const getInv = async (id) => {
    const l = await req("GET", "/api/invoices", { cookie: A });
    const arr = Array.isArray(l.json) ? l.json : (l.json?.invoices || l.json?.items || []);
    return arr.find((x) => x.id === id);
  };

  // ── cash: full + partial + idempotent retry ──
  const inv1 = (await mkInv(200, 0)).json;
  const c1 = await req("POST", "/api/payments", { cookie: A, body: { invoiceId: inv1.id, provider: "cash", amount: 200, idempotencyKey: "k-full-1" } });
  check("cash settles immediately", c1.status === 200 && c1.json?.status === "paid", `code=${c1.status}`);
  const inv1b = await getInv(inv1.id);
  check("invoice recomputed server-side (paid)", inv1b?.dueAmount === 0 && inv1b?.status === "paid", `due=${inv1b?.dueAmount} st=${inv1b?.status}`);

  const inv2 = (await mkInv(300, 0)).json;
  await req("POST", "/api/payments", { cookie: A, body: { invoiceId: inv2.id, provider: "cash", amount: 100, idempotencyKey: "k-part-1" } });
  const inv2b = await getInv(inv2.id);
  check("partial payment tracked", inv2b?.paidAmount === 100 && inv2b?.dueAmount === 200 && inv2b?.status === "partial", `paid=${inv2b?.paidAmount} due=${inv2b?.dueAmount}`);
  const replay = await req("POST", "/api/payments", { cookie: A, body: { invoiceId: inv2.id, provider: "cash", amount: 100, idempotencyKey: "k-part-1" } });
  check("idempotency key replays without double charge", replay.status === 200 && replay.json?.replay === true, `code=${replay.status}`);
  const pays = await req("GET", `/api/payments?invoiceId=${inv2.id}`, { cookie: A });
  check("exactly one payment row for the retried key", (pays.json || []).length === 1, `n=${(pays.json || []).length}`);

  const over = await req("POST", "/api/payments", { cookie: A, body: { invoiceId: inv2.id, provider: "cash", amount: 9999 } });
  check("overpay rejected (400)", over.status === 400, `code=${over.status}`);
  const unk = await req("POST", "/api/payments", { cookie: A, body: { invoiceId: inv2.id, provider: "satim" } });
  check("unknown provider rejected (400)", unk.status === 400, `code=${unk.status}`);

  // ── transfer: pending -> signed webhook -> paid (exactly once) ──
  const t1 = await req("POST", "/api/payments", { cookie: A, body: { invoiceId: inv2.id, provider: "transfer", amount: 200 } });
  check("transfer stays pending", t1.status === 200 && t1.json?.status === "pending", `code=${t1.status}`);
  const tid = t1.json?.id;
  const inv2c = await getInv(inv2.id);
  check("pending changes nothing on the invoice", inv2c?.dueAmount === 200, `due=${inv2c?.dueAmount}`);
  const forged = await req("POST", "/api/payments/webhook", { body: { paymentId: tid, status: "paid", signature: "0".repeat(64) } });
  check("forged webhook refused (401)", forged.status === 401, `code=${forged.status}`);
  const real = await req("POST", "/api/payments/webhook", { body: { paymentId: tid, status: "paid", signature: sign(tid, "paid") } });
  check("signed webhook settles", real.status === 200 && real.json?.status === "paid", `code=${real.status}`);
  const inv2d = await getInv(inv2.id);
  check("webhook applied to the invoice once", inv2d?.dueAmount === 0 && inv2d?.status === "paid", `due=${inv2d?.dueAmount}`);
  const replay2 = await req("POST", "/api/payments/webhook", { body: { paymentId: tid, status: "paid", signature: sign(tid, "paid") } });
  check("webhook replay is a no-op", replay2.status === 200 && replay2.json?.replay === true, `code=${replay2.status}`);
  const inv2e = await getInv(inv2.id);
  check("no double-apply on replay", inv2e?.paidAmount === 300, `paid=${inv2e?.paidAmount}`);

  // ── mock scripted failure ──
  const inv3 = (await mkInv(50, 0)).json;
  const m1 = await req("POST", "/api/payments", { cookie: A, body: { invoiceId: inv3.id, provider: "mock", amount: 10.13 } });
  check("mock fails scripted amounts", m1.status === 200 && m1.json?.status === "failed", `code=${m1.status}`);

  // ── isolation ──
  const reg = await req("POST", "/api/auth/register", { body: { username: "payb", password: "Pay-B-2026!", fullName: "B Owner", clinicName: "Clinic B Pay" } });
  const B = cookieOf(reg);
  const bList = await req("GET", "/api/payments", { cookie: B });
  check("IDOR: clinic B sees no payments", bList.status === 200 && (bList.json || []).length === 0, `n=${(bList.json || []).length}`);
  const bPay = await req("POST", "/api/payments", { cookie: B, body: { invoiceId: inv2.id, provider: "cash", amount: 10 } });
  check("IDOR: clinic B cannot pay A's invoice (403)", bPay.status === 403, `code=${bPay.status}`);

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
