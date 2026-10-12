/**
 * WhatsApp provider suite — the whatsapp-cloud provider against a local mock
 * Meta server (no internet, no real credentials):
 *   part 1 (in-process): success payload shape, template mapping, phone
 *            sanitising, and 401/429/5xx surfacing — with the access token
 *            asserted ABSENT from every captured log line;
 *   part 2 (throwaway app server): the queue delivers through the provider,
 *            a 500 re-queues with attempts=1 and exponential backoff
 *            (nextAttemptAt ~= +2min), and the server logs never leak the token.
 *
 * Prints "PASS n   FAIL n" so run-suite.js can summarise it.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3198;
const MOCK_PORT = 3199;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-wa-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";
const TOKEN = "SECRET-WA-TOKEN-ABC123";

const wa = require(path.join(APP_DIR, "notifiers", "whatsapp.js"));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── mock Meta server ── */
const hits = [];
let mockMode = "ok"; // ok | 401 | 429 | 500 | flaky
let flakyCount = 0;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let json = null; try { json = JSON.parse(body); } catch { /* raw */ }
    hits.push({ t: Date.now(), url: req.url, auth: req.headers.authorization || "", body: json });
    const err = (code, msg) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: msg, code } })); };
    if (mockMode === "401") return err(401, "Invalid OAuth access token");
    if (mockMode === "429") return err(429, "(#80007) rate limit hit");
    if (mockMode === "500") return err(500, "internal error, try again");
    if (mockMode === "flaky") { flakyCount++; if (flakyCount <= 2) return err(500, "boom"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages: [{ id: "wamid.MOCK123" }] }));
  });
});

const cfg = (over = {}) => ({
  phoneNumberId: "1234567890", accessToken: TOKEN, apiBase: `http://127.0.0.1:${MOCK_PORT}`, ...over,
});

/* capture everything the provider/notifier prints */
const logged = [];
const origLog = console.log, origErr = console.error;
console.log = (...a) => { logged.push(a.map(String).join(" ")); origLog(...a); };
console.error = (...a) => { logged.push(a.map(String).join(" ")); origErr(...a); };

function req(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    if (cookie) h["Cookie"] = cookie;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json: j }); });
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, json: null, err: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, json: null }); });
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

(async () => {
  await new Promise((res) => mock.listen(MOCK_PORT, "127.0.0.1", res));

  /* ── part 1: provider straight against the mock ── */
  mockMode = "ok"; hits.length = 0;
  const r1 = await wa.send({ to: "+1 (555) 123-4567", templateKey: "booking_confirmation",
    vars: { clinic: "عيادة النور", date: "غداً" },
    config: cfg({ templates: { booking_confirmation: { name: "book_confirm", language: "ar" } } }) });
  check("provider: 200 delivers + returns the message id", r1.ok === true && r1.id === "wamid.MOCK123", JSON.stringify(r1.id));
  const h1 = hits[0];
  check("provider: Bearer auth header", h1 && h1.auth === `Bearer ${TOKEN}`);
  check("provider: template name mapped", h1?.body?.template?.name === "book_confirm", h1?.body?.template?.name);
  check("provider: recipient phone sanitised", h1?.body?.to === "+15551234567", h1?.body?.to);
  check("provider: template type enforced", h1?.body?.type === "template" && h1?.body?.messaging_product === "whatsapp");

  for (const [mode, code] of [["401", 401], ["429", 429], ["500", 500]]) {
    mockMode = mode; hits.length = 0;
    let err = "";
    try { await wa.send({ to: "0555123456", templateKey: "reminder_24h", vars: {}, config: cfg() }); }
    catch (e) { err = e.message; }
    check(`provider: HTTP ${code} surfaces as an error`, err.includes(`HTTP ${code}`), err.slice(0, 80));
    check(`provider: HTTP ${code} message carries no token`, !err.includes(TOKEN));
  }
  check("provider: token never printed to logs", !logged.some((l) => l.includes(TOKEN)), `${logged.length} lines captured`);

  /* ── part 2: queue integration on a throwaway app server ── */
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1", ENCRYPTION_KEY: ENC_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let srvOut = "";
  srv.stdout.on("data", (d) => (srvOut += d));
  srv.stderr.on("data", (d) => (srvOut += d));
  const finish = (code) => {
    console.log = origLog; console.error = origErr;
    try { srv.kill("SIGKILL"); } catch { /* gone */ }
    mock.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\n   PASS ${pass}   FAIL ${fail}`);
    process.exit(code);
  };
  if (!(await waitHealthy())) { console.log("server never became healthy:\n" + srvOut); finish(1); return; }

  const login = await req("POST", "/api/auth/login", { body: { username: "admin", password: "admin123" } });
  const ac = (login.headers?.["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  check("seeded owner signs in", login.status === 200 && !!ac, `code=${login.status}`);

  const put = await req("PUT", "/api/notifications", { cookie: ac, body: {
    channel: "whatsapp-cloud", enabled: true,
    whatsappPhoneNumberId: "1234567890", whatsappToken: TOKEN, whatsappApiBase: `http://127.0.0.1:${MOCK_PORT}`,
  } });
  check("clinic pointed at the mock provider", put.status === 200, `code=${put.status}`);
  check("config echoes no secret", put.json?.config && !("whatsappToken" in put.json.config) && put.json.config.whatsappTokenSet === true);

  mockMode = "ok"; hits.length = 0;
  const t1 = await req("POST", "/api/notifications/test", { cookie: ac, body: { to: "0555000001" } });
  check("queue: test message delivered via mock (sent=1)", t1.status === 200 && t1.json?.sent === 1, `code=${t1.status} sent=${t1.json?.sent}`);
  check("queue: mock saw the Bearer token exactly once", hits.length === 1 && hits[0].auth === `Bearer ${TOKEN}`, `hits=${hits.length}`);
  const q1 = await req("GET", "/api/notifications", { cookie: ac });
  const log1 = q1.json?.log || q1.json?.notificationLog || [];
  check("queue: log entry is masked", log1.length > 0 && !JSON.stringify(log1).includes(TOKEN) && !JSON.stringify(log1).includes("0555000001"));

  mockMode = "500"; hits.length = 0;
  const t2 = await req("POST", "/api/notifications/test", { cookie: ac, body: { to: "0555000002" } });
  check("queue: failed send reports sent=0", t2.status === 200 && t2.json?.sent === 0, `sent=${t2.json?.sent}`);
  const q2 = await req("GET", "/api/notifications", { cookie: ac });
  const jobs = q2.json?.queue || q2.json?.notificationQueue || [];
  const failed = jobs.filter((j) => j.status === "pending" && j.attempts >= 1);
  check("queue: 500 re-queues with attempts=1 (not dropped)", failed.length >= 1, `pending-retry=${failed.length}`);
  const gap = failed.length ? (Date.parse(failed[0].nextAttemptAt) - Date.now()) / 1000 : -1;
  check("queue: exponential backoff scheduled (~+2min)", gap > 60 && gap < 180, `in ${gap.toFixed(0)}s`);

  await sleep(300);
  check("server logs never leak the token", !srvOut.includes(TOKEN), `${srvOut.length} chars scanned`);

  finish(fail ? 1 : 0);
})().catch((e) => { console.log = origLog; console.error = origErr; console.error(e); process.exit(1); });
