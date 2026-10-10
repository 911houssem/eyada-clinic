// Verifies the new backend behaviour end to end against a live server.
// Covers: site-owner grant + list, the paywall for an expired clinic,
// change-password, and service-driven slot durations.
const http = require("http");
const fs = require("fs");
const DB = "C:\\Users\\911ho\\Desktop\\bank\\data\\db.json";

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "   " + extra : "")); }
}
function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const pay = body ? JSON.stringify(body) : null;
    const h = {};
    if (pay) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(pay); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ port: 3000, path: p, method, headers: h, timeout: 10000 }, (res) => {
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
// db.json is written on a debounce, so a read straight after a write sees the
// previous snapshot: always let the server settle before inspecting the file
const settle = () => new Promise((r) => setTimeout(r, 700));
const reload = () => JSON.parse(fs.readFileSync(DB, "utf8"));

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const uniq = Date.now().toString(36);
  const site = db.users.find((u) => u.role === "super_admin");

  let sc = "";
  for (const pw of ["123456", "admin123", "admin"]) {
    const l = await req("POST", "/api/auth/login", { username: site.username, password: pw });
    if (J(l).user) { sc = ck(l); break; }
  }
  check("site owner signed in", !!sc);

  /* ── 1. grant a subscription and see it in the list ── */
  console.log("\n--- owner grants a subscription ---");
  const clinic = db.clinics[1] || db.clinics[0];
  const plan = db.plans.find((p) => p.isActive);
  const grant = await req("POST", "/api/clinic-subscriptions", {
    clinicId: clinic.id, planId: plan.id, status: "active", billingCycle: "monthly",
  }, sc);
  check("grant accepted", grant.code === 200, "code=" + grant.code);

  const all = J(await req("GET", "/api/clinic-subscriptions?all=true", null, sc));
  const rows = Array.isArray(all) ? all : [];
  check("owner list is not empty", rows.length > 0, "n=" + rows.length);
  check("granted clinic appears in list", rows.some((x) => x.clinicId === clinic.id));
  check("rows carry clinicName", rows.every((x) => "clinicName" in x));
  await settle();
  const db1 = reload();
  const live = db1.clinicSubscriptions.filter((x) => x.clinicId === clinic.id &&
    ["active", "trial"].includes(x.status));
  check("only one live row for the clinic", live.length === 1, "n=" + live.length);
  check("the live row is the granted plan", live[0] && live[0].planId === plan.id);

  const bad = await req("POST", "/api/clinic-subscriptions", { clinicId: "nope", planId: plan.id }, sc);
  check("rejects unknown clinic", bad.code === 400, "code=" + bad.code);
  const bad2 = await req("POST", "/api/clinic-subscriptions", { clinicId: clinic.id, planId: "nope" }, sc);
  check("rejects unknown plan", bad2.code === 400, "code=" + bad2.code);

  /* ── 2. the paywall: an expired clinic can only chat ── */
  console.log("\n--- paywall for an expired clinic ---");
  const uname = "lock" + uniq;
  const reg = await req("POST", "/api/auth/register", {
    username: uname, password: "test1234", fullName: "Lock Probe",
    clinicName: "Lock Probe " + uniq, clinicPhone: "0500000000",
  });
  check("probe clinic registered", reg.code === 200, "code=" + reg.code);
  let pc = ck(reg);
  const pid = J(reg).user && J(reg).user.clinicId;

  // expire it straight away
  const cid = J(reg).user.clinicId;
  await settle();
  const db2 = reload();
  const sub = db2.clinicSubscriptions.find((x) => x.clinicId === cid);
  check("probe clinic got a trial subscription", !!sub);
  if (!sub) { console.log("\n   PASS " + pass + "   FAIL " + fail); process.exit(1); }
  const exp = await req("PUT", "/api/clinic-subscriptions/" + sub.id, {
    status: "expired", endDate: new Date(Date.now() - 864e5).toISOString(),
  }, sc);
  check("trial expired by the site owner", exp.code === 200, "code=" + exp.code);

  const me = await req("GET", "/api/auth/me", null, pc);
  check("locked flag is set for the clinic", J(me).locked === true, JSON.stringify(J(me).locked));
  check("me still reports the user", !!(J(me).user && J(me).user.username));

  const pats = await req("GET", "/api/patients", null, pc);
  check("patients list is blocked", pats.code === 402, "code=" + pats.code);
  const dash = await req("GET", "/api/dashboard", null, pc);
  check("dashboard is blocked", dash.code === 402, "code=" + dash.code);
  const appts = await req("GET", "/api/appointments", null, pc);
  check("appointments are blocked", appts.code === 402, "code=" + appts.code);
  const inv = await req("GET", "/api/invoices", null, pc);
  check("invoices are blocked", inv.code === 402, "code=" + inv.code);

  const support = db.users.find((u) => u.role === "support");
  const chats = await req("GET", "/api/chat", null, pc);
  check("chat still works", chats.code === 200, "code=" + chats.code);
  const send = await req("POST", "/api/chat",
    { receiverId: support.id, message: "انتهى اشتراكي، كيف أجدده؟" }, pc);
  check("locked clinic can message support", send.code === 200, "code=" + send.code + " " + send.body.slice(0, 120));
  const mysub = await req("GET", "/api/clinic-subscriptions", null, pc);
  check("locked clinic can read its own subscription", mysub.code === 200, "code=" + mysub.code);
  const svcRead = await req("GET", "/api/services", null, pc);
  check("locked clinic can still read its menu", svcRead.code === 200, "code=" + svcRead.code);
  const svcWrite = await req("POST", "/api/services", { name: "x", price: 1, durationMin: 10 }, pc);
  check("locked clinic cannot edit its menu", svcWrite.code === 402, "code=" + svcWrite.code);

  // public booking must keep working for a locked clinic
  await settle();
  const slug = reload().clinics.find((c) => c.id === cid).bookingSlug;
  const pub = await req("GET", "/api/public/booking/" + slug);
  check("public booking page still open", pub.code === 200, "code=" + pub.code + " slug=" + slug);
  const slots = await req("GET", "/api/public/booking/" + slug + "/slots?date=" + new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  check("public slots still open for a locked clinic", slots.code === 200, "code=" + slots.code);

  /* ── 3. change password ── */
  console.log("\n--- change password ---");
  const wrong = await req("POST", "/api/auth/change-password", { currentPassword: "nope", newPassword: "newpass1" }, pc);
  check("rejects a wrong current password", wrong.code === 400, "code=" + wrong.code);
  const short = await req("POST", "/api/auth/change-password", { currentPassword: "test1234", newPassword: "123" }, pc);
  check("rejects a too-short password", short.code === 400, "code=" + short.code);
  const same = await req("POST", "/api/auth/change-password", { currentPassword: "test1234", newPassword: "test1234" }, pc);
  check("rejects reusing the current password", same.code === 400, "code=" + same.code);

  // a second session must be dropped by the change
  const second = await req("POST", "/api/auth/login", { username: uname, password: "test1234" });
  let sc2 = ck(second);
  check("second session logged in", J(second).user && !!sc2);
  const me2 = await req("GET", "/api/auth/me", null, sc2);
  check("second session alive before the change", me2.code === 200, "code=" + me2.code);

  const okc = await req("POST", "/api/auth/change-password", { currentPassword: "test1234", newPassword: "brandnew1" }, pc);
  check("password changed", okc.code === 200, "code=" + okc.code);
  const me3 = await req("GET", "/api/auth/me", null, sc2);
  check("other sessions revoked", me3.code === 401, "code=" + me3.code);

  const relog = await req("POST", "/api/auth/login", { username: uname, password: "brandnew1" });
  check("new password works", J(relog).user && J(relog).user.username === uname);
  const oldPw = await req("POST", "/api/auth/login", { username: uname, password: "test1234" });
  check("old password rejected", !J(oldPw).user);

  /* ── 4. service duration drives the grid ── */
  console.log("\n--- service duration drives slots ---");
  const dur = db.clinics.find((c) => c.id === db.clinics[0].id);
  const target = db.clinics[0];
  const tslug = target.bookingSlug;
  const menu = J(await req("GET", "/api/public/booking/" + tslug));
  const svc = (menu.services || [])[0];
  check("public menu has services", (menu.services || []).length > 0);
  check("clinic object no longer exposes slotDuration", menu.clinic && menu.clinic.slotDuration === undefined,
    JSON.stringify(menu.clinic));

  const d = new Date(); d.setDate(d.getDate() + 1);
  const dateStr = d.toISOString().slice(0, 10);
  const slotsResp = J(await req("GET", "/api/public/booking/" + tslug + "/slots?date=" + dateStr + "&serviceId=" + svc.id));
  check("slots honour the service duration", slotsResp.durationMin === svc.durationMin,
    "slots=" + slotsResp.durationMin + " svc=" + svc.durationMin);

  /* ── 5. per-user permission overrides ── */
  console.log("\n--- owner creates an account with chosen permissions ---");
  // a clinic whose owner password we actually know: the seeded one
  const ownerRow = db.users.find((u) => u.clinicId === db.clinics[0].id && u.role === "admin")
    || db.users.find((u) => u.role === "super_admin");
  let oc = "";
  for (const pw of ["123456", "admin123", "admin"]) {
    const l = await req("POST", "/api/auth/login", { username: ownerRow.username, password: pw });
    if (J(l).user) { oc = ck(l); break; }
  }
  check("owner signed in for the permission test", !!oc, "user=" + ownerRow.username);
  if (oc) {
    const st = await req("POST", "/api/users", {
      username: "st" + uniq, password: "test1234", fullName: "Custom Perms",
      role: "reception", permissions: { patients: true, appointments: false, invoices: true },
    }, oc);
    check("account created with explicit permissions", st.code === 200, "code=" + st.code);
    // POST /api/users answers with the user object itself, not { user: ... }
    const perms = J(st).permissions;
    check("permissions stored on the user", perms && perms.patients === true && perms.invoices === true,
      JSON.stringify(perms));
    check("denied permission stored as false", perms && perms.appointments === false, JSON.stringify(perms));

    // and the override must actually be enforced on the next request
    const asStaff = await req("POST", "/api/auth/login", { username: "st" + uniq, password: "test1234" });
    let stc = ck(asStaff);
    check("new account can sign in", J(asStaff).user && !!stc);
    if (stc) {
      const okPat = await req("GET", "/api/patients", null, stc);
      check("granted permission works", okPat.code === 200, "code=" + okPat.code);
      const okInv = await req("GET", "/api/invoices", null, stc);
      check("second granted permission works", okInv.code === 200, "code=" + okInv.code);
      const okApt = await req("GET", "/api/appointments", null, stc);
      check("revoked permission is enforced", okApt.code === 403, "code=" + okApt.code);
    }
  }

  console.log("\n   PASS " + pass + "   FAIL " + fail);
  process.exit(fail ? 1 : 0);
})();