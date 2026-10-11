const path = require("path");
// Checks the public booking page: the shell the tests have always asserted,
// plus the new service picker, the summary panel and the duration-aware wiring.
const http = require("http");
const fs = require("fs");
const DB = path.join(__dirname, "..", "data", "db.json");

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
      res.on("end", () => resolve({ code: res.statusCode, body: b, headers: res.headers, cookie: res.headers["set-cookie"] }));
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message, headers: {} }));
    r.on("timeout", () => { r.destroy(); resolve({ code: 0, body: "timeout", headers: {} }); });
    if (pay) r.write(pay); r.end();
  });
}
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
const ck = (r) => (r.cookie || []).map((x) => x.split(";")[0]).join("; ");
const uniq = () => Math.random().toString(36).slice(2, 8);

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const clinic = db.clinics.find((c) => c.bookingEnabled !== false && c.bookingSlug);
  check("a bookable clinic exists", !!clinic, `slug=${clinic && clinic.bookingSlug}`);
  if (!clinic) process.exit(1);
  const slug = clinic.bookingSlug;
  const services = db.services.filter((s) => s.clinicId === clinic.id && s.isActive !== false);
  check("that clinic has a service menu", services.length > 0, `n=${services.length}`);

  console.log("\n=== 1. page shell (the pre-existing contract) ===");
  const page = await req("GET", "/booking/" + slug);
  check("serves HTML", page.code === 200 && /text\/html/.test(page.headers["content-type"] || ""), `code=${page.code}`);
  check("embeds the clinic name", page.body.includes(clinic.name));
  check("is RTL Arabic", /dir="rtl"/.test(page.body) && /lang="ar"/.test(page.body));
  check("calls the public api", page.body.includes("/api/public/booking/"));
  check("marked noindex", /noindex/.test(page.headers["x-robots-tag"] || ""));

  console.log("\n=== 2. service picker ===");
  check("renders a service step", page.body.includes("اختر الخدمة"));
  check("posts the chosen serviceId", /serviceId:\s*state\.serviceId/.test(page.body));
  check("asks the server for duration-aware slots", /serviceId=\"\s*\+\s*encodeURIComponent\(state\.serviceId\)/.test(page.body));
  check("shows the price of each service", page.body.includes("money(s.price)"));
  check("shows the duration of each service", page.body.includes("mins(s.durationMin)"));
  check("reloads slots when the service changes", /paintServices\(\);\s*\n?\s*loadSlots\(\)/.test(page.body));
  for (const s of services) {
    check("service reaches the client payload", (J(await req("GET", "/api/public/booking/" + slug)).services || []).some((x) => x.id === s.id), s.name);
  }

  console.log("\n=== 3. summary + confirmation ===");
  check("has a summary panel", page.body.includes("ملخّص الموعد"));
  check("summary totals the price", /الإجمالي المتوقع/.test(page.body));
  check("summary lists the duration", /row2.*المدة/s.test(page.body));
  check("groups slots by part of day", page.body.includes("صباحاً") && page.body.includes("مساءً"));
  check("tells the patient how many slots are open", page.body.includes("وقت متاح من"));
  check("shows a confirmation screen", page.body.includes("تم استلام طلب الحجز") && page.body.includes("رقم الطلب"));
  check("confirmation repeats the price and duration", page.body.includes("money(a.price)") && page.body.includes("mins(a.durationMin)"));
  check("refreshes the grid on a 409", /r\.status === 409\) loadSlots\(\)/.test(page.body));
  check("offers to book again", page.body.includes("حجز موعد آخر"));

  console.log("\n=== 4. robustness ===");
  const bad = await req("GET", "/booking/nope-not-real");
  check("unknown slug still answers 200", bad.code === 200, `code=${bad.code}`);
  check("unknown slug explains itself", bad.body.includes("الحجز غير متاح"));
  const unknownInCode = bad.body.includes("/api/public/booking/null");
  check("an unknown slug never builds a live api url", !unknownInCode || bad.body.includes("D.slug"));

  // the page must not ship a syntax error: run its inline script through node
  const scripts = page.body.match(/<script>([\s\S]*?)<\/script>/g) || [];
  check("page has one inline script", scripts.length === 1, `n=${scripts.length}`);
  const code = scripts[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
  // the template injects the data object; make it valid standalone js
  const runnable = code.replace(/const D = .*?;\n/, 'const D = { slug: "x", name: "y", daysAhead: 90 };\n');
  let parseErr = "";
  try { new Function(runnable); } catch (e) { parseErr = e.message; }
  check("inline script parses", !parseErr, parseErr);
  check("no template literals leaked into the client code", !/=>\s*`|`/.test(code));

  console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();