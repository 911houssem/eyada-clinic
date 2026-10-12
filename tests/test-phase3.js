/**
 * Phase 3 suite — notification engine, booking confirmation, manage token.
 *
 * Runs against a throwaway server (temp DATA_DIR, own port, dev mode) and uses a
 * real local HTTP receiver as the "webhook" notification provider, so delivery,
 * HMAC signing, dedupe, cancel/reschedule and secret-hiding are all exercised
 * end to end — no external network, no third-party dependency.
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
const PORT = 3189;
const HOOK_PORT = 3190;
const SLUG = "al-noor-clinic";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-p3-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";
const SECRET = "hook-shared-secret-2026";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

/* ── dummy provider: local, HMAC-verifying webhook receiver ── */
const received = [];
const hookServer = http.createServer((rq, rs) => {
  let buf = "";
  rq.on("data", (c) => (buf += c));
  rq.on("end", () => {
    const sig = String(rq.headers["x-eyada-signature"] || "");
    const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(buf).digest("hex");
    let json = null; try { json = JSON.parse(buf); } catch { /* ignore */ }
    received.push({ sig, valid: !!sig && sig === expected, json });
    rs.writeHead(200, { "Content-Type": "application/json" }); rs.end('{"ok":true}');
  });
});

function portFree(port) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: "/api/health", method: "GET", timeout: 800 },
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

const ofTemplate = (key) => received.filter((x) => x.json && x.json.templateKey === key);

