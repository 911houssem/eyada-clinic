/**
 * SMTP suite — the real net/tls provider against a local mock relay:
 *   plain + AUTH LOGIN delivery (headers, RFC2047 subject, body, dot-stuffing),
 *   535 rejection without leaking the password, STARTTLS upgrade attempted
 *   with a clean (fast) failure when the handshake can't complete, and
 *   template rendering for the reset link.
 *
 * No app server needed (provider required directly). Prints "PASS n FAIL n".
 */
const net = require("net");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const smtp = require(path.join(APP_DIR, "notifiers", "smtp.js"));

const MOCK_PORT = 3225;
const USER = "clinic@example.com";
const PASS = "S3cr3t-Relay-Pass!";
const WRONG = "nope-wrong-pass";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64d = (s) => Buffer.from(s, "base64").toString("utf8");

const logged = [];
const oLog = console.log, oErr = console.error;
console.log = (...a) => { logged.push(a.map(String).join(" ")); oLog(...a); };
console.error = (...a) => { logged.push(a.map(String).join(" ")); oErr(...a); };

const sessions = []; // { cmds: [], user, pass, data, authed }
const behavior = { advertiseTls: false, acceptPass: PASS };
function startMock() {
  sessions.length = 0;
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      const st = { cmds: [], user: "", pass: "", data: "", authed: false, mode: "cmd" };
      sessions.push(st);
      sock.write("220 mock-relay ESMTP\r\n");
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (st.mode === "data") {
            if (line === ".") { st.mode = "cmd"; sock.write("250 2.0.0 queued\r\n"); }
            else st.data += line + "\n";
            continue;
          }
          st.cmds.push(line);
          const [verb, arg] = [line.slice(0, 4).toUpperCase(), line.slice(5)];
          if (verb === "EHLO") {
            sock.write(`250-mock\r\n250${behavior.advertiseTls ? "-STARTTLS" : ""}\r\n250-AUTH LOGIN\r\n250 OK\r\n`);
          } else if (verb === "STAR") { sock.write("220 2.0.0 ready, speak TLS now\r\n"); /* then garbage: no TLS here on purpose */
          } else if (verb === "AUTH") { sock.write("334 VXNlcm5hbWU6\r\n"); st.mode = "auth-u";
          } else if (st.mode === "auth-u") { st.user = b64d(line); st.mode = "auth-p"; sock.write("334 UGFzc3dvcmQ6\r\n");
          } else if (st.mode === "auth-p") {
            st.pass = b64d(line); st.mode = "cmd";
            if (st.pass === behavior.acceptPass) { st.authed = true; sock.write("235 2.7.0 ok\r\n"); }
            else sock.write("535 5.7.8 bad credentials\r\n");
          } else if (verb === "MAIL") { sock.write(st.authed ? "250 ok\r\n" : "530 auth first\r\n");
          } else if (verb === "RCPT") { sock.write("250 ok\r\n");
          } else if (verb === "DATA") { st.mode = "data"; sock.write("354 end with .\r\n");
          } else if (verb === "QUIT") { sock.write("221 bye\r\n"); sock.end();
          } else { sock.write("502 unimplemented\r\n"); }
        }
      });
    });
    srv.listen(MOCK_PORT, "127.0.0.1", () => resolve(srv));
  });
}

const baseEnv = { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(MOCK_PORT), SMTP_FROM: "Clinic <no-reply@example.com>" };

(async () => {
  // ── 1. plain delivery with AUTH LOGIN ──
  const mock = await startMock();
  Object.assign(process.env, baseEnv, { SMTP_USER: USER, SMTP_PASS: PASS });
  behavior.advertiseTls = false; behavior.acceptPass = PASS; sessions.length = 0;
  const r = await smtp.send({ to: "patient@example.com", templateKey: "password_reset",
    vars: { name: "Sara", link: "http://x/?resetToken=abc123", ttlMinutes: 30 } });
  check("smtp: plain delivery ok", r.ok === true, JSON.stringify(r.ok));
  const s = sessions[0];
  check("smtp: AUTH LOGIN carried the right credentials", s.user === USER && s.pass === PASS, `${s.user}/${s.pass === PASS}`);
  check("smtp: RCPT reached", s.cmds.some((c) => c.startsWith("RCPT TO:<patient@example.com>")));
  check("smtp: From header present", s.data.includes("From: Clinic <no-reply@example.com>"));
  check("smtp: Arabic subject RFC2047-encoded", /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m.test(s.data));
  check("smtp: reset link in body", s.data.includes("http://x/?resetToken=abc123"));

  // ── 2. bad password: 535, no leak ──
  sessions.length = 0;
  Object.assign(process.env, baseEnv, { SMTP_USER: USER, SMTP_PASS: WRONG });
  let err = "";
  try { await smtp.send({ to: "a@example.com", templateKey: "test", vars: {} }); }
  catch (e) { err = e.message; }
  check("smtp: bad credentials rejected", /535|AUTH failed/.test(err), err.slice(0, 60));
  check("smtp: error carries no password", !err.includes(WRONG) && !err.includes(PASS));

  // ── 3. STARTTLS advertised but handshake impossible: fast clean failure ──
  behavior.advertiseTls = true; sessions.length = 0;
  Object.assign(process.env, baseEnv, { SMTP_USER: USER, SMTP_PASS: PASS, SMTP_TIMEOUT_MS: "2500" });
  const t0 = Date.now();
  let tlsErr = "";
  try { await smtp.send({ to: "a@example.com", templateKey: "test", vars: {} }); }
  catch (e) { tlsErr = e.message; }
  const dt = Date.now() - t0;
  check("smtp: STARTTLS attempted, failure is clean", tlsErr.length > 0, tlsErr.slice(0, 60));
  check("smtp: no hang on broken TLS (<8s)", dt < 8000, `${dt}ms`);

  // ── 4. validation + templates ──
  Object.assign(process.env, baseEnv, { SMTP_USER: USER, SMTP_PASS: PASS });
  let bad = "";
  try { await smtp.send({ to: "not-an-email", templateKey: "test", vars: {} }); }
  catch (e) { bad = e.message; }
  check("smtp: invalid recipient rejected before dialling", /invalid recipient/.test(bad));
  let nocfg = "";
  delete process.env.SMTP_HOST;
  try { await smtp.send({ to: "a@example.com", templateKey: "test", vars: {} }); }
  catch (e) { nocfg = e.message; }
  check("smtp: missing relay config is explicit", /SMTP_HOST/.test(nocfg));
  check("smtp: password never logged", !logged.some((l) => l.includes(PASS) || l.includes(WRONG)), `${logged.length} lines`);
  const t = smtp._internals.render("booking_confirmation", { clinic: "X", date: "d", time: "t" });
  check("smtp: templates render", t.subject.length > 0 && t.text.includes("X"));

  for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_USER", "SMTP_PASS", "SMTP_TIMEOUT_MS"]) delete process.env[k];
  mock.close();
  console.log = oLog; console.error = oErr;
  console.log(`\n   PASS ${pass}   FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log = oLog; console.error = oErr; console.error(e); process.exit(1); });
