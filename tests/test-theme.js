// Verify the patched theme handlers behave correctly in a fake DOM.
const fs = require("fs");
const vm = require("vm");
const FILE = "C:\\Users\\911ho\\OneDrive\\Desktop\\clinic\\eyada-clinic-main\\_next\\static\\chunks\\1fds2h4vn64um.js";
const src = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
const check = (n, c, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "   " + x : ""}`); c ? pass++ : fail++; };

// pull the three patched code fragments out of the bundle and run them
const landingInit = src.match(/\[l,c\]=\(0,d\.useState\)\((function\(\)\{try\{var e=localStorage[\s\S]*?\}\(\))\)/);
const landingEffect = src.match(/\(\)=>\{l\?\(document\.documentElement\.classList\.add\("dark"\),localStorage\.setItem\("theme","dark"\)\):\(document\.documentElement\.classList\.remove\("dark"\),localStorage\.setItem\("theme","light"\)\)\}/);
const appToggle = src.match(/let s=\(\)=>\{let e=!document\.documentElement\.classList\.contains\("dark"\);o\(e\),e\?\([\s\S]*?setItem\("theme","light"\)\)\}/);

check("landing init expression found", !!landingInit);
check("landing persist effect found", !!landingEffect);
check("app toggle reads html class", !!appToggle);

// 1) initial state resolution
const initOf = (stored, systemDark) => {
  const store = {};
  if (stored) store.theme = stored;
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = v) };
  const documentElement = { classList: { add() {}, remove() {} } };
  const window = { matchMedia: (q) => ({ matches: q.includes("dark") ? systemDark : false }) };
  return { value: vm.runInNewContext("(" + landingInit[1] + ")", { localStorage, documentElement, window }), store };
};
check("stored 'dark' -> dark", initOf("dark", false).value === true);
check("stored 'light' -> light", initOf("light", true).value === false);
check("nothing stored + system dark -> dark", initOf(null, true).value === true);
check("nothing stored + system light -> light", initOf(null, false).value === false);
check("garbage stored -> follows system", initOf("banana", true).value === true);

// 2) landing effect writes the choice
const runLanding = (l) => {
  const store = {};
  const localStorage = { getItem: () => null, setItem: (k, v) => (store[k] = v) };
  const doc = { classList: { list: [], add(c) { this.list.push(c); }, remove(c) { this.list = this.list.filter((x) => x !== c); } } };
  vm.runInNewContext("(" + landingEffect[0] + ")()", { localStorage, document: { documentElement: doc }, documentElement: doc, l });
  return { cls: doc.classList.list, stored: store.theme };
};
let r = runLanding(true);
check("landing dark -> adds .dark + stores 'dark'", r.cls.includes("dark") && r.stored === "dark", JSON.stringify(r));
r = runLanding(false);
check("landing light -> removes .dark + stores 'light'", !r.cls.includes("dark") && r.stored === "light", JSON.stringify(r));

// 3) app toggle flips from the DOM class, not stale state
const runToggle = (domDark, staleState) => {
  const store = {};
  const localStorage = { setItem: (k, v) => (store[k] = v) };
  const doc = { classList: { hasDark: domDark, contains(c) { return c === "dark" && this.hasDark; }, add(c) { this.hasDark = true; }, remove() { this.hasDark = false; } } };
  let became;
  const o = (v) => (became = v);
  const i = staleState;
  vm.runInNewContext(appToggle[0].replace("let s=", "var s; s=") + "; s();", { localStorage, document: { documentElement: doc }, documentElement: doc, o, i });
  return { became, hasDark: doc.classList.hasDark, stored: store.theme };
};
let t = runToggle(false, true); // stale state said dark, DOM said light
check("DOM=light + stale=true -> turns DARK", t.became === true && t.hasDark === true && t.stored === "dark", JSON.stringify(t));
t = runToggle(true, false); // stale state said light, DOM said dark
check("DOM=dark + stale=false -> turns LIGHT", t.became === false && t.hasDark === false && t.stored === "light", JSON.stringify(t));
t = runToggle(true, true);
check("DOM=dark + stale=true -> stays light (no desync)", t.became === false && t.hasDark === false);
t = runToggle(false, false);
check("DOM=light + stale=false -> turns dark", t.became === true && t.hasDark === true);

console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
process.exit(fail ? 1 : 0);