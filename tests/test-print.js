/**
 * Print suite — RTL HTML templates for invoice / prescription / visit:
 * clinic letterhead, escaped values, @page CSS, clinic isolation.
 * Own throwaway server. Prints "PASS n   FAIL n".
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3206;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-print-"));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    if (cookie) h["Cookie"] = cookie;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, text: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, text: "timeout" }); });
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
  check("seeded owner signs in", login.status === 200 && !!A, `code=${login.status}`);
  const p = await req("POST", "/api/patients", { cookie: A, body: { fullName: "Print <b>Probe</b>", phone: "0555000601" } });
  check("probe patient created", p.status === 200, `code=${p.status}`);
  const me = await req("GET", "/api/patients", { cookie: A });
  const mjson = JSON.parse(me.text);
  const arr = Array.isArray(mjson) ? mjson : (mjson.patients || mjson.items || []);
  const pat = arr.find((x) => (x.phone || "").includes("0555000601"));
  check("probe patient found", !!pat);
  const patId = pat?.id;

  const inv = await req("POST", "/api/invoices", { cookie: A, body: { patientId: patId, subtotal: 150, total: 150, paidAmount: 50, items: [{ name: "كشفية", price: 150 }] } });
  const invId = JSON.parse(inv.text).id;
  const rx = await req("POST", "/api/prescriptions", { cookie: A, body: { patientId: patId, items: [{ name: "Medication", dose: "x", duration: "y", instructions: "z" }] } });
  const rxId = JSON.parse(rx.text).id;
  const ap = await req("POST", "/api/appointments", { cookie: A, body: { patientId: patId, title: "كشف", startTime: new Date(Date.now() + 864e5).toISOString() } });
  const apId = JSON.parse(ap.text).id;

  const pi = await req("GET", `/api/print/invoice/${invId}`, { cookie: A });
  check("invoice print 200 HTML", pi.status === 200 && (pi.headers["content-type"] || "").includes("text/html"), `code=${pi.status}`);
  check("invoice print RTL + letterhead + totals", pi.text.includes('dir="rtl"') && pi.text.includes("150") && pi.text.includes("@page"));
  const pr = await req("GET", `/api/print/prescription/${rxId}`, { cookie: A });
  check("prescription print has the drug", pr.status === 200 && pr.text.includes("Medication"), `code=${pr.status}`);
  const pv = await req("GET", `/api/print/visit/${apId}`, { cookie: A });
  check("visit print renders", pv.status === 200 && pv.text.includes("تقرير زيارة"), `code=${pv.status}`);
  check("patient name escaped in print (no raw <b>)", !pi.text.includes("Print <b>Probe</b>") && pi.text.includes("Print &lt;b&gt;Probe&lt;/b&gt;"));

  const anon = await req("GET", `/api/print/invoice/${invId}`);
  check("print needs a session (401)", anon.status === 401, `code=${anon.status}`);
  const reg = await req("POST", "/api/auth/register", { body: { username: "printb", password: "Print-B-2026!", fullName: "B Owner", clinicName: "Clinic B Print" } });
  const B = cookieOf(reg);
  const bPrint = await req("GET", `/api/print/invoice/${invId}`, { cookie: B });
  check("IDOR: clinic B cannot print A's invoice (403)", bPrint.status === 403, `code=${bPrint.status}`);

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
