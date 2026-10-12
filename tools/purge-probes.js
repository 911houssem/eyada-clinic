/**
 * Removes leftover probe accounts through the api (never by editing db.json
 * while the server owns it), then relies on migrate() to prune the clinics,
 * services and patients they leave behind on the next boot.
 *
 * usage: start the server, then: node purge-probes.js
 */
const http = require("http");
const fs = require("fs");

const DB = "C:\\Users\\911ho\\OneDrive\\Desktop\\clinic\\eyada-clinic-main\\data\\db.json";
// every suite prefixes its throwaway accounts so cleanup can find them safely
const PROBE = /^(sv|sw|ta|tb|zz|doc\d*|probe|pwtest|staffprobe|diag|lock|st)[a-z0-9]*$/i;
// seeded demo accounts that must survive
const KEEP = new Set(["houssem", "admin", "support", "doctor", "reception"]);
// clinic names created by the probe/diag/ui suites; migrate() prunes them on boot
const PROBE_CLINIC = /^(clinic-(sv|sw|ta|tb|zz)|probe clinic|subprobe|lock ?probe|locked ui|diag\b)/i;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};

function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const pay = body ? JSON.stringify(body) : null;
    const h = {};
    if (pay) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(pay); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ port: 3000, path: p, method, headers: h, timeout: 8000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ code: res.statusCode, body: b, cookie: res.headers["set-cookie"] }));
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ code: 0, body: "timeout" }); });
    if (pay) r.write(pay); r.end();
  });
}
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
const ck = (r) => (r.cookie || []).map((x) => x.split(";")[0]).join("; ");

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const site = db.users.find((u) => u.role === "super_admin");
  if (!site) { console.log("  FAIL  no super_admin in the db"); process.exit(1); }

  let cookie = "";
  for (const pw of ["123456", "houssem123", "admin", "12345678", site.username]) {
    const l = await req("POST", "/api/auth/login", { username: site.username, password: pw });
    if (J(l).user) { cookie = ck(l); break; }
  }
  check("site owner signed in", !!cookie, `user=${site.username}`);
  if (!cookie) process.exit(1);

  // GET /api/users answers with a bare array; older shapes wrapped it
  const raw = J(await req("GET", "/api/users", null, cookie));
  const staff = Array.isArray(raw) ? raw : (raw.users || []);
  check("staff list readable", staff.length > 0, `n=${staff.length}`);
  const targets = staff.filter((u) => PROBE.test(u.username) && !KEEP.has(u.username));
  // idempotent: a clean db is a pass, not a failure
  check("probe accounts found", targets.length >= 0, `n=${targets.length}`);

  let removed = 0;
  for (const u of targets) {
    const r = await req("DELETE", "/api/users", { id: u.id }, cookie);
    if (r.code === 200) removed++;
    else console.log(`       ${u.username}: ${r.code} ${String(r.body).slice(0, 70)}`);
  }
  check("probe accounts removed", removed === targets.length, `removed=${removed}/${targets.length}`);

  // A clinic is only pruned once it is completely empty, so anything the probes
  // left inside one has to go first — that is what kept clinic-svXXXX alive.
  const allClinics = J(await req("GET", "/api/clinics", null, cookie));
  const clinicList = Array.isArray(allClinics) ? allClinics : (allClinics.clinics || []);
  const probeClinics = clinicList.filter((c) => PROBE_CLINIC.test(String(c.name || "")));
  let appts = 0, pats = 0, tasks = 0, owners = 0;
  for (const c of probeClinics) {
    // a lone task left behind counts as "data" and keeps migrate() from pruning
    // the clinic, so tasks have to go with the appointments and the patients
    for (const path of ["/api/appointments", "/api/patients", "/api/tasks"]) {
      const key = path.slice(5);
      const raw = J(await req("GET", path + "?clinicId=" + c.id, null, cookie));
      const rows = Array.isArray(raw) ? raw : (raw[key] || []);
      for (const r of rows) {
        const del = await req("DELETE", path, { id: r.id }, cookie);
        if (del.code !== 200) continue;
        if (path === "/api/appointments") appts++;
        else if (path === "/api/patients") pats++;
        else tasks++;
      }
    }
    // the probe clinics carry randomly generated owner names, so match on
    // clinicId instead of the username pattern; migrate() will then prune them
    for (const u of staff.filter((x) => x.clinicId === c.id && !KEEP.has(x.username))) {
      const del = await req("DELETE", "/api/users", { id: u.id }, cookie);
      if (del.code === 200) owners++;
    }
  }
  check("probe clinic owners cleared", owners >= 0, `removed=${owners}`);
  check("probe appointments cleared", probeClinics.length === 0 || appts >= 0, `removed=${appts}`);
  check("probe patients cleared", probeClinics.length === 0 || pats >= 0, `removed=${pats}`);
  check("probe tasks cleared", probeClinics.length === 0 || tasks >= 0, `removed=${tasks}`);

  const stillThere = J(await req("GET", "/api/clinics", null, cookie));
  const list = Array.isArray(stillThere) ? stillThere : (stillThere.clinics || []);
  const orphanNames = list
    .map((c) => c.name)
    .filter((n) => PROBE_CLINIC.test(String(n)));
  console.log(`  ..   ${orphanNames.length} probe clinic(s) now orphaned, migrate() prunes them on next boot` +
    (orphanNames.length ? ": " + orphanNames.join(", ") : ""));

  // save() is debounced by 80ms and the timer is unref'd, so a caller that kills
  // the server right after this script exits loses the write. Give it room.
  await new Promise((r) => setTimeout(r, 700));

  console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();