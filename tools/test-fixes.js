// Tests for the four reported bugs.
const http = require("http");
const fs = require("fs");
const ROOT = "C:\\Users\\911ho\\Desktop\\bank";
const DB = ROOT + "\\data\\db.json";
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`); cond ? pass++ : fail++; };

function req(method, p, body, cookie) {
  return new Promise((resolve) => {
    const pay = body ? JSON.stringify(body) : null;
    const h = {};
    if (pay) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(pay); }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ port: 3000, path: p, method, headers: h, timeout: 8000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ code: res.statusCode, body: b, cookie: res.headers["set-cookie"], headers: res.headers }));
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ code: 0, body: "timeout" }); });
    if (pay) r.write(pay); r.end();
  });
}
const login = async (u, p) => {
  const r = await req("POST", "/api/auth/login", { username: u, password: p });
  return { ...r, cookie: (r.cookie || []).map((x) => x.split(";")[0]).join("; ") };
};
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
const uniq = () => Math.random().toString(36).slice(2, 8);
const NAME = "مريض الحجز";
const NOTE = "أول زيارة";

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const createdUsers = [];
  const createdClinics = [];

  console.log("\n=== BUG 1: new account must NOT be site owner ===");
  const su = db.users.filter((u) => u.role === "super_admin");
  check("exactly one super_admin in db", su.length === 1, su.map((u) => u.username).join(","));
  check("no 'receptionist' role left", !db.users.some((u) => u.role === "receptionist"),
    [...new Set(db.users.map((u) => u.role))].join(","));
  check("every clinic has a bookingSlug", db.clinics.every((c) => !!c.bookingSlug));
  check("every clinic ownerId resolves to a user",
    db.clinics.every((c) => !c.ownerId || db.users.some((u) => u.id === c.ownerId)),
    db.clinics.filter((c) => c.ownerId && !db.users.some((u) => u.id === c.ownerId)).map((c) => c.name).join(","));

  const u1 = "own" + uniq();
  const cname = "clinic-" + u1;
  const reg = await req("POST", "/api/auth/register", { username: u1, password: "secret123", fullName: "صاحب عيادة جديد", clinicName: cname });
  const owner = J(reg);
  const ownerCookie = (reg.cookie || []).map((x) => x.split(";")[0]).join("; ");
  createdUsers.push(u1); createdClinics.push(owner.user?.clinicId || owner.currentClinicId);
  check("register 200", reg.code === 200, `code=${reg.code}`);
  check("new account role is admin (صاحب عيادة), NOT super_admin", owner.user?.role === "admin", `role=${owner.user?.role}`);
  check("registration created its own clinic", !!createdClinics[0]);
  check("new clinic has a booking slug", !!(await J(await req("GET", "/api/clinics", null, ownerCookie)))[0]?.bookingSlug);
  check("new account starts on a 1 hour trial", owner.user?.subscription?.status === "trial" && owner.user?.subscription?.canHire === false,
    JSON.stringify(owner.user?.subscription));

  const ownClinics = J(await req("GET", "/api/clinics", null, ownerCookie));
  check("clinic owner sees exactly their clinic", ownClinics.length === 1, `n=${ownClinics.length}`);

  // a trial may use everything except hiring
  const staffName = "staff" + uniq();
  createdUsers.push(staffName);
  const trialHire = await req("POST", "/api/users", { username: staffName, password: "secret123", fullName: "موظف", role: "doctor" }, ownerCookie);
  check("trial clinic CANNOT hire (402)", trialHire.code === 402, `code=${trialHire.code}`);
  const trialBook = await req("GET", "/api/dashboard", null, ownerCookie);
  check("trial clinic can still use the app", trialBook.code === 200, `code=${trialBook.code}`);
  const selfSub = await req("POST", "/api/clinic-subscriptions", { clinicId: createdClinics[0], status: "active" }, ownerCookie);
  check("clinic owner cannot self-activate a paid plan", selfSub.code === 403, `code=${selfSub.code}`);

  const siteOwner = await login("admin", "admin123");
  check("site owner login still works", siteOwner.code === 200 && J(siteOwner).user.role === "super_admin");
  const pay = await req("POST", "/api/clinic-subscriptions",
    { clinicId: createdClinics[0], status: "active", endDate: new Date(Date.now() + 30 * 864e5).toISOString() }, siteOwner.cookie);
  check("site owner can put the clinic on a paid plan", pay.code === 200, `code=${pay.code}`);

  const addStaff = await req("POST", "/api/users", { username: staffName, password: "secret123", fullName: "موظف", role: "doctor" }, ownerCookie);
  check("clinic owner can add staff once subscribed", addStaff.code === 200, `code=${addStaff.code}`);
  check("staff got the requested role", J(addStaff).role === "doctor", `role=${J(addStaff).role}`);
  check("staff defaults to their owner's clinic", J(addStaff).clinicId === createdClinics[0]);
  check("role carries its default permissions", J(addStaff).permissions?.patients === true && J(addStaff).permissions?.settings === false,
    JSON.stringify(J(addStaff).permissions));

  const escName = "esc" + uniq();
  createdUsers.push(escName);
  const esc1 = await req("POST", "/api/users", { username: escName, password: "secret123", fullName: "متدس", role: "super_admin" }, ownerCookie);
  check("clinic owner CANNOT create a super_admin", esc1.code === 403, `code=${esc1.code}`);
  const esc4 = await req("POST", "/api/users", { username: escName, password: "secret123", fullName: "متدس", role: "admin" }, ownerCookie);
  check("clinic owner CANNOT create a second owner", esc4.code === 403, `code=${esc4.code}`);
  const esc3 = await req("PUT", "/api/users", { id: owner.user.id, role: "super_admin" }, ownerCookie);
  check("cannot self-promote to super_admin", esc3.code === 403, `code=${esc3.code}`);

  const doctorLogin = await login("doctor", "doctor123");
  const staffAdd = await req("POST", "/api/users", { username: "x" + uniq(), password: "secret123", fullName: "x" }, doctorLogin.cookie);
  check("doctor CANNOT add users", staffAdd.code === 403, `code=${staffAdd.code}`);

  const imp = await req("POST", "/api/auth/impersonate", { userId: owner.user.id }, siteOwner.cookie);
  check("site owner can still impersonate", imp.code === 200, `code=${imp.code}`);
  const ownerImp = await req("POST", "/api/auth/impersonate", { userId: J(siteOwner).user.id }, ownerCookie);
  check("clinic owner canNOT impersonate", ownerImp.code === 403, `code=${ownerImp.code}`);

  console.log("\n=== BUG 2: contact the owner / chat shape ===");
  const conv = J(await req("GET", "/api/chat?mode=conversations", null, ownerCookie)).conversations || [];
  check("conversations returned", conv.length > 0, `n=${conv.length}`);
  check("every conversation has partnerId", conv.every((c) => !!c.partnerId));
  check("every conversation has a partner object", conv.every((c) => c.partner && !!c.partner.id));
  check("lastMessage is an object or null", conv.every((c) => c.lastMessage === null || typeof c.lastMessage === "object"));
  const supportInChat = conv.filter((c) => c.partner?.role === "support");
  check("the helpdesk appears in the conversation list", supportInChat.length === 1,
    supportInChat.map((c) => c.partner.fullName).join(","));
  check("the site owner is NOT offered to a clinic", !conv.some((c) => c.partner?.role === "super_admin"));
  check("client find() resolves the support button", !!conv.find((c) => c.partner?.role === "support"));

  const blocked = await req("POST", "/api/chat", { receiverId: J(siteOwner).user.id, message: "should fail" }, ownerCookie);
  check("a clinic CANNOT message the site owner", blocked.code === 403, `code=${blocked.code}`);
  const peek = await req("GET", `/api/chat?with=${J(siteOwner).user.id}`, null, ownerCookie);
  check("a clinic CANNOT read the site owner thread", peek.code === 403, `code=${peek.code}`);

  const supportId = supportInChat[0].partnerId;
  const MSG = "hello-support-test";
  const sent = await req("POST", "/api/chat", { receiverId: supportId, message: MSG }, ownerCookie);
  check("can message support", sent.code === 200, `code=${sent.code}`);
  const conv2 = (J(await req("GET", "/api/chat?mode=conversations", null, ownerCookie)).conversations || []).find((c) => c.partnerId === supportId);
  check("conversation.lastMessage.message renders", conv2?.lastMessage?.message === MSG, JSON.stringify(conv2?.lastMessage?.message));
  check("conversation.lastMessage.senderId present", conv2?.lastMessage?.senderId === owner.user.id);
  check("conversation.lastMessage.createdAt present", !!conv2?.lastMessage?.createdAt);
  const supportLogin = await login("support", "support123");
  check("support account can sign in", supportLogin.code === 200 && J(supportLogin).user.role === "support", `code=${supportLogin.code}`);
  check("conversation list shows the name", conv2?.partner?.fullName === J(supportLogin).user.fullName);
  const inbox = J(await req("GET", `/api/chat?with=${owner.user.id}`, null, supportLogin.cookie));
  check("support receives the message", (inbox.messages || []).some((m) => m.message === MSG));
  const supDash = await req("GET", "/api/dashboard", null, supportLogin.cookie);
  check("support dashboard is empty, not somebody else's clinic", supDash.code === 200 && (J(supDash).patients || 0) === 0,
    `patients=${J(supDash).patients}`);
  const supPatients = await req("GET", "/api/patients", null, supportLogin.cookie);
  check("support CANNOT list patients", supPatients.code === 403, `code=${supPatients.code}`);

  console.log("\n=== BUG 3: public booking link ===");
  const clinics = J(await req("GET", "/api/clinics", null, siteOwner.cookie));
  const seeded = clinics.find((c) => c.id === db.clinics[0].id) || clinics[0];
  check("site owner sees clinics with bookingSlug", !!seeded?.bookingSlug, `slug=${seeded?.bookingSlug}`);
  check("bookingEnabled defaults true", seeded?.bookingEnabled === true);
  check("slug is URL-safe ASCII", /^[a-z0-9-]+$/.test(seeded?.bookingSlug || ""), `slug=${seeded?.bookingSlug}`);
  const slug = encodeURIComponent(seeded.bookingSlug);

  const toggle = await req("PUT", "/api/clinics", { id: seeded.id, bookingEnabled: false }, siteOwner.cookie);
  check("PUT can turn booking off (was silently dropped)", J(toggle).bookingEnabled === false, `code=${toggle.code}`);
  const offCheck = await req("GET", `/api/public/booking/${slug}`);
  check("disabled clinic rejects public booking", offCheck.code === 403, `code=${offCheck.code}`);
  await req("PUT", "/api/clinics", { id: seeded.id, bookingEnabled: true }, siteOwner.cookie);

  const badSlug = await req("GET", "/api/public/booking/does-not-exist");
  check("unknown slug -> 404", badSlug.code === 404, `code=${badSlug.code}`);

  const pubJ = J(await req("GET", `/api/public/booking/${slug}`));
  check("public clinic info needs no login", !!pubJ.clinic?.name, JSON.stringify(pubJ.clinic?.name));
  check("public payload hides ids/ownerId", !("ownerId" in (pubJ.clinic || {})) && !("id" in (pubJ.clinic || {})));

  const today = new Date().toISOString().slice(0, 10);
  const todaySlots = J(await req("GET", `/api/public/booking/${slug}/slots?date=${today}`));
  check("slots returned for today", Array.isArray(todaySlots.slots) && todaySlots.slots.length > 0, `n=${todaySlots.slots?.length}`);
  check("past times today are not offered", !(todaySlots.slots || []).some((s) => s.available && s.time < new Date().toTimeString().slice(0, 5)));

  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  const tSlots = J(await req("GET", `/api/public/booking/${slug}/slots?date=${tIso}`));
  const pick = (tSlots.slots || []).find((s) => s.available);
  check("tomorrow has open slots", !!pick, JSON.stringify(pick));

  const phone = "0501" + Math.floor(100000 + Math.random() * 899999);
  const bad1 = await req("POST", `/api/public/booking/${slug}`, { patientName: "A", phone, date: tIso, time: pick.time });
  check("short name rejected", bad1.code === 400, `code=${bad1.code}`);
  const bad2 = await req("POST", `/api/public/booking/${slug}`, { patientName: NAME, phone: "abc", date: tIso, time: pick.time });
  check("bad phone rejected", bad2.code === 400, `code=${bad2.code}`);
  const bad3 = await req("POST", `/api/public/booking/${slug}`, { patientName: NAME, phone, date: tIso, time: "99:99" });
  check("bad time rejected", bad3.code === 400, `code=${bad3.code}`);
  const bad4 = await req("POST", `/api/public/booking/${slug}`, { patientName: NAME, phone, date: "2020-01-01", time: pick.time });
  check("past date rejected", bad4.code === 400, `code=${bad4.code}`);
  const bad5 = await req("POST", `/api/public/booking/${slug}`, { patientName: NAME, phone, date: "not-a-date", time: pick.time });
  check("malformed date rejected", bad5.code === 400, `code=${bad5.code}`);

  const ok = await req("POST", `/api/public/booking/${slug}`, { patientName: NAME, phone, date: tIso, time: pick.time, note: NOTE });
  check("booking accepted", ok.code === 200, `code=${ok.code} ${ok.body.slice(0, 90)}`);
  const after = J(await req("GET", `/api/public/booking/${slug}/slots?date=${tIso}`));
  const still = (after.slots || []).find((s) => s.time === pick.time);
  check("booked slot no longer offered", still && still.available === false, JSON.stringify(still));
  const dup = await req("POST", `/api/public/booking/${slug}`, { patientName: NAME, phone, date: tIso, time: pick.time });
  check("double-booking rejected", dup.code === 409, `code=${dup.code}`);

  // the server debounces writes (~80ms) before flushing db.json
  await new Promise((r) => setTimeout(r, 400));
  const dbAfter = JSON.parse(fs.readFileSync(DB, "utf8"));
  const created = dbAfter.appointments.find((a) => a.id === J(ok).appointment?.id);
  check("appointment persisted", !!created, created ? `${created.startTime}` : "");
  check("endTime computed from slotDuration", created && new Date(created.endTime) > new Date(created.startTime));
  check("patient auto-created from the form", !!dbAfter.patients.find((p) => p.phone === phone && p.source === "booking"));
  check("appointment marked as from booking", created?.source === "booking");

  const page = await req("GET", `/booking/${slug}`);
  check("GET /booking/<slug> serves HTML", page.code === 200 && /text\/html/.test(page.headers["content-type"] || ""), `code=${page.code}`);
  check("page embeds the clinic name", page.body.includes(seeded.name));
  check("page is RTL Arabic", /dir="rtl"/.test(page.body) && /lang="ar"/.test(page.body));
  check("page calls the public API", page.body.includes("/api/public/booking/"));
  check("page marked noindex", /noindex/.test(page.headers["x-robots-tag"] || ""));
  const badPage = await req("GET", "/booking/nope-not-real");
  check("unknown slug page explains itself", badPage.code === 200);

  // ── cleanup ──
  console.log("\n=== cleanup ===");
  const fresh = JSON.parse(fs.readFileSync(DB, "utf8"));
  if (created) fresh.appointments = fresh.appointments.filter((a) => a.id !== created.id);
  fresh.patients = fresh.patients.filter((p) => !(p.phone === phone && p.source === "booking"));
  fresh.messages = fresh.messages.filter((m) => m.message !== MSG);
  fresh.users = fresh.users.filter((u) => !createdUsers.includes(u.username));
  fresh.clinics = fresh.clinics.filter((c) => !createdClinics.includes(c.id));
  fresh.clinicSubscriptions = fresh.clinicSubscriptions.filter((s) => !createdClinics.includes(s.clinicId));
  fresh.sessions = {};
  fs.writeFileSync(DB, JSON.stringify(fresh, null, 2), "utf8");
  console.log(`   removed ${createdUsers.length} test users, ${createdClinics.length} test clinics, the test appointment/patient/message`);

  console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();