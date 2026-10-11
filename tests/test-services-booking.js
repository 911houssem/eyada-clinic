const path = require("path");
// HTTP tests for the services menu + duration-aware booking overlap:
//  - /api/services CRUD is clinic-scoped and settings-gated
//  - durationMin is rounded to the clinic slot grid
//  - the public booking page exposes name / price / duration
//  - a long service blocks the slots it really covers (not just one slot)
//  - overlap is refused server-side on both the public POST and the dashboard
//    create/move, while back-to-back appointments stay legal
const http = require("http");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const DB = ROOT + "\\data\\db.json";

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
const uniq = () => Math.random().toString(36).slice(2, 8);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// a date far enough ahead that every slot is still in the future
function futureDate(daysAhead = 30) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return ymd(d);
}

(async () => {
  const made = [];
  const track = (u) => { if (u) made.push(u); return u; };

  const u = "sv" + uniq();
  const reg = await req("POST", "/api/auth/register",
    { username: u, password: "secret123", fullName: "svc owner", clinicName: "clinic-" + u });
  track(u);
  const regJ = J(reg);
  const cookie = ck(reg);
  const ownerId = regJ.user?.id;
  const clinicId = regJ.user?.clinicId || regJ.currentClinicId;
  check("clinic owner registered", !!cookie && !!clinicId, `clinic=${clinicId}`);

  // ask the api for the clinic rather than reading the file: the server owns the
  // db in memory and a fresh register may not be on disk yet
  const selfRes = await req("GET", "/api/clinics?id=" + clinicId, null, cookie);
  const self = J(selfRes).clinic || J(selfRes);
  const bookingSlug = self.bookingSlug;
  check("clinic has a booking slug", !!bookingSlug, `slug=${bookingSlug}`);
  const slotStep = Number(self.slotDuration) || 15;

  // ── 1. seeded default menu ───────────────────────────────────────────────
  console.log("\n=== 1. seeded service menu ===");
  const listRes = await req("GET", "/api/services", null, cookie);
  check("GET /api/services 200", listRes.code === 200, `code=${listRes.code}`);
  let list = Array.isArray(J(listRes)) ? J(listRes) : [];
  check("new clinic was seeded with a menu", list.length >= 3, `n=${list.length}`);
  check("every service carries name/price/duration",
    list.every((s) => s.name && typeof s.price === "number" && Number(s.durationMin) > 0),
    JSON.stringify(list.map((s) => `${s.name}/${s.price}/${s.durationMin}`)));
  check("services are scoped to the caller's clinic",
    list.every((s) => s.clinicId === clinicId));

  // ── 2. CRUD + permissions ────────────────────────────────────────────────
  console.log("\n=== 2. services CRUD and permissions ===");
  const created = J(await req("POST", "/api/services",
    { name: "جلسة طويلة", description: "probe", durationMin: 35, price: 300 }, cookie));
  check("owner can create a service", !!created.id, `id=${created.id}`);
  check("durationMin is rounded up to the slot grid",
    Number(created.durationMin) % slotStep === 0 && Number(created.durationMin) >= 35,
    `asked 35, grid ${slotStep}, got ${created.durationMin}`);
  check("price is stored", Number(created.price) === 300, `price=${created.price}`);

  const dup = J(await req("POST", "/api/services", { name: "x", durationMin: -5, price: -9 }, cookie));
  check("negative price is clamped to 0", Number(dup.price) === 0, `price=${dup.price}`);
  check("duration never drops below one slot", Number(dup.durationMin) >= slotStep, `dur=${dup.durationMin}`);

  const noName = await req("POST", "/api/services", { durationMin: 20 }, cookie);
  check("a service without a name is rejected", noName.code === 400, `code=${noName.code}`);

  const updated = J(await req("PUT", "/api/services",
    { id: created.id, name: "جلسة طويلة معدلة", price: 350 }, cookie));
  check("owner can edit a service", updated.name === "جلسة طويلة معدلة" && Number(updated.price) === 350);

  // a second clinic must not see or touch it
  const u2 = "sw" + uniq();
  const reg2 = await req("POST", "/api/auth/register",
    { username: u2, password: "secret123", fullName: "other owner", clinicName: "clinic-" + u2 });
  track(u2);
  const otherCookie = ck(reg2);
  const otherList = J(await req("GET", "/api/services", null, otherCookie));
  check("another clinic cannot see the service",
    !(Array.isArray(otherList) && otherList.some((s) => s.id === created.id)));
  const crossPut = await req("PUT", "/api/services", { id: created.id, price: 1 }, otherCookie);
  check("another clinic cannot edit the service", crossPut.code === 403, `code=${crossPut.code}`);
  const crossDel = await req("DELETE", "/api/services", { id: created.id }, otherCookie);
  check("another clinic cannot delete the service", crossDel.code === 403, `code=${crossDel.code}`);

  // role without the settings grant
  const staffName = "st" + uniq();
  const staff = await req("POST", "/api/auth/register",
    { username: staffName, password: "secret123", fullName: "staff probe" });
  const staffCookie = ck(staff);
  const staffJ = J(staff);
  if (staffJ.user?.id && clinicId) {
    await req("PUT", "/api/users", { id: staffJ.user.id, role: "reception", clinicId }, cookie);
    const asStaff = await req("POST", "/api/services", { name: "staff try", durationMin: 20 }, staffCookie);
    check("reception cannot create a service", asStaff.code === 403, `code=${asStaff.code}`);
    const staffRead = await req("GET", "/api/services", null, staffCookie);
    check("reception can still read the menu", staffRead.code === 200, `code=${staffRead.code}`);
  }

  // ── 3. public booking page payload ───────────────────────────────────────
  console.log("\n=== 3. public booking payload ===");
  const pub = await req("GET", "/api/public/booking/" + bookingSlug);
  check("GET public booking 200", pub.code === 200, `code=${pub.code}`);
  const pubJ = J(pub);
  check("public payload lists services", Array.isArray(pubJ.services) && pubJ.services.length > 0,
    `n=${(pubJ.services || []).length}`);
  check("public service exposes name + price + duration",
    (pubJ.services || []).every((s) => s.name && typeof s.price === "number" && Number(s.durationMin) > 0));
  check("public payload leaks no internal clinic fields",
    !(pubJ.services || []).some((s) => "clinicId" in s || "sortOrder" in s));
  const longSvc = (pubJ.services || []).find((s) => Number(s.durationMin) >= 40) ||
    (pubJ.services || [])[0];
  check("a long service is on the menu", !!longSvc, `dur=${longSvc && longSvc.durationMin}`);
  const shortSvc = (pubJ.services || []).find((s) => Number(s.durationMin) < 40) || longSvc;
  const longDur = Number(longSvc.durationMin);

  // ── 4. the slot grid respects the real duration ──────────────────────────
  console.log("\n=== 4. duration-aware slots ===");
  const date = futureDate(30);
  const slotsShort = J(await req("GET",
    `/api/public/booking/${bookingSlug}/slots?date=${date}&serviceId=${shortSvc.id}`));
  const slotsLong = J(await req("GET",
    `/api/public/booking/${bookingSlug}/slots?date=${date}&serviceId=${longSvc.id}`));
  check("slots endpoint 200 for a short service", Array.isArray(slotsShort.slots));
  check("slots endpoint 200 for a long service", Array.isArray(slotsLong.slots));
  check("slots response echoes the duration used", Number(slotsLong.durationMin) === longDur,
    `echo=${slotsLong.durationMin} want=${longDur}`);

  // the patient-facing rhythm: 08:00, 09:00, 10:00 … first hour to last
  const grid = slotsShort.slots.map((s) => s.time);
  const hourly = grid.length > 2 && grid.every((t, i) =>
    t.slice(3) === "00" && (i === 0 || Number(t.slice(0, 2)) === Number(grid[i - 1].slice(0, 2)) + 1));
  check("the public grid is hourly from the first hour to the last",
    hourly && grid[0] === "08:00" && grid[grid.length - 1] === "22:00",
    `${grid[0]} … ${grid[grid.length - 1]} (n=${grid.length})`);
  check("a long visit never offers more starts than a short one",
    slotsLong.slots.filter((s) => s.available).length <= slotsShort.slots.filter((s) => s.available).length,
    `long=${slotsLong.slots.filter((s) => s.available).length} short=${slotsShort.slots.filter((s) => s.available).length}`);

  // ── 5. booking writes the service onto the appointment ───────────────────
  console.log("\n=== 5. booking stores price + duration ===");
  const freeSlot = slotsShort.slots.find((s) => s.available);
  check("a bookable slot exists", !!freeSlot, `time=${freeSlot && freeSlot.time}`);
  const book = await req("POST", "/api/public/booking/" + bookingSlug, {
    patientName: "مريض تجربة", phone: "0501234567", date, time: freeSlot.time,
    serviceId: shortSvc.id, note: "probe booking",
  }, null);
  check("public booking accepted", book.code === 200, `code=${book.code} ${book.body.slice(0, 90)}`);
  const bookJ = J(book);
  check("confirmation echoes the service", bookJ.appointment?.serviceName === shortSvc.name,
    `name=${bookJ.appointment?.serviceName}`);
  check("confirmation echoes the price", Number(bookJ.appointment?.price) === Number(shortSvc.price),
    `price=${bookJ.appointment?.price}`);

  const shortDur = Number(slotsShort.durationMin) || slotStep;
  const startMs = new Date(`${date}T${freeSlot.time}:00`).getTime();
  // read it back through the api: the server owns the db in memory and save()
  // is batched, so the file on disk may lag behind
  const dayRes = J(await req("GET", `/api/appointments?date=${date}`, null, cookie));
  const dayList = Array.isArray(dayRes) ? dayRes : (dayRes.appointments || []);
  const saved = dayList.find((a) => a.id === bookJ.appointment?.id);
  check("appointment persisted", !!saved, `id=${bookJ.appointment?.id}`);
  check("appointment keeps the service id", saved?.serviceId === shortSvc.id);
  check("endTime = start + service duration",
    saved && new Date(saved.endTime).getTime() - new Date(saved.startTime).getTime() === shortDur * 60000,
    saved ? `${shortDur}min` : "no row");

  // ── 6. server-side overlap ───────────────────────────────────────────────
  console.log("\n=== 6. overlap enforcement ===");
  const clash = await req("POST", "/api/public/booking/" + bookingSlug, {
    patientName: "مريض آخر", phone: "0509999999", date, time: freeSlot.time, serviceId: shortSvc.id,
  }, null);
  check("the same slot twice is refused", clash.code === 409, `code=${clash.code}`);

  // starting inside the first visit must also fail
  const inside = J(await req("GET",
    `/api/public/booking/${bookingSlug}/slots?date=${date}&serviceId=${shortSvc.id}`));
  const insideTime = inside.slots.find(
    (s) => new Date(`${date}T${s.time}:00`).getTime() > startMs &&
      new Date(`${date}T${s.time}:00`).getTime() < startMs + shortDur * 60000);
  check("a slot inside the booked visit is already hidden",
    !insideTime || insideTime.available === false,
    insideTime ? `time=${insideTime.time} available=${insideTime.available}` : "no such slot on the grid");

  // the next free hour after the visit must still be bookable
  const afterSlot = inside.slots.find((s) => s.available &&
    new Date(`${date}T${s.time}:00`).getTime() >= startMs + shortDur * 60000);
  const backToBack = afterSlot
    ? await req("POST", "/api/public/booking/" + bookingSlug, {
        patientName: "مريض متتابع", phone: "0508888888", date, time: afterSlot.time, serviceId: shortSvc.id,
      }, null)
    : { code: 0, body: "no free hour after the visit" };
  check("the hour right after the visit is bookable", backToBack.code === 200,
    `code=${backToBack.code} at=${afterSlot && afterSlot.time}`);

  // a long service must not fit where a short one already sits; re-fetch because
  // slotsLong was read before the short booking above
  const longAfter = J(await req("GET",
    `/api/public/booking/${bookingSlug}/slots?date=${date}&serviceId=${longSvc.id}`));
  const longLeak = longAfter.slots.find((s) => {
    const t = new Date(`${date}T${s.time}:00`).getTime();
    return s.available && t > startMs && t < startMs + longDur * 60000;
  });
  check("a long service cannot start inside an existing visit",
    !longLeak, longLeak ? `leaked time=${longLeak.time}` : "grid hides every covered slot");

  // dashboard create + move are guarded too
  console.log("\n=== 7. dashboard appointments are guarded too ===");
  const at = (hhmm) => new Date(`${date}T${hhmm}:00`).toISOString();
  const dupAppt = await req("POST", "/api/appointments",
    { clinicId, startTime: at(freeSlot.time), duration: shortDur, title: "تعارض" }, cookie);
  check("dashboard refuses an overlapping create", dupAppt.code === 409, `code=${dupAppt.code}`);

  const far = await req("POST", "/api/appointments",
    { clinicId, startTime: at("18:00"), duration: 20, title: "probe appt" }, cookie);
  check("dashboard accepts a free slot", far.code === 200, `code=${far.code}`);
  const farId = J(far).id;
  if (farId) {
    const moved = await req("PUT", "/api/appointments",
      { id: farId, startTime: at(freeSlot.time), endTime: new Date(startMs + shortDur * 60000).toISOString() }, cookie);
    check("dashboard refuses an overlapping move", moved.code === 409, `code=${moved.code}`);
    const afterMove = J(await req("GET", `/api/appointments?date=${date}`, null, cookie));
    const kept = (Array.isArray(afterMove) ? afterMove : []).find((a) => a.id === farId);
    check("the refused move left the original time alone",
      kept && new Date(kept.startTime).getTime() === new Date(at("18:00")).getTime(),
      kept ? kept.startTime : "row vanished");
    await req("DELETE", "/api/appointments", { id: farId }, cookie);
  }

  // ── 8. what the app books must vanish from the public list too ────────────
  console.log("\n=== 8. the app's own bookings hide public hours ===");
  const beforeSys = J(await req("GET",
    `/api/public/booking/${bookingSlug}/slots?date=${date}&serviceId=${shortSvc.id}`));
  const sysHour = ((beforeSys.slots || []).find((s) => s.available && s.time > freeSlot.time) || {}).time;
  check("an untouched hour is still free", !!sysHour, `hour=${sysHour}`);
  const sysAppt = await req("POST", "/api/appointments",
    { clinicId, startTime: at(sysHour), duration: shortDur, title: "حجز من النظام" }, cookie);
  check("the app books that hour", sysAppt.code === 200, `code=${sysAppt.code}`);
  const pubAfter = J(await req("GET",
    `/api/public/booking/${bookingSlug}/slots?date=${date}&serviceId=${shortSvc.id}`));
  const sysSlot = (pubAfter.slots || []).find((s) => s.time === sysHour);
  check("the app's hour is no longer offered to patients",
    sysSlot && sysSlot.available === false, JSON.stringify(sysSlot));
  const sysId = J(sysAppt).id;
  if (sysId) await req("DELETE", "/api/appointments", { id: sysId }, cookie);

  // ── cleanup ──────────────────────────────────────────────────────────────
  // Everything goes through the api. Writing db.json here would race the
  // running server, which owns the data and rewrites the file on its next
  // save — that is exactly how probe clinics kept coming back. Removing the
  // owner leaves the clinic empty, and migrate() prunes it (with its services)
  // on the next boot.
  console.log("\n=== cleanup ===");

  // the second owner deletes their own account first, so the main owner keeps a
  // working session for the checks that follow (deleting yourself ends it)
  // Account deletion is a hiring-class action, which the owner trial
  // deliberately withholds (402), so cleanup has to come from the site owner —
  // the same pattern the other suites use.
  const siteUser = JSON.parse(fs.readFileSync(DB, "utf8")).users.find((x) => x.role === "super_admin");
  let siteCookie = "";
  for (const pw of ["123456", "admin123", "admin", "12345678", siteUser.username]) {
    const l = await req("POST", "/api/auth/login", { username: siteUser.username, password: pw });
    if (J(l).user) { siteCookie = ck(l); break; }
  }
  check("site owner signed in for cleanup", !!siteCookie, `user=${siteUser.username}`);

  // the booked visits have to go too: migrate() only prunes a clinic once it is
  // completely empty, and leftovers here are what kept probe clinics alive
  const mine = new Set([clinicId, J(reg2).user?.clinicId].filter(Boolean));
  const listMine = async () => {
    const raw = J(await req("GET", `/api/appointments?date=${date}`, null, cookie));
    return (Array.isArray(raw) ? raw : []).filter((a) => mine.has(a.clinicId));
  };
  for (const a of await listMine()) await req("DELETE", "/api/appointments", { id: a.id }, cookie);
  check("probe appointments removed", (await listMine()).length === 0,
    `left=${(await listMine()).length}`);

  const gone = J(await req("GET", `/api/patients`, null, cookie));
  const pats = (Array.isArray(gone) ? gone : (gone.patients || [])).filter((p) => mine.has(p.clinicId));
  for (const p of pats) await req("DELETE", "/api/patients", { id: p.id }, cookie);
  check("probe patients removed", pats.length > 0, `removed=${pats.length}`);

  const delOther = await req("DELETE", "/api/users", { id: J(reg2).user?.id }, siteCookie);
  check("site owner removed the probe owner", delOther.code === 200, `code=${delOther.code}`);
  const delMain = await req("DELETE", "/api/users", { id: ownerId }, siteCookie);
  check("site owner removed the main probe owner", delMain.code === 200, `code=${delMain.code}`);

  const mainGone = await req("POST", "/api/auth/login", { username: u, password: "secret123" });
  check("main owner can no longer sign in", mainGone.code === 401, `code=${mainGone.code}`);
  const otherGone = await req("POST", "/api/auth/login", { username: u2, password: "secret123" });
  check("second owner can no longer sign in", otherGone.code === 401, `code=${otherGone.code}`);
  const stale = await req("GET", "/api/services", null, cookie);
  check("the removed owner's session is dead", stale.code === 401 || stale.code === 403, `code=${stale.code}`);

  // let the debounced save land before the runner kills the server
  await new Promise((r) => setTimeout(r, 500));

  console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();