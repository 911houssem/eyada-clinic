/**
 * Audit-chain suite — every audit line commits to the previous hash:
 *   --verify-audit exits 0 on an intact log,
 *   exits 1 after an appended forgery OR a one-char edit,
 *   and skips pre-chain legacy lines without failing.
 * Own throwaway server + DATA_DIR. Prints "PASS n   FAIL n".
 */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3207;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-audit-"));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verify = () => spawnSync(process.execPath, ["server.js", "--verify-audit"], {
  cwd: APP_DIR, env: { ...process.env, DATA_DIR: TMP }, encoding: "utf8",
});

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
    r.on("error", (e) => resolve({ status: 0, headers: {}, json: null }));
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
const cookieOf = (r) => (r.headers?.["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const auditFile = () => path.join(TMP, "audit.log");

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
  await req("POST", "/api/patients", { cookie: A, body: { fullName: "Audit Probe", phone: "0555000701" } });
  srv.kill("SIGKILL");
  await sleep(400);

  const lines = fs.readFileSync(auditFile(), "utf8").split("\n").filter((l) => l.trim());
  check("audit log has chained entries", lines.length >= 2 && lines.every((l) => JSON.parse(l).h && JSON.parse(l).prev !== undefined), `n=${lines.length}`);
  const v0 = verify();
  check("--verify-audit passes on intact log (exit 0)", v0.status === 0, `exit=${v0.status} ${(v0.stdout || "").trim().split("\n").slice(-1)}`);

  // ── tamper 1: appended forgery ──
  fs.appendFileSync(auditFile(), JSON.stringify({ ts: new Date().toISOString(), action: "login.success", actorId: "attacker", h: "0".repeat(64), prev: "forged" }) + "\n");
  const v1 = verify();
  check("appended forgery detected (exit 1)", v1.status === 1, `exit=${v1.status}`);

  // ── tamper 2: one-char edit in the middle ──
  const intact = lines.join("\n") + "\n";
  fs.writeFileSync(auditFile(), intact);
  const v2 = verify();
  check("restored log verifies again", v2.status === 0, `exit=${v2.status}`);
  const mid = Math.floor(lines.length / 2);
  const edited = lines.map((l, i) => (i === mid ? l.replace('"action"', '"actiom"') : l)).join("\n") + "\n";
  fs.writeFileSync(auditFile(), edited);
  const v3 = verify();
  check("one-char edit detected (exit 1)", v3.status === 1, `exit=${v3.status}`);

  // ── legacy pre-chain line is skipped, not fatal ──
  fs.writeFileSync(auditFile(), JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", action: "legacy.event" }) + "\n" + intact);
  const v4 = verify();
  check("legacy line skipped, chain still verifies", v4.status === 0, `exit=${v4.status} ${(v4.stdout || "").trim().split("\n").slice(-1)}`);

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
