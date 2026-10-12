/**
 * Booking-page XSS suite — fires real payloads at the public booking surface
 * and proves they NEVER execute in a real browser:
 *   - <script>, "><img onerror>, javascript:, </script> breakouts in the
 *     name + note fields, submitted through the LIVE form (not just the API),
 *   - a direct-API booking with the same payloads, then its manage page,
 *   - zero javascript dialogs, zero marker globals, no raw reflection in DOM,
 *   - every <script> in the rendered page carries the CSP nonce.
 *
 * Skips (PASS 0 FAIL 0) when no Chrome binary is present.
 * Prints "PASS n   FAIL n" so run-suite.js can summarise it.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch, newPage, sleep, CHROME } = require("./cdp.js");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3196;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-bxss-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";

const PAY = {
  script: "<script>window.__X1=1</script>",
  img: '"><img src=x onerror="window.__X2=1">',
  jsurl: "javascript:alert(3)",
  breakout: "</script><script>window.__X3=1</script>",
};

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};

function req(method, urlPath, { body } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on("error", (e) => resolve({ status: 0, json: null, text: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, json: null, text: "timeout" }); });
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
  if (!fs.existsSync(CHROME)) {
    console.log(`  ..   no Chrome at ${CHROME} — skipping`);
    console.log(`\n   PASS ${pass}   FAIL ${fail}`);
    process.exit(0);
    return;
  }

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

  const pub = await req("GET", "/api/public/booking/al-noor-clinic");
  const services = pub.json?.services || [];
  check("seeded clinic exposes a menu", services.length > 0, `n=${services.length}`);
  if (!services.length) { finish(1); return; }

  const chrome = await launch({ port: 9334 });
  const page = await newPage(9334);
  await page.send("Page.enable");
  const dialogs = [];
  // collect (but auto-dismiss) any javascript dialog the page dares to open
  const origPush = page.events.push.bind(page.events);
  page.events.push = (m) => { if (m.method === "Page.javascriptDialogOpening") dialogs.push(m.params?.message || "?"); return origPush(m); };
  const dismiss = async () => { try { await page.send("Page.handleJavaScriptDialog", { accept: true }); } catch { /* none open */ } };

  const globalsGone = () => page.eval("[window.__X1, window.__X2, window.__X3].every((v) => v === undefined)");
  const noRawScript = (needle) => page.eval(
    `!new RegExp("<script>" + ${JSON.stringify(needle)}).test(document.documentElement.innerHTML)`
  );

  // ── 1. live form submission with payloads ──
  await page.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/booking/al-noor-clinic` });
  await sleep(2500);
  check("booking page loaded", await page.eval("!!document.querySelector('#f')"));
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  await page.eval(`
    document.querySelector('#date').value = ${JSON.stringify(tomorrow)};
    document.querySelector('#date').dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await sleep(2500); // let the auto slot land
  await page.eval(`
    document.querySelector('#name').value = ${JSON.stringify(PAY.script)};
    document.querySelector('#phone').value = '0511111111';
    document.querySelector('#note').value = ${JSON.stringify(PAY.img)};
    document.querySelector('#consent').checked = true;
    document.querySelector('#f').requestSubmit();
  `);
  let ticket = false;
  for (let i = 0; i < 20 && !ticket; i++) { await sleep(500); await dismiss(); ticket = await page.eval("!!document.querySelector('#ticket')"); }
  check("payload booking submitted", ticket);
  await dismiss();
  check("no <script> payload executed (live form)", await globalsGone());
  check("no javascript dialog opened (live form)", dialogs.length === 0, dialogs.join("|"));
  check("no raw <script> reflection in DOM", await noRawScript("window.__X"));

  // ── 2. second payload set via a fresh booking (one visit per phone/day) ──
  await page.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/booking/al-noor-clinic` });
  await sleep(2500);
  await page.eval(`
    document.querySelector('#date').value = ${JSON.stringify(tomorrow)};
    document.querySelector('#date').dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await sleep(2500);
  await page.eval(`
    document.querySelector('#name').value = ${JSON.stringify(PAY.breakout + " " + PAY.jsurl)};
    document.querySelector('#phone').value = '0522222222';
    document.querySelector('#note').value = ${JSON.stringify(PAY.breakout)};
    document.querySelector('#consent').checked = true;
    document.querySelector('#f').requestSubmit();
  `);
  ticket = false;
  for (let i = 0; i < 20 && !ticket; i++) { await sleep(500); await dismiss(); ticket = await page.eval("!!document.querySelector('#ticket')"); }
  check("breakout booking submitted", ticket);
  await dismiss();
  check("no breakout payload executed", await globalsGone());
  check("no dialog from breakout payload", dialogs.length === 0, dialogs.join("|"));

  // ── 3. manage page for a payload booking made straight through the API ──
  const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const bk = await req("POST", "/api/public/booking/al-noor-clinic", { body: {
    patientName: PAY.script, phone: "0533333333", date: day, serviceId: services[0].id,
    note: PAY.img, consent: true,
  } });
  check("API accepted the payload booking", bk.status === 200, `code=${bk.status}`);
  const manageUrl = bk.json?.appointment?.manageUrl || "";
  if (manageUrl) {
    await page.send("Page.navigate", { url: manageUrl }); // already host:port-correct via PUBLIC_URL/HOST/PORT
    await sleep(2500);
    await dismiss();
    check("no payload executed on the manage page", await globalsGone());
    check("no dialog on the manage page", dialogs.length === 0, dialogs.join("|"));
  } else {
    check("manage URL returned", false, "no manageUrl");
  }

  // ── 4. every script on the page carries the CSP nonce ──
  check("no non-nonces script on the booking page",
    await page.eval("Array.from(document.querySelectorAll('script')).every((s) => s.nonce !== '')"));

  page.close();
  chrome.proc.kill();
  try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* best effort */ }
  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
