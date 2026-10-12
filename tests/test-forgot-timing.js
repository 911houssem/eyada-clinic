/**
 * Forgot-timing suite — proves POST /api/auth/forgot cannot be used as an
 * account-existence oracle on the clock.
 *
 * The server answers 200 BEFORE doing any account-dependent work (the token
 * mint + notifier send run in the background), so 30 known-account and 30
 * unknown-account requests must have (near-)identical medians. This test
 * FAILS if the median gap exceeds 10ms.
 *
 * Prints "PASS n   FAIL n" so run-suite.js can summarise it.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3194;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-timing-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";
const N = 30;
const LIMIT_MS = 10;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function postForgot(account) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ username: account }));
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/auth/forgot", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length }, timeout: 8000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let json = null; try { json = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, ms });
      });
    });
    r.on("error", (e) => resolve({ status: 0, json: null, ms: -1, err: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, json: null, ms: -1 }); });
    r.write(data); r.end();
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

  if (!(await waitHealthy())) { console.log("server never became healthy:\n" + srvOut); finish(1); return; }

  // warm up JIT + sockets so the measurement sees steady state
  for (let i = 0; i < 3; i++) { await postForgot("houssem"); await postForgot("nobody-here-xyz"); }

  // interleave to cancel out any slow drift of the machine
  const known = [], unknown = [];
  let knownMsg = "", unknownMsg = "", knownStatus = 0, unknownStatus = 0;
  for (let i = 0; i < N; i++) {
    const k = await postForgot("houssem");
    const u = await postForgot("nobody-here-xyz");
    known.push(k.ms); unknown.push(u.ms);
    knownMsg = k.json && k.json.message; unknownMsg = u.json && u.json.message;
    knownStatus = k.status; unknownStatus = u.status;
  }

  check("both branches answer 200", knownStatus === 200 && unknownStatus === 200,
    `known=${knownStatus} unknown=${unknownStatus}`);
  check("bodies are identical", !!knownMsg && knownMsg === unknownMsg);

  const mK = median(known), mU = median(unknown), gap = Math.abs(mK - mU);
  console.log(`  ..   median known=${mK.toFixed(2)}ms unknown=${mU.toFixed(2)}ms gap=${gap.toFixed(2)}ms (n=${N})`);
  check(`median gap <= ${LIMIT_MS}ms (no timing oracle)`, gap <= LIMIT_MS, `gap=${gap.toFixed(2)}ms`);

  // the background work must still have happened: a reset link for the known
  // account has to be emitted shortly after the immediate 200
  await sleep(600);
  check("reset link still emitted in the background", /resetToken=[0-9a-f]{64}/.test(srvOut));

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
