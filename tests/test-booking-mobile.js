/** Mobile-width sanity pass: the same page at 420px must still render everything. */
const { spawnSync } = require("child_process");

const { CHROME } = require("./cdp.js");
const URL = "http://127.0.0.1:3000/booking/al-noor-clinic";

let pass = 0, fail = 0;
const check = (n, c, e = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${e ? "   " + e : ""}`); c ? pass++ : fail++; };

const r = spawnSync(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--virtual-time-budget=8000", "--window-size=420,1600", "--dump-dom", URL,
], { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });

const dom = (r.stdout || "").replace(/<script>[\s\S]*?<\/script>/g, "");
check("mobile dom rendered", dom.length > 2000, `len=${dom.length}`);
const c = (re) => (dom.match(re) || []).length;
check("form present", /<form id="f"/.test(dom));
check("service cards present", c(/class="svc[ "]/g) === 3, `n=${c(/class="svc[ "]/g)}`);
  check("slots present", (c(/data-t="/g) > 0 || c(/next-card/g) > 0), `n=${c(/data-t="/g)} times, next=${c(/next-card/g)}`);
  check("summary present", dom.includes("ملخّص الموعد"));
  check("hero present", /<h1 id="hname">/.test(dom));
  check("no error state", !/تعذّر تحميل/.test(dom));

// the single-column layout is a media query, so just prove it is in the css
const page = r.stdout || "";
  check("responsive breakpoint exists", /@media\(min-width:600px\)/.test(page) || /@media\(min-width:880px\)/.test(page));
check("mobile-first single column is the default", /grid-template-columns:1fr;/.test(page));
// max-width/min-width are safe at any viewport; only a hard width would overflow
const hardWidth = page.match(/(?<![a-z-])width:\s*\d{3,}px/g) || [];
check("no hard width that could overflow a narrow screen", hardWidth.length === 0,
  hardWidth.join(", "));

console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
process.exit(fail ? 1 : 0);