(async () => {
  if (!(await portFree(PORT)) || !(await portFree(HOOK_PORT))) {
    console.log(`FAIL test-phase3.js — port ${PORT} or ${HOOK_PORT} busy`);
    process.exit(1);
  }
  await new Promise((res) => hookServer.listen(HOOK_PORT, "127.0.0.1", res));

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
    try { hookServer.close(); } catch { /* gone */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\n   PASS ${pass}   FAIL ${fail}`);
    process.exit(code);
  };

  if (!(await waitHealthy())) {
    console.log("server never became healthy:\n" + srvOut);
    finish(1);
    return;
  }

  /* ── login ── */
  const owner = await req("POST", "/api/auth/login", { body: { username: "houssem", password: "houssem123" } });
  const staff = await req("POST", "/api/auth/login", { body: { username: "reception", password: "reception123" } });
  const A = owner.token, R = staff.token;
  check("owner + receptionist can sign in", owner.status === 200 && !!A && staff.status === 200 && !!R);

  /* ═════════════ 1. CONFIG + SECRET HIDING ═════════════ */
  const badChannel = await req("PUT", "/api/notifications", { token: A, body: { channel: "carrier-pigeon" } });
  check("unknown channel rejected (400)", badChannel.status === 400, `got ${badChannel.status}`);

  const notOwner = await req("GET", "/api/notifications", { token: R });
  check("receptionist cannot read notification config (403)", notOwner.status === 403, `got ${notOwner.status}`);

  const put = await req("PUT", "/api/notifications", {
    token: A,
    body: {
      enabled: true, channel: "webhook", timezone: "Asia/Riyadh",
      webhookUrl: `http://127.0.0.1:${HOOK_PORT}/hook`, webhookSecret: SECRET,
      quietHours: { start: 0, end: 0 },
    },
  });
  check("owner configures the webhook provider", put.status === 200 && put.json.config.enabled === true);

  const got = await req("GET", "/api/notifications", { token: A });
  const cfg = got.json.config || {};
  check("config never returns the raw secret", cfg.webhookSecret === undefined);
  check("config reports the secret is set", cfg.webhookSecretSet === true);
  check("config keeps non-secret fields", cfg.channel === "webhook" && cfg.webhookUrl.includes("/hook"));

  const badProvider = await req("PUT", "/api/notifications", { token: A, body: { channel: "whatsapp-cloud" } });
  check("whatsapp channel without credentials rejected (400)", badProvider.status === 400, `got ${badProvider.status}`);
  const afterBad = await req("GET", "/api/notifications", { token: A });
  check("a rejected update leaves the live config untouched", afterBad.json.config.channel === "webhook");

  /* ═════════════ 2. BOOKING + CONFIRMATION ═════════════ */
  const pub = await req("GET", `/api/public/booking/${SLUG}`);
  const services = (pub.json && pub.json.services) || [];
  const serviceId = services[0] ? services[0].id : "";

  let booked = null, bookedDate = "";
  for (let i = 6; i < 50 && !booked; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const s = ymd(d);
    const r = await req("POST", `/api/public/booking/${SLUG}`, {
      body: { patientName: "مريض الاختبار", phone: "0555111222", date: s, serviceId, consent: true },
    });
    if (r.status === 200) { booked = r; bookedDate = s; }
    else if (r.status !== 409) break;
  }
  check("public booking succeeds", !!booked, booked ? `date=${bookedDate}` : "no free slot");
  if (!booked) { finish(1); return; }

  const token = booked.json.appointment.manageToken;
  check("booking returns a 64-hex manage token", /^[0-9a-f]{64}$/.test(String(token)));
  check("booking returns a manageable link", String(booked.json.appointment.manageUrl || "").includes(String(token)));

  const appts = await req("GET", "/api/appointments", { token: A });
  const mine = (Array.isArray(appts.json) ? appts.json : []).find((a) => a.id === booked.json.appointment.id);
  check("consent timestamp is persisted on the appointment", !!mine && !!mine.consentAt);
  check("manage token is stored only as a hash", !!mine && mine.manageTokenHash !== token && typeof mine.manageTokenHash === "string");

  // flush the queue synchronously through the test endpoint (also delivers its own job)
  await req("POST", "/api/notifications/test", { token: A, body: { to: "0555999888" } });
  await sleep(400);
  const conf = ofTemplate("booking_confirmation");
  check("confirmation delivered to the webhook", conf.length === 1, `got ${conf.length}`);
  check("webhook payload carries the recipient + rendered message",
    conf.length === 1 && conf[0].json.to === "0555111222" && /تم تأكيد حجزك/.test(String(conf[0].json.vars && conf[0].json.vars.message)));
  check("webhook signature verifies (HMAC-SHA256)", conf.length === 1 && conf[0].valid === true);
  check("test job delivered too", ofTemplate("test").length === 1, `got ${ofTemplate("test").length}`);

  // second flush must not re-send
  await req("POST", "/api/notifications/test", { token: A, body: { to: "0555999888" } });
  await sleep(300);
  check("no duplicate confirmation after a second sweep", ofTemplate("booking_confirmation").length === 1,
    `got ${ofTemplate("booking_confirmation").length}`);

  const queueView = await req("GET", "/api/notifications", { token: A });
  check("queue listing is masked + exposes no secrets",
    queueView.status === 200 && queueView.json.queue.every((j) => !/^\d{10}$/.test(String(j.to)))
    && !JSON.stringify(queueView.json).includes(SECRET));

  /* ═════════════ 3. MANAGE: READ / RESCHEDULE / CANCEL ═════════════ */
  const badTok = await req("GET", `/api/public/booking/${SLUG}/appointment?token=${"0".repeat(64)}`);
  check("unknown manage token rejected (404)", badTok.status === 404, `got ${badTok.status}`);

  const read = await req("GET", `/api/public/booking/${SLUG}/appointment?token=${token}`);
  check("valid token reads the appointment", read.status === 200 && read.json.appointment.date && read.json.canCancel === true);

  let moved = null;
  for (let i = 1; i < 30 && !moved; i++) {
    const d = new Date(); d.setDate(d.getDate() + 10 + i);
    const s = ymd(d);
    if (s === bookedDate) continue;
    const r = await req("POST", `/api/public/booking/${SLUG}/reschedule`, { body: { token, date: s } });
    if (r.status === 200) moved = r;
    else if (r.status !== 409) break;
  }
  check("patient can reschedule with a valid token", !!moved && moved.status === 200);

  const cancelled = await req("POST", `/api/public/booking/${SLUG}/cancel`, { body: { token } });
  check("patient can cancel with a valid token", cancelled.status === 200);

  const recancel = await req("POST", `/api/public/booking/${SLUG}/cancel`, { body: { token } });
  check("cancelling twice is refused (400)", recancel.status === 400, `got ${recancel.status}`);

  const reschedAfterCancel = await req("POST", `/api/public/booking/${SLUG}/reschedule`, { body: { token, date: bookedDate } });
  check("rescheduling a cancelled appointment is refused (400)", reschedAfterCancel.status === 400, `got ${reschedAfterCancel.status}`);

  await req("POST", "/api/notifications/test", { token: A, body: { to: "0555999888" } });
  await sleep(300);
  check("cancellation notification delivered", ofTemplate("appointment_cancelled").length >= 1,
    `got ${ofTemplate("appointment_cancelled").length}`);

  finish(fail ? 1 : 0);
})();
