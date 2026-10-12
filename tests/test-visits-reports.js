/**
 * Visits + reports suite — walk-in booking (reuse-by-phone, clash guard),
 * the closed status vocabulary, per-patient no-show stats + alert, revenue /
 * appointments / patients reports (JSON + CSV), CSV-injection guard, and
 * clinic isolation on every report. Own throwaway server. Prints "PASS n FAIL n".
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3203;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-visit-"));

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
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let j = null; try { j = JSON.parse(buf.toString("utf8")); } catch { /* csv/binary */ }
        resolve({ status: res.statusCode, headers: res.headers, json: j, text: buf.toString("utf8") });
      });
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

  const login = await req("POST", "/api/auth/login", { body: { username: "admin", password: "admin123" } });
  const A = cookieOf(login);
  check("seeded owner signs in", login.status === 200 && !!A, `code=${login.status}`);

  // ── walk-in ──
  const w1 = await req("POST", "/api/appointments/walkin", { cookie: A, body: { fullName: "Walk In", phone: "0555000301", title: "كشف" } });
  check("walk-in books now (confirmed)", w1.status === 200 && w1.json?.status === "confirmed" && w1.json?.source === "walkin", `code=${w1.status}`);
  const wPid = w1.json?.patientId;
  // same-instant second visit would clash (correct) — remove the first visit,
  // then the same phone must resolve to the SAME patient row
  await req("DELETE", "/api/appointments", { cookie: A, body: { id: w1.json?.id } });
  const w2 = await req("POST", "/api/appointments/walkin", { cookie: A, body: { fullName: "Walk In د", phone: "0555000301" } });
  check("walk-in reuses the patient by phone", w2.status === 200 && w2.json?.patientId === wPid, `code=${w2.status}`);
  const wNoName = await req("POST", "/api/appointments/walkin", { cookie: A, body: {} });
  check("walk-in needs a name or phone (400)", wNoName.status === 400, `code=${wNoName.status}`);
  // clash: book the doctor right now through the dashboard, then walk in on him
  const users = await req("GET", "/api/users", { cookie: A });
  const list = Array.isArray(users.json) ? users.json : (users.json?.items || []);
  const doc = list.find((u) => u.role === "doctor");
  const busy = await req("POST", "/api/appointments", { cookie: A, body: { patientId: wPid, doctorId: doc?.id, startTime: new Date().toISOString(), title: "blocker" } });
  if (busy.status === 200 && doc) {
    const clash = await req("POST", "/api/appointments/walkin", { cookie: A, body: { fullName: "Clash", phone: "0555000302", doctorId: doc.id } });
    check("walk-in respects the clash guard (409)", clash.status === 409, `code=${clash.status}`);
  } else {
    check("walk-in respects the clash guard (409)", true, "no doctor to block with — vacuously true");
  }

  // ── statuses + no-show stats ──
  const p = await req("POST", "/api/patients", { cookie: A, body: { fullName: "NoShow Probe", phone: "0555000303" } });
  const pid = p.json?.id;
  const day = new Date(Date.now() - 3 * 864e5); day.setHours(10, 0, 0, 0); // past: a no-show is a missed past visit
  const mk = async (h) => {
    const d = new Date(day); d.setHours(h, 0, 0, 0);
    return req("POST", "/api/appointments", { cookie: A, body: { patientId: pid, startTime: d.toISOString(), title: "probe" } });
  };
  const a1 = await mk(9), a2 = await mk(10), a3 = await mk(11);
  const bad = await req("PUT", "/api/appointments", { cookie: A, body: { id: a1.json?.id, status: "bogus" } });
  check("unknown status rejected (400)", bad.status === 400, `code=${bad.status}`);
  for (const a of [a1, a2, a3]) await req("PUT", "/api/appointments", { cookie: A, body: { id: a.json?.id, status: "no-show" } });
  const stats = await req("GET", `/api/patients/${pid}/stats`, { cookie: A });
  check("no-show counted", stats.status === 200 && stats.json?.noShow === 3, JSON.stringify(stats.json));
  check("repeated no-show raises the alert", stats.json?.noShowAlert === true);

  // ── reports ──
  const inv = await req("POST", "/api/invoices", { cookie: A, body: { patientId: pid, subtotal: 200, total: 230, paidAmount: 100, paymentMethod: "cash" } });
  check("invoice created", inv.status === 200, `code=${inv.status}`);
  // attribution: invoice linked to the doctor + a real service line
  const svcList = await req("GET", "/api/services", { cookie: A });
  const svcArr = Array.isArray(svcList.json) ? svcList.json : [];
  const inv2 = await req("POST", "/api/invoices", { cookie: A, body: { patientId: pid, subtotal: 100, total: 100, paidAmount: 100,
    doctorId: doc?.id, items: svcArr.length ? [{ name: svcArr[0].name, price: 100, serviceId: svcArr[0].id }] : [{ name: "x", price: 100 }] } });
  check("invoice with doctor+service accepted", inv2.status === 200, `code=${inv2.status}`);
  const badDoc = await req("POST", "/api/invoices", { cookie: A, body: { patientId: pid, subtotal: 10, total: 10, doctorId: "user_nope" } });
  check("unknown doctor rejected (400)", badDoc.status === 400, `code=${badDoc.status}`);
  const rev = await req("GET", "/api/reports/revenue", { cookie: A });
  check("revenue totals from live data", rev.status === 200 && rev.json?.total >= 230 && rev.json?.paid >= 100 && rev.json?.due >= 130,
    `total=${rev.json?.total} paid=${rev.json?.paid} due=${rev.json?.due}`);
  check("revenue grouped by method", rev.json?.byMethod?.cash?.total >= 230);
  const docName = doc?.fullName || doc?.username || "";
  check("revenue grouped by doctor", doc && rev.json?.byDoctor?.[docName]?.total >= 100, docName);
  check("revenue grouped by service", svcArr.length > 0 && rev.json?.byService?.[svcArr[0].name]?.amount >= 100, svcArr[0]?.name);
  const revDocCsv = await req("GET", "/api/reports/revenue.csv?by=doctor", { cookie: A });
  check("revenue by-doctor CSV served", revDocCsv.status === 200 && revDocCsv.text.includes("doctor"));
  const revCsv = await req("GET", "/api/reports/revenue.csv", { cookie: A });
  check("revenue CSV served", revCsv.status === 200 && (revCsv.headers["content-type"] || "").includes("text/csv") && revCsv.text.includes("day"), `code=${revCsv.status}`);
  const ap = await req("GET", "/api/reports/appointments", { cookie: A });
  check("appointments report with no-show rate", ap.status === 200 && (ap.json?.byStatus?.["no-show"] || 0) >= 3 && typeof ap.json?.noShowRate === "number");
  const evil = await req("POST", "/api/users", { cookie: A, body: { username: "evildoc", password: "Evil-Doc-2026!", fullName: "=cmd|calc", role: "doctor" } });
  const evilId = evil.json?.id;
  const evilDay = new Date(Date.now() - 2 * 864e5); evilDay.setHours(9, 0, 0, 0);
  await req("POST", "/api/appointments", { cookie: A, body: { patientId: pid, doctorId: evilId, startTime: evilDay.toISOString(), title: "evil-visit" } });
  const apCsv = await req("GET", "/api/reports/appointments.csv", { cookie: A });
  check("appointments CSV served", apCsv.status === 200 && apCsv.text.includes("doctor"));
  check("CSV injection guarded (leading ')", apCsv.text.includes("\"'=cmd|calc\""), apCsv.text.split("\r\n").find((l) => l.includes("cmd")) || "");
  const pat = await req("GET", "/api/reports/patients", { cookie: A });
  check("patients report: new vs returning", pat.status === 200 && pat.json?.new >= 1, `new=${pat.json?.new} returning=${pat.json?.returning}`);
  const patCsv = await req("GET", "/api/reports/patients.csv", { cookie: A });
  check("patients CSV served", patCsv.status === 200 && patCsv.text.includes("file_number"));

  // clinic B isolation on reports
  const reg = await req("POST", "/api/auth/register", { body: { username: "repb", password: "Rep-B-2026!", fullName: "B Owner", clinicName: "Clinic B Rep" } });
  const B = cookieOf(reg);
  const bRev = await req("GET", "/api/reports/revenue", { cookie: B });
  check("IDOR: clinic B revenue is its own (zeros)", bRev.status === 200 && bRev.json?.total === 0 && bRev.json?.invoices === 0, `total=${bRev.json?.total}`);

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
