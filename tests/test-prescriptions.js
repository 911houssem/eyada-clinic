/**
 * Prescriptions suite — CRUD, record linkage, clinic isolation, trash cycle,
 * and sealed content at rest. Own throwaway server. Prints "PASS n   FAIL n".
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3202;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-rx-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";

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

  const login = await req("POST", "/api/auth/login", { body: { username: "admin", password: "admin123" } });
  const A = cookieOf(login);
  check("seeded owner signs in", login.status === 200 && !!A, `code=${login.status}`);

  const p = await req("POST", "/api/patients", { cookie: A, body: { fullName: "Rx Probe", phone: "0555000201" } });
  const pid = p.json?.id;
  check("probe patient created", !!pid);
  const rec = await req("POST", "/api/records", { cookie: A, body: { patientId: pid, chiefComplaint: "صداع", diagnosis: "توتر" } });
  const rid = rec.json?.id;

  const items = [{ name: "Paracetamol 500mg", dose: "قرص كل 8 ساعات", duration: "5 أيام", instructions: "بعد الأكل" }];
  const rx = await req("POST", "/api/prescriptions", { cookie: A, body: { patientId: pid, recordId: rid, items, notes: "مراجعة بعد أسبوع" } });
  check("prescription created + linked", rx.status === 200 && rx.json?.recordId === rid && rx.json.items.length === 1, `code=${rx.status}`);
  const rxid = rx.json?.id;

  const noItems = await req("POST", "/api/prescriptions", { cookie: A, body: { patientId: pid, items: [] } });
  check("empty items rejected (400)", noItems.status === 400, `code=${noItems.status}`);
  const noName = await req("POST", "/api/prescriptions", { cookie: A, body: { patientId: pid, items: [{ dose: "x" }] } });
  check("nameless item rejected (400)", noName.status === 400, `code=${noName.status}`);
  const badPat = await req("POST", "/api/prescriptions", { cookie: A, body: { patientId: "pat_nope", items } });
  check("unknown patient rejected", badPat.status === 400 || badPat.status === 404, `code=${badPat.status}`);

  const list = await req("GET", `/api/prescriptions?patientId=${pid}`, { cookie: A });
  check("list by patient", list.status === 200 && (Array.isArray(list.json) ? list.json : []).some((x) => x.id === rxid));

  const upd = await req("PUT", "/api/prescriptions", { cookie: A, body: { id: rxid, notes: "محدّثة" } });
  check("update notes", upd.status === 200 && upd.json?.notes === "محدّثة", `code=${upd.status}`);

  // ── isolation: clinic B ──
  const reg = await req("POST", "/api/auth/register", { body: { username: "rxb", password: "Rx-B-2026!", fullName: "B Owner", clinicName: "Clinic B Rx" } });
  const B = cookieOf(reg);
  const bList = await req("GET", "/api/prescriptions", { cookie: B });
  check("IDOR: clinic B sees no prescriptions", bList.status === 200 && (Array.isArray(bList.json) ? bList.json : []).length === 0, `n=${(bList.json || []).length}`);
  const bPut = await req("PUT", "/api/prescriptions", { cookie: B, body: { id: rxid, notes: "x" } });
  check("IDOR: clinic B cannot edit (403/404)", bPut.status === 403 || bPut.status === 404, `code=${bPut.status}`);
  const bDel = await req("DELETE", "/api/prescriptions", { cookie: B, body: { id: rxid } });
  check("IDOR: clinic B cannot delete (403/404)", bDel.status === 403 || bDel.status === 404, `code=${bDel.status}`);
  const bPost = await req("POST", "/api/prescriptions", { cookie: B, body: { patientId: pid, items } });
  check("IDOR: clinic B cannot prescribe for A's patient (403)", bPost.status === 403, `code=${bPost.status}`);

  // ── trash cycle + sealed content ──
  const del = await req("DELETE", "/api/prescriptions", { cookie: A, body: { id: rxid } });
  check("delete soft-deletes", del.status === 200 && del.json?.softDeleted === true, `code=${del.status}`);
  const trash = await req("GET", "/api/trash?type=prescriptions", { cookie: A });
  check("trashed prescription listed", (trash.json?.items || []).some((x) => x.id === rxid));
  const rest = await req("POST", `/api/trash/prescriptions/${rxid}/restore`, { cookie: A });
  check("restore works", rest.status === 200, `code=${rest.status}`);
  await sleep(800);
  const rawDb = fs.readFileSync(path.join(TMP, "db.json"), "utf8");
  check("drug name sealed at rest", !rawDb.includes("Paracetamol 500mg"));
  check("prescription note sealed at rest", !rawDb.includes("محدّثة"));

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
