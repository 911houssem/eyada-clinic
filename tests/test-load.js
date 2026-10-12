/**
 * Load suite — proves the JSON store holds a LARGE dataset and survives
 * pressure WITHOUT migrating storage:
 *   - boots a database with 10k patients / 20k appointments / 5k invoices,
 *   - measures boot + search + booking latency on that volume (printed),
 *   - fires 50 CONCURRENT same-slot bookings: exactly one may win (no
 *     double-book, no crash, no 5xx) — the single-threaded guard must hold,
 *   - fires 200 sequential creates: zero lost writes (serialized flush),
 *   - asserts a boot backup of the big file exists.
 *
 * Only correctness is asserted (counts/codes); timings are printed for humans
 * because CI machines vary. Own throwaway server. Prints "PASS n   FAIL n".
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3213;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-load-"));

const N_PAT = 10000, N_APT = 20000, N_INV = 5000;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mirrors server hashPassword (scrypt, salt:hash) for the seeded owner
const pwHash = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(String(pw), salt, 64).toString("hex")}`;
};
const phoneIdx = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d ? crypto.createHash("sha256").update(d).digest("hex") : "";
};

function seedBig() {
  const clinicId = "clinic_loadtest";
  const adminId = "user_loadadmin";
  const docId = "user_loaddoc";
  const t0 = Date.now();
  const patients = new Array(N_PAT);
  for (let i = 0; i < N_PAT; i++) {
    const phone = `05${String(10000000 + i)}`;
    patients[i] = {
      id: `pat_load${i}`, clinicId, fileNumber: `P-${String(i + 1).padStart(4, "0")}`,
      fullName: `مريض ضغط ${i}`, phone, phoneIdx: phoneIdx(phone),
      email: "", gender: i % 2 ? "male" : "female", age: 30 + (i % 50),
      bloodType: "O+", allergies: "", insuranceNumber: "", insuranceCompany: "",
      notes: "", createdAt: new Date(t0 - i * 1000).toISOString(),
    };
  }
  const base = new Date(t0 + 30 * 864e5); base.setHours(0, 0, 0, 0);
  const appointments = new Array(N_APT);
  for (let i = 0; i < N_APT; i++) {
    const d = new Date(base.getTime() + (i % 60) * 864e5);
    d.setHours(8 + (i % 14), (i % 3) * 20, 0, 0);
    const e = new Date(d.getTime() + 20 * 60000);
    appointments[i] = {
      id: `apt_load${i}`, clinicId, patientId: `pat_load${i % N_PAT}`, doctorId: docId,
      title: "كشف", type: "consultation", serviceId: "",
      startTime: d.toISOString(), endTime: e.toISOString(),
      status: "scheduled", notes: "", source: "seed", createdAt: new Date(t0 - i * 500).toISOString(),
    };
  }
  const invoices = new Array(N_INV);
  for (let i = 0; i < N_INV; i++) {
    invoices[i] = {
      id: `inv_load${i}`, clinicId, patientId: `pat_load${i % N_PAT}`,
      subtotal: 100, insuranceDiscount: 0, taxPercentage: 15, taxAmount: 15, total: 115,
      paidAmount: 115, dueAmount: 0, status: "paid", paymentMethod: "cash",
      items: [], createdAt: new Date(t0 - i * 700).toISOString(),
    };
  }
  const db = {
    users: [
      { id: adminId, username: "loadadmin", password: pwHash("Load-Admin-2026!"), fullName: "Load Admin", phone: "", email: "", role: "super_admin", clinicId, twoFactorEnabled: false, trustedDevices: [], createdAt: new Date(t0).toISOString() },
      { id: docId, username: "loaddoc", password: pwHash("x"), fullName: "Load Doc", phone: "", email: "", role: "doctor", clinicId, twoFactorEnabled: false, trustedDevices: [], createdAt: new Date(t0).toISOString() },
    ],
    clinics: [{ id: clinicId, name: "عيادة الضغط", phone: "0500000000", address: "", currency: "SAR", paymentMode: "postpaid", ownerId: adminId, bookingSlug: "load-clinic", bookingEnabled: true, createdAt: new Date(t0).toISOString() }],
    patients, appointments, invoices,
    tasks: [], records: [], inventory: [], messages: [],
    services: [{ id: "svc_load", clinicId, name: "كشفية", description: "", durationMin: 20, price: 150, isActive: true, sortOrder: 0, createdAt: new Date(t0).toISOString() }],
    plans: [], clinicSubscriptions: [], offers: [], auditLog: [],
    notificationConfigs: [], notificationQueue: [], notificationLog: [],
    inviteCodes: [], patientFiles: [], prescriptions: [], payments: [],
  };
  fs.writeFileSync(path.join(TMP, "db.json"), JSON.stringify(db));
  return Buffer.byteLength(JSON.stringify(db)) / 1048576;
}

function req(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    if (cookie) h["Cookie"] = cookie;
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 30000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let j = null; try { j = JSON.parse(buf); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json: j, text: buf, ms });
      });
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, json: null, text: String(e.message), ms: -1 }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, json: null, text: "timeout", ms: -1 }); });
    if (data) r.write(data); r.end();
  });
}
async function waitHealthy(tries = 120) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", method: "GET", timeout: 1000 },
        (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
      r.end();
    });
    if (ok) return true;
    await sleep(500);
  }
  return false;
}
const cookieOf = (r) => (r.headers?.["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");

(async () => {
  const mb = seedBig();
  console.log(`  ..   seeded ${(mb).toFixed(1)}MB db.json (${N_PAT} patients / ${N_APT} appointments / ${N_INV} invoices)`);

  const boot0 = Date.now();
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    // BOOKING_BURST_MAX raised so the race measures the overlap guard itself,
    // not the per-IP flood throttle (covered separately by its own 429 path)
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1", BOOKING_BURST_MAX: "1000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let srvOut = "";
  srv.stdout.on("data", (d) => (srvOut += d));
  srv.stderr.on("data", (d) => (srvOut += d));
  const finish = (code) => {
    try { srv.kill("SIGKILL"); } catch { /* gone */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    const rss = Math.round(process.memoryUsage().rss / 1048576);
    console.log(`  ..   test-process RSS=${rss}MB`);
    console.log(`\n   PASS ${pass}   FAIL ${fail}`);
    process.exit(code);
  };
  if (!(await waitHealthy())) { console.log("server never became healthy:\n" + srvOut.slice(-2000)); finish(1); return; }
  console.log(`  ..   boot on huge db took ${((Date.now() - boot0) / 1000).toFixed(1)}s`);

  const login = await req("POST", "/api/auth/login", { body: { username: "loadadmin", password: "Load-Admin-2026!" } });
  const A = cookieOf(login);
  check("owner signs in on huge db", login.status === 200 && !!A, `code=${login.status} login=${login.ms.toFixed(0)}ms`);

  const q = await req("GET", "/api/patients?q=0550012345", { cookie: A });
  check("search over 10k patients", q.status === 200, `code=${q.status} ${q.ms.toFixed(0)}ms`);
  const slots = await req("GET", "/api/public/booking/load-clinic/slots?date=" + new Date(Date.now() + 31 * 864e5).toISOString().slice(0, 10) + "&serviceId=svc_load");
  check("slot grid over 20k appointments", slots.status === 200 && Array.isArray(slots.json?.slots), `code=${slots.status} ${slots.ms.toFixed(0)}ms`);

  // ── 50 concurrent same-slot bookings: exactly one wins ──
  const clashDay = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  const body = { patientName: "سباق", phone: "0599999999", date: clashDay, time: "10:00", serviceId: "svc_load" };
  const race0 = Date.now();
  const results = await Promise.all(Array.from({ length: 50 }, () => req("POST", "/api/public/booking/load-clinic", { body })));
  console.log(`  ..   50 concurrent bookings settled in ${Date.now() - race0}ms`);
  const ok200 = results.filter((r) => r.status === 200).length;
  const c409 = results.filter((r) => r.status === 409).length;
  const err5xx = results.filter((r) => r.status >= 500 || r.status === 0).length;
  check("race: exactly one booking wins", ok200 === 1, `200=${ok200} 409=${c409} err=${err5xx}`);
  check("race: losers get 409, never 5xx", err5xx === 0 && ok200 + c409 === 50, `409=${c409}`);
  // count rows for the racing phone via search instead of N+1
  const all = await req("GET", "/api/patients?limit=200&q=0599999999", { cookie: A });
  const plist = Array.isArray(all.json) ? all.json : (all.json?.items || all.json?.patients || []);
  check("race: exactly one patient row for the racing phone", plist.length === 1, `n=${plist.length}`);

  // ── 200 sequential creates: zero lost writes ──
  const w0 = Date.now();
  for (let i = 0; i < 200; i++) {
    const r = await req("POST", "/api/patients", { cookie: A, body: { fullName: `ضغط كتابة ${i}`, phone: `056${String(2000000 + i)}` } });
    if (r.status !== 200) { check("burst create ok", false, `i=${i} code=${r.status}`); break; }
    if (i === 199) check("200 sequential creates accepted", true, `${((Date.now() - w0) / 1000).toFixed(1)}s total`);
  }
  await sleep(800); // let the debounced flush land
  const cnt = await req("GET", "/api/patients?limit=1", { cookie: A });
  const total = cnt.json?.total;
  check("zero lost writes (total matches)", total === N_PAT + 200 + 1, `total=${total}`); // seeded + burst + the one race winner

  const snaps = fs.existsSync(path.join(TMP, "backups")) ? fs.readdirSync(path.join(TMP, "backups")).filter((f) => f.startsWith("db-")) : [];
  check("boot backup of the big file exists", snaps.length >= 1, snaps.slice(-1).join(","));

  // ── flood throttle still guards (separate tiny server, BURST=3) ──
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-load-thr-"));
  const srv2 = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP2, PORT: "3214", HOST: "127.0.0.1", BOOKING_BURST_MAX: "3" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await sleep(3000);
  const flood2 = [];
  for (let i = 0; i < 4; i++) {
    flood2.push(await new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify({ patientName: `فيض ${i}`, phone: `057000001${i}`, date: clashDay, time: "11:00" }));
      const r = http.request({ host: "127.0.0.1", port: 3214, path: "/api/public/booking/al-noor-clinic", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length }, timeout: 15000 }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      r.on("error", () => resolve(0));
      r.on("timeout", () => { r.destroy(); resolve(0); });
      r.write(data); r.end();
    }));
  }
  check("flood throttle caps bursts (4th is 429)", flood2.slice(0, 3).every((c) => c === 200) && flood2[3] === 429, flood2.join(","));
  try { srv2.kill("SIGKILL"); } catch { /* gone */ }
  try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch { /* best effort */ }

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });