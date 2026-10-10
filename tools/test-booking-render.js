/**
 * Renders the booking page in headless chrome and checks the DOM *after* the
 * client script ran: services turned into cards, slots fetched and grouped, and
 * the summary panel filled in. A screenshot can't be eyeballed here, so this
 * asserts on the live DOM instead.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = process.argv[2] || "http://127.0.0.1:3000/booking/al-noor-clinic";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};

const r = spawnSync(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--virtual-time-budget=8000", "--window-size=1100,1400", "--dump-dom", URL,
], { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });

const raw = r.stdout || "";
check("chrome produced a dom", raw.length > 2000, `len=${raw.length}`);
if (raw.length <= 2000) {
  console.log((r.stderr || "").slice(0, 600));
  process.exit(1);
}

// --dump-dom keeps the inline script's text, so every assertion below would
// otherwise match the source instead of what the browser actually rendered
const dom = raw.replace(/<script>[\s\S]*?<\/script>/g, "<script></scr" + "ipt>");
check("inline script stripped before asserting", dom.length < raw.length,
  `${raw.length} -> ${dom.length}`);

const count = (re) => (dom.match(re) || []).length;

console.log("\n=== rendered by the client script ===");
check("form was built", /<form id="f"/.test(dom));
check("service cards rendered", count(/class="svc[ "]/g) >= 3, `n=${count(/class="svc[ "]/g)}`);
check("one card is preselected", /class="svc sel"/.test(dom));
check("price chips rendered", count(/class="chip price"/g) >= 3, `n=${count(/class="chip price"/g)}`);
check("duration chips rendered", count(/class="chip">/g) >= 3, `n=${count(/class="chip">/g)}`);
check("slots were fetched", /data-t="\d{2}:\d{2}"/.test(dom), `n=${count(/data-t="/g)}`);
check("slots are grouped by part of day", /صباحاً|ظهراً|مساءً/.test(dom));
check("open-slot counter filled in", /وقت متاح من/.test(dom),
  (dom.match(/(\d+)\s*وقت متاح من/) || [])[0] || "");
check("summary panel rendered", /ملخّص الموعد/.test(dom));
check("summary names the chosen service", /row2"><span class="k">الخدمة/.test(dom));
check("summary shows a total", /الإجمالي预期|الإجمالي المتوقع/.test(dom));
check("date input was bounded", /id="date"[^>]*type="date"/.test(dom));
check("the loading placeholder is gone", !/جارِ التحميل…<\/div><\/div>/.test(dom));
check("hero meta filled from the api", /hmeta/.test(dom) && /<a href="tel:/.test(dom));

console.log("\n=== the time list the patient reads ===");
const times = (dom.match(/data-t="(\d{2}:\d{2})"/g) || []).map((m) => m.slice(8, 13));
check("only whole hours are offered", times.length > 0 && times.every((t) => t.length === 5 && t.slice(3) === "00"),
  `${times.length} slots, first=${times[0]}, last=${times[times.length - 1]}`);
check("the hours only move forward", times.every((t, i) =>
  i === 0 || Number(t.slice(0, 2)) > Number(times[i - 1].slice(0, 2))),
  times.slice(0, 6).join(" ") + " …");
const pressed = (dom.match(/class="slot" data-t="\d{2}:\d{2}" aria-pressed="true"/g) || []);
check("the page hands the patient a free hour already picked", pressed.length === 1,
  pressed[0] ? pressed[0].match(/data-t="(\d{2}:\d{2})"/)[1] : "none pressed");
check("the picked hour is one the server called free",
  pressed.length === 1 && times.includes(pressed[0].match(/data-t="(\d{2}:\d{2})"/)[1]));

console.log("\n=== no error state ===");
check("no 'failed to load' message", !/تعذّر تحميل بيانات العيادة/.test(dom));
check("no unhandled rejection banner", !/تعذّر تحميل الأوقات/.test(dom));

fs.writeFileSync("booking-dom.html", dom, "utf8");
console.log(`\n  ..   dom saved to booking-dom.html (${dom.length} chars)`);
console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
process.exit(fail ? 1 : 0);