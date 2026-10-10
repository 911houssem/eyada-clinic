// Final state report + assertions. Run against a freshly booted server so
// migrate() has already had its chance to prune and repair.
const fs = require("fs");
const http = require("http");
const DB = "C:\\Users\\911ho\\Desktop\\bank\\data\\db.json";
const BUNDLE = "C:\\Users\\911ho\\Desktop\\bank\\_next\\static\\chunks\\1fds2h4vn64um.js";
const db = JSON.parse(fs.readFileSync(DB, "utf8"));

let pass = 0, fail = 0;
const check = (n, c, e = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${e ? "   " + e : ""}`); c ? pass++ : fail++; };
const get = (p) => new Promise((res) => {
  const r = http.request({ port: 3000, path: p, method: "GET", timeout: 8000 }, (x) => {
    let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res({ code: x.statusCode, body: b, h: x.headers }));
  });
  r.on("error", (e) => res({ code: 0, body: e.message, h: {} })); r.end();
});

(async () => {
  const h = await get("/api/health");
  console.log("health:", h.code, h.body.trim());

  console.log("\n=== accounts ===");
  for (const u of db.users) {
    console.log(`  ${u.username.padEnd(11)} ${u.role.padEnd(11)} ${(db.clinics.find((c) => c.id === u.clinicId) || {}).name || "-"}`);
  }

  console.log("\n=== clinics ===");
  for (const c of db.clinics) {
    const slugOk = /^[a-z0-9][a-z0-9-]*$/.test(c.bookingSlug || "");
    const ownOk = db.users.some((u) => u.id === c.ownerId);
    const svc = db.services.filter((s) => s.clinicId === c.id).length;
    console.log(`  ${(c.name || "").padEnd(22)} /booking/${(c.bookingSlug || "").padEnd(16)} slug=${slugOk ? "ok" : "BAD"} owner=${ownOk ? "ok" : "BAD"} booking=${c.bookingEnabled} services=${svc}`);
  }

  console.log(`\npatients: ${db.patients.length}  invoices: ${db.invoices.length}  appointments: ${db.appointments.length}  services: ${db.services.length}  sessions: ${Object.keys(db.sessions || {}).length}`);

  console.log("\n=== residue ===");
  const PROBE = /^(probe|test|tmp|own|staff|esc|sv|sw|ta|tb|zz)[a-z0-9]*$/i;
  const junk = db.users.filter((u) => PROBE.test(u.username));
  const junkC = db.clinics.filter((c) => /عيادة الاختبار|^own|^clinic-own|^clinic-(sv|sw|ta|tb|zz)/i.test(c.name || ""));
  const junkP = db.patients.filter((p) => p.source === "booking");
  check("no probe users", junk.length === 0, junk.map((u) => u.username).join(","));
  check("no probe clinics", junkC.length === 0, junkC.map((c) => c.name).join(","));
  check("no leftover booking patients", junkP.length === 0, `${junkP.length}`);

  console.log("\n=== integrity ===");
  const cids = new Set(db.clinics.map((c) => c.id));
  const orphan = (k) => db[k].filter((r) => r.clinicId && !cids.has(r.clinicId)).length;
  for (const k of ["services", "tasks", "patients", "appointments", "inventory", "records", "invoices", "clinicSubscriptions"]) {
    check(`no orphan ${k}`, (db[k] || []).filter((r) => r.clinicId && !cids.has(r.clinicId)).length === 0, `${orphan(k)}`);
  }
  check("every clinic owner resolves", db.clinics.every((c) => !c.ownerId || db.users.some((u) => u.id === c.ownerId)));
  check("every clinic has a url-safe slug", db.clinics.every((c) => /^[a-z0-9][a-z0-9-]*$/.test(c.bookingSlug || "")));
  check("slugs are unique", new Set(db.clinics.map((c) => c.bookingSlug)).size === db.clinics.length);
  check("every bookable clinic has a menu", db.clinics.filter((c) => c.bookingEnabled !== false)
    .every((c) => db.services.some((s) => s.clinicId === c.id && s.isActive !== false)));
  check("exactly one site owner", db.users.filter((u) => u.role === "super_admin").length === 1);
  check("sessions is a map, not a list", db.sessions && typeof db.sessions === "object" && !Array.isArray(db.sessions));
  check("every appointment has an end after its start", db.appointments.every((a) =>
    !a.startTime || !a.endTime || new Date(a.endTime) >= new Date(a.startTime)));
  const overlap = [];
  for (const c of db.clinics) {
    const list = db.appointments.filter((a) => a.clinicId === c.id && !["cancelled", "canceled"].includes(String(a.status)) && a.doctorId)
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (prev.doctorId === cur.doctorId && new Date(prev.endTime) > new Date(cur.startTime))
        overlap.push(`${c.name}: ${prev.startTime}/${prev.endTime} vs ${cur.startTime}`);
    }
  }
  check("no doctor is double-booked", overlap.length === 0, overlap.join(" | "));

  console.log("\n=== live pages ===");
  const page = await get("/booking/al-noor-clinic");
  check("booking page serves", page.code === 200 && /text\/html/.test(page.h["content-type"] || ""), `code=${page.code}`);
  check("booking page is rtl arabic", /dir="rtl"/.test(page.body) && /lang="ar"/.test(page.body));
  check("booking page is noindex", /noindex/.test(page.h["x-robots-tag"] || ""));
  check("booking page offers a service picker", page.body.includes("اختر الخدمة"));
  const nope = await get("/booking/nope");
  check("unknown slug explains itself", nope.code === 200 && nope.body.includes("الحجز غير متاح"));
  const pub = await get("/api/public/booking/al-noor-clinic");
  check("public booking api serves services", Array.isArray(JSON.parse(pub.body).services));

  console.log("\n=== bundle ===");
  const themed = fs.readFileSync(BUNDLE, "utf8");
  check("bundle has no U+FFFD", !themed.includes("\uFFFD"));
  // markers patch-ui7 actually wrote, so a lost patch fails loudly here
  check("bundle owner panel heading present", themed.includes("حالة الاشتراك"));
  check("bundle owner panel note present",
    themed.includes("تفعيل الاشتراك أو تجديده أو تغيير الخطة يتم عبر فريق الدعم."));
  check("bundle support button present", themed.includes("fixed bottom-6 left-6"));
  check("bundle support mailto present", themed.includes("911houssem@gmail.com"));
  check("owner panel appears exactly once", themed.split("حالة الاشتراك").length - 1 === 1);
  console.log(`  init=${themed.includes('localStorage.getItem("theme")')} persist=${themed.includes('localStorage.setItem("theme","light")')}`);
  const serverSrc = fs.readFileSync("C:\\Users\\911ho\\Desktop\\bank\\server.js", "utf8");
  check("server.js has no U+FFFD", !serverSrc.includes("\uFFFD"));

  console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();