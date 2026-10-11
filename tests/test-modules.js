/* The owner's new "وحدات العيادات" picker in the subscriptions screen.
 *   - a section switched off for a clinic disappears from that clinic's menu
 *   - the same map makes the API refuse the calls (effectivePermissions)
 *   - only known keys are stored, absent key = section still on
 *   - the site owner and support are never clinic-scoped, so they are untouched
 * A throw-away staff account is hired for the run and removed afterwards.
 */
const http = require("http");
const fs = require("fs");

const DB = "C:\\Users\\911ho\\OneDrive\\Desktop\\clinic\\eyada-clinic-main\\data\\db.json";
let pass = 0, fail = 0;
const check = (n, ok, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${extra ? "   " + extra : ""}`);
  ok ? pass++ : fail++;
};

function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const pay = body ? JSON.stringify(body) : null;
    const h = {};
    if (pay) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(pay); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ port: 3000, path: p, method, headers: h, timeout: 10000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ code: res.statusCode, body: b, cookie: res.headers["set-cookie"] || [] }));
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message, cookie: [] }));
    r.on("timeout", () => { r.destroy(); resolve({ code: 0, body: "timeout", cookie: [] }); });
    if (pay) r.write(pay); r.end();
  });
}
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };

async function login(username, passwords) {
  for (const pw of passwords) {
    const r = await req("POST", "/api/auth/login", { username, password: pw });
    if (J(r).user) {
      const m = (r.cookie || []).join(";").match(/eyada_session=([A-Za-z0-9_-]+)/);
      return m ? m[1] : "";
    }
  }
  return "";
}

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const owner = db.users.find((u) => u.role === "super_admin");
  const ownerTok = await login(owner.username, ["admin123", "123456", "admin"]);
  check("site owner session", !!ownerTok, owner.username);
  if (!ownerTok) return done();
  const oc = "eyada_session=" + ownerTok;

  const clinic = db.clinicSubscriptions.find((s) => s.status === "active");
  check("an active subscription to work on", !!clinic, clinic && clinic.clinicId);
  if (!clinic) return done();

  const tmpName = "modtest_" + Date.now().toString(36);
  const hire = await req("POST", "/api/users", {
    username: tmpName, password: "modtest1", fullName: "موظف الاختبار",
    role: "reception", clinicId: clinic.clinicId,
  }, oc);
  const staffId = J(hire).id;
  check("hired a throw-away staff account", hire.code === 201 || hire.code === 200, "code=" + hire.code + " " + J(hire).error);

  const staffTok = staffId ? await login(tmpName, ["modtest1"]) : "";
  check("staff session", !!staffTok, tmpName);
  if (!staffTok) { await req("DELETE", "/api/users", { id: staffId }, oc); return done(); }
  const sc = "eyada_session=" + staffTok;

  const me0 = J(await req("GET", "/api/auth/me", null, sc));
  check("staff starts with the section", me0.user.permissions.appointments === true,
    "appointments=" + me0.user.permissions.appointments);

  // 1. the owner switches المواعيد off
  const set = await req("PUT", `/api/clinic-subscriptions/${clinic.id}`,
    { modules: { appointments: false, bogus: false, patients: true } }, oc);
  check("owner saves the module map", set.code === 200, "code=" + set.code);
  const saved = J(set).modules || {};
  check("only known keys are stored", saved.appointments === false && saved.bogus === undefined && saved.patients === undefined,
    JSON.stringify(saved));

  // 2. the clinic staff immediately loses that section
  const me1 = J(await req("GET", "/api/auth/me", null, sc));
  check("appointments permission is off", me1.user.permissions.appointments === false,
    "appointments=" + me1.user.permissions.appointments);
  check("the rest of the menu survives", me1.user.permissions.patients === true && me1.user.permissions.dashboard === true,
    JSON.stringify(me1.user.permissions));

  const ap = await req("GET", "/api/appointments", null, sc);
  check("API refuses the disabled section", ap.code === 403, "code=" + ap.code + " " + J(ap).error);
  const pat = await req("GET", "/api/patients", null, sc);
  check("API still serves the enabled sections", pat.code === 200, "code=" + pat.code);

  const own = J(await req("GET", "/api/auth/me", null, oc));
  check("site owner is never clinic-scoped", own.user.permissions.appointments === true);

  // 3. turning it back on restores everything
  const back = await req("PUT", `/api/clinic-subscriptions/${clinic.id}`, { modules: {} }, oc);
  check("owner restores the section", back.code === 200 && JSON.stringify(J(back).modules) === "{}", "code=" + back.code);
  const me2 = J(await req("GET", "/api/auth/me", null, sc));
  check("appointments permission is back", me2.user.permissions.appointments === true);
  const ap2 = await req("GET", "/api/appointments", null, sc);
  check("API accepts it again", ap2.code === 200, "code=" + ap2.code);

  // 4. support cannot rewrite the map
  const supTok = await login("support", ["support", "admin123", "123456"]);
  if (supTok) {
    const s403 = await req("PUT", `/api/clinic-subscriptions/${clinic.id}`, { modules: { appointments: false } },
      "eyada_session=" + supTok);
    check("support may not change the map", s403.code === 403, "code=" + s403.code);
  }

  const gone = await req("DELETE", "/api/users", { id: staffId }, oc);
  check("throw-away account removed", gone.code === 200, "code=" + gone.code + " " + (J(gone).error || ""));

  done();

  function done() {
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
