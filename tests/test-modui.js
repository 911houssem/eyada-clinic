const path = require("path");
﻿/* End-to-end check of the owner's "وحدات العيادات" picker:
 *  - the subscriptions screen shows the card with one chip per module
 *  - switching المواعيد off for a clinic drops it from that clinic's sidebar
 *  - switching it back on brings the menu item (and its API) back
 * A throw-away staff account is hired for the run and removed afterwards.
 */
const http = require("http");
const fs = require("fs");
const { launch, newPage, sleep } = require("./cdp.js");

const DB = path.join(__dirname, "..", "data", "db.json");
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

const nav = (page) => page.eval(`[...document.querySelectorAll("aside button, nav button")].map(b=>b.textContent.trim())`);
const screen = (page) => page.eval(`document.body.innerText`);

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const ownerRow = db.users.find((u) => u.role === "super_admin");
  const ownerToken = await login(ownerRow.username, ["admin123", "123456", "admin"]);
  check("site owner session", !!ownerToken, ownerRow.username);
  if (!ownerToken) return done();
  const oc = "eyada_session=" + ownerToken;

  const sub = db.clinicSubscriptions.find((s) => s.status === "active");
  const clinic = db.clinics.find((c) => c.id === sub.clinicId);
  const tmpName = "modui_" + Date.now().toString(36);
  const hire = await req("POST", "/api/users", {
    username: tmpName, password: "modtest1", fullName: "موظف الواجهة",
    role: "reception", clinicId: clinic.id,
  }, oc);
  const staffId = J(hire).id;
  check("hired a throw-away staff account", !!staffId, tmpName + " in " + clinic.name);

  const staffToken = staffId ? await login(tmpName, ["modtest1"]) : "";
  check("staff session", !!staffToken, tmpName);
  if (!staffId || !staffToken) return done();

  const chrome = await launch();
  const page = await newPage(chrome.port);
  await page.send("Network.enable");
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const drain = (tag) => {
    for (const ev of page.events.splice(0)) {
      if (ev.method === "Runtime.exceptionThrown") {
        const d = ev.params.exceptionDetails;
        console.log("    " + tag + " EXCEPTION: " + (d.exception && d.exception.description || d.text));
      }
    }
  };

  try {
    /* ── owner: the subscriptions screen ── */
    await page.send("Network.setCookie", { name: "eyada_session", value: ownerToken, domain: "127.0.0.1", path: "/" });
    await page.send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await sleep(6000);
    drain("[boot]");

    await page.eval(`(()=>{const b=[...document.querySelectorAll("aside button, nav button")].find(x=>x.textContent.includes("الاشتراكات"));if(b)b.click();return !!b})()`);
    await sleep(3000);
    drain("[subs]");

    const card = await page.eval(`(()=>{
      const t=document.body.innerText;
      const cards=[...document.querySelectorAll("div")].filter(d=>String(d.className).includes("glass-card-v2 rounded-xl p-4"));
      const mine=cards.find(d=>d.textContent.includes(${JSON.stringify(clinic.name)}));
      const chips=mine?[...mine.querySelectorAll("button")].map(b=>({t:b.textContent.trim(),off:String(b.className).includes("opacity-70")})):[];
      return {heading:t.includes("وحدات العيادات"), hasCard:!!mine, count:chips.length, chips,
              hint:t.includes("مثل الصلاحيات")};
    })()`);
    check("وحدات العيادات card on the subscriptions screen", card.heading === true);
    check("the clinic is listed there", card.hasCard === true, clinic.name);
    check("one chip per module", card.count === 8, "count=" + card.count);
    const apptChip = card.chips.find((c) => c.t.includes("المواعيد"));
    check("المواعيد chip present and on", !!apptChip && apptChip.off === false, JSON.stringify(apptChip));

    const toggled = await page.eval(`(()=>{
      const cards=[...document.querySelectorAll("div")].filter(d=>String(d.className).includes("glass-card-v2 rounded-xl p-4"));
      const mine=cards.find(d=>d.textContent.includes(${JSON.stringify(clinic.name)}));
      const b=mine?[...mine.querySelectorAll("button")].find(x=>x.textContent.includes("المواعيد")):null;
      if(!b) return {ok:false,why:"no chip"};
      b.click(); return {ok:true};
    })()`);
    await sleep(3500);
    check("chip clicked", toggled.ok === true, JSON.stringify(toggled));

    const after = await page.eval(`(async()=>{
      const cards=[...document.querySelectorAll("div")].filter(d=>String(d.className).includes("glass-card-v2 rounded-xl p-4"));
      const mine=cards.find(d=>d.textContent.includes(${JSON.stringify(clinic.name)}));
      const b=mine?[...mine.querySelectorAll("button")].find(x=>x.textContent.includes("المواعيد")):null;
      return b?{text:b.textContent.trim(),off:String(b.className).includes("opacity-70")}:{text:"missing"};
    })()`);
    check("chip flips to off", after.off === true, JSON.stringify(after));

    /* ── staff: the sidebar loses the section ── */
    const st0 = J(await req("GET", "/api/auth/me", null, "eyada_session=" + staffToken));
    check("staff permission is off after the click", st0.user.permissions.appointments === false);

    const p2 = await newPage(chrome.port);
    await p2.send("Network.enable"); await p2.send("Page.enable"); await p2.send("Runtime.enable");
    await p2.send("Network.setCookie", { name: "eyada_session", value: staffToken, domain: "127.0.0.1", path: "/" });
    await p2.send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await sleep(6000);
    const navOff = await nav(p2);
    check("staff sidebar hides المواعيد", !navOff.some((t) => t.includes("المواعيد")), JSON.stringify(navOff));
    check("the rest of the sidebar is intact", navOff.some((t) => t.includes("المرضى")) && navOff.some((t) => t.includes("الفواتير")));

    /* ── owner turns it back on ── */
    await req("PUT", `/api/clinic-subscriptions/${sub.id}`, { modules: {} }, oc);
    const st1 = J(await req("GET", "/api/auth/me", null, "eyada_session=" + staffToken));
    check("staff permission is back", st1.user.permissions.appointments === true);

    await p2.send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await sleep(6000);
    const navOn = await nav(p2);
    check("staff sidebar shows المواعيد again", navOn.some((t) => t.includes("المواعيد")), JSON.stringify(navOn));

    p2.close();
  } catch (e) {
    check("no crash", false, String(e && e.message || e));
  } finally {
    await req("PUT", `/api/clinic-subscriptions/${sub.id}`, { modules: {} }, oc);
    const del = await req("DELETE", "/api/users", { id: staffId }, oc);
    check("throw-away account removed", del.code === 200, "code=" + del.code + " " + (J(del).error || ""));
    page.close();
    chrome.proc.kill();
    done();
  }

  function done() {
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
