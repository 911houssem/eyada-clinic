const path = require("path");
/* Proves the new appointments feature end to end:
 *   - the owner picks which of HIS OWN services the visit is for
 *   - the duration display follows that service
 *   - the start-time list chains the day by that duration (08:00, 08:20, 08:40 …)
 *   - a booked slot disappears from the list afterwards
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
      res.on("end", () => resolve({ code: res.statusCode, body: b, cookie: res.headers["set-cookie"] }));
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message }));
    r.on("timeout", () => { r.destroy(); resolve({ code: 0, body: "timeout" }); });
    if (pay) r.write(pay); r.end();
  });
}
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
const settle = () => sleep(800);

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

const mins = (t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const clinic = db.clinics.find((c) => c.name && c.name.includes("النور")) || db.clinics[0];
  const ownerCandidates = [
    db.users.find((u) => u.username === "houssem"),
    db.users.find((u) => u.role === "super_admin"),
    db.users.find((u) => u.clinicId === clinic.id && u.role === "admin"),
  ].filter(Boolean);
  let ownerToken = "", ownerName = "";
  for (const row of ownerCandidates) {
    const t = await login(row.username, ["houssem123", "123456", "admin"]);
    if (t) { ownerToken = t; ownerName = row.username; break; }
  }
  check("owner session token obtained", !!ownerToken, "user=" + ownerName + " clinic=" + clinic.name);
  if (!ownerToken) return done();
  const cookie = "eyada_session=" + ownerToken;

  const menu = J(await req("GET", `/api/services?clinicId=${clinic.id}&all=true`, null, cookie));
  const svcList = Array.isArray(menu) ? menu : [];
  check("clinic menu loaded from the api", svcList.length > 0, "n=" + svcList.length);
  if (!svcList.length) return done();
  const target = svcList.find((s) => Number(s.durationMin) === 20) || svcList[0];
  const dur = Number(target.durationMin) || 15;

  const chrome = await launch();
  console.log("chrome up on " + chrome.port);
  const created = [];
  try {
    const page = await newPage(chrome.port);
    for (const m of ["Network.enable", "Page.enable", "Runtime.enable"]) await page.send(m).catch(() => {});
    await page.send("Log.enable").catch(() => {});
    await page.send("Network.setCookie", { name: "eyada_session", value: ownerToken, domain: "127.0.0.1", path: "/" });
    await page.send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await sleep(6000);

    await page.eval(`(()=>{const b=[...document.querySelectorAll("aside button, nav button")].find(x=>x.textContent.includes("المواعيد"));if(b)b.click();return !!b})()`);
    await sleep(2500);
    const view = await page.eval(`(()=>({title:document.body.innerText.includes("المواعيد"),newBtn:[...document.querySelectorAll("button")].some(b=>b.textContent.includes("موعد جديد"))}))()`);
    check("appointments screen opened", view.title && view.newBtn, JSON.stringify(view));

    await page.eval(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("موعد جديد"));if(b)b.click();return !!b})()`);
    await sleep(2000);

    const form = await page.eval(`(()=>{
      const sels=[...document.querySelectorAll("select")];
      const byLabel=(t)=>{const l=[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith(t));return l?l.parentElement.querySelector("select"):null};
      const svc=byLabel("الخدمة"), st=byLabel("وقت البداية");
      const opts=(x)=>x?[...x.options].map(o=>o.value):[];
      return {
        hasService:!!svc, serviceValues:opts(svc),
        serviceLabels:svc?[...svc.options].map(o=>o.textContent.trim()):[],
        hasStart:!!st, startValues:opts(st),
        durationText:[...document.querySelectorAll(".bg-muted\\\\/40, [class*=bg-muted]")].map(e=>e.innerText).join(" | "),
        doctors:sels.length,
      };
    })()`);
    check("service picker present in the form", form.hasService, JSON.stringify(form.serviceLabels.slice(0, 5)));
    check("service picker lists this clinic's menu",
      form.serviceValues.includes(target.id), "id=" + target.id);
    check("start-time select present", form.hasStart, "options=" + form.startValues.length);

    /* the owner asked for the services menu inside نوع الموعد as well, so the
     * same visit can be booked from either field without them disagreeing */
    const typeSel = await page.eval(`(()=>{
      const l=[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith("نوع الموعد"));
      const s=l&&l.parentElement.querySelector("select");
      if(!s) return {found:false};
      const g=[...s.querySelectorAll("optgroup")];
      return {found:true, value:s.value,
        base:[...s.options].filter(o=>!o.closest("optgroup")).map(o=>o.textContent.trim()),
        groups:g.map(x=>x.label),
        groupIds:g.map(x=>[...x.querySelectorAll("option")].map(o=>o.value))};
    })()`);
    check("نوع الموعد select present", typeSel.found === true);
    check("clinic services offered as a second group",
      (typeSel.groups || []).includes("خدمات العيادة"), JSON.stringify(typeSel.groups));
    check("the four default types survive", ["عادي", "متابعة", "طوارئ", "استشارة"].every((t) => (typeSel.base || []).includes(t)),
      JSON.stringify(typeSel.base));
    const listed = typeSel.groupIds && typeSel.groupIds[0] || [];
    check("every registered service is listed", svcList.every((s) => listed.includes(s.name)),
      JSON.stringify(listed.slice(0, 6)));

    await page.eval(`(()=>{const l=[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith("نوع الموعد"));
      const s=l&&l.parentElement.querySelector("select"); if(s){s.value=${JSON.stringify(target.name)};
      s.dispatchEvent(new Event("change",{bubbles:true}));} return !!s})()`);
    await sleep(900);
    const typeAfter = await page.eval(`(()=>{
      const lab=(t)=>[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith(t));
      const s=lab("نوع الموعد")&&lab("نوع الموعد").parentElement.querySelector("select");
      const opt=s?s.options[s.selectedIndex]:null;
      const m=opt&&opt.textContent.match(/(\\d+)\\s*دقيقة/);
      const t=lab("وقت البداية")&&lab("وقت البداية").parentElement.querySelector("select");
      return {picked:opt?opt.textContent.trim():"", declared:m?Number(m[1]):null,
        duration:[...document.querySelectorAll(".bg-muted\\\\/40, [class*=bg-muted]")].map(e=>e.innerText).join(" | "),
        values:t?[...t.options].map(o=>o.value):[]};
    })()`);
    check("picking a service from نوع الموعد drives the duration",
      typeAfter.declared !== null && typeAfter.duration.includes(typeAfter.declared + " دقيقة"),
      JSON.stringify({ picked: typeAfter.picked, duration: typeAfter.duration.slice(-60) }));
    check("…and re-chains the start times",
      typeAfter.values.length >= 3 && mins(typeAfter.values[1]) - mins(typeAfter.values[0]) === typeAfter.declared,
      typeAfter.values.slice(0, 4).map((t) => t.slice(11)).join(", "));

    const before = form.startValues;
    const chained = before.length >= 3 &&
      before[0].slice(11) === "08:00" &&
      mins(before[1]) - mins(before[0]) === 15 &&
      mins(before[2]) - mins(before[1]) === 15;
    check("slots chain back to back (default duration)",
      chained, before.slice(0, 4).map((t) => t.slice(11)).join(", "));

    // pick the service -> duration + slots must follow it
    await page.eval(`(()=>{const l=[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith("الخدمة"));
      const s=l&&l.parentElement.querySelector("select"); if(s){s.value=${JSON.stringify(target.id)};s.dispatchEvent(new Event("change",{bubbles:true}));} return !!s})()`);
    await sleep(900);

    const after = await page.eval(`(()=>{
      const l=[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith("وقت البداية"));
      const s=l&&l.parentElement.querySelector("select");
      const d=[...document.querySelectorAll(".bg-muted\\\\/40, [class*=bg-muted]")].map(e=>e.innerText).join(" | ");
      return {values:s?[...s.options].map(o=>o.value):[], duration:d};
    })()`);
    check("duration display follows the chosen service", after.duration.includes(dur + " دقيقة"), JSON.stringify(after.duration));
    const chained2 = after.values.length >= 3 &&
      mins(after.values[1]) - mins(after.values[0]) === dur &&
      mins(after.values[2]) - mins(after.values[1]) === dur;
    check("slot list re-anchors to the service duration", chained2,
      after.values.slice(0, 4).map((t) => t.slice(11)).join(", "));

    // choose a patient + doctor, book the first free slot
    const preRows = J(await req("GET", `/api/appointments?clinicId=${clinic.id}`, null, cookie));
    const beforeIds = (Array.isArray(preRows) ? preRows : []).map((a) => a.id);
    const filled = await page.eval(`(async()=>{
      const lab=(t)=>[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith(t));
      const set=(t,val)=>{const l=lab(t),s=l&&l.parentElement.querySelector("select");if(!s)return false;
        s.value=val;s.dispatchEvent(new Event("change",{bubbles:true}));return true};
      const p=lab("المريض")&&lab("المريض").parentElement.querySelector("select");
      const d=lab("الطبيب")&&lab("الطبيب").parentElement.querySelector("select");
      const pv=p&&[...p.options].find(o=>o.value);
      if(pv&&set("المريض",pv.value))await new Promise(r=>setTimeout(r,300));
      if(d&&[...d.options].find(o=>o.value)){const dv=[...d.options].find(o=>o.value).value;set("الطبيب",dv);await new Promise(r=>setTimeout(r,300));}
      const st=lab("وقت البداية")&&lab("وقت البداية").parentElement.querySelector("select");
      if(!st||!st.value) return {ok:false,why:"no start slot",start:st?st.value:null};
      const start=st.value;
      const btn=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="حفظ");
      if(!btn) return {ok:false,why:"no save button"};
      btn.click();
      await new Promise(r=>setTimeout(r,3000));
      return {ok:true,start};
    })()`);
    check("appointment submitted", filled.ok === true, filled.why || "start=" + filled.start);

    await sleep(1500);
    const rows2 = J(await req("GET", `/api/appointments?clinicId=${clinic.id}`, null, cookie));
    const all = Array.isArray(rows2) ? rows2 : [];
    const mine = all.filter((a) => !beforeIds.includes(a.id))
      .find((a) => a.serviceId === target.id) || all.filter((a) => !beforeIds.includes(a.id))[0];
    if (mine) created.push(mine.id);
    check("created appointment carries the service", !!mine && mine.serviceId === target.id,
      mine ? "svc=" + mine.serviceId : "not created");
    check("created appointment carries the service", !!mine && mine.serviceId === target.id,
      mine ? JSON.stringify({ svc: mine.serviceId, dur: dur }) : "not found");
    check("appointment length equals the service duration", !!mine &&
      (new Date(mine.endTime) - new Date(mine.startTime)) / 60000 === dur,
      mine ? (new Date(mine.endTime) - new Date(mine.startTime)) / 60000 + " min" : "-");

    // reopening the form must not offer the slot that is now taken
    await page.eval(`(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("موعد جديد"));if(b)b.click();return !!b})()`);
    await sleep(2000);
    const reopened = await page.eval(`(()=>{
      const l=[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith("الخدمة"));
      const s=l&&l.parentElement.querySelector("select");
      if(s){s.value=${JSON.stringify(target.id)};s.dispatchEvent(new Event("change",{bubbles:true}));}
      return null;
    })()`);
    await sleep(900);
    const reopened2 = await page.eval(`(()=>{
      const l=[...document.querySelectorAll("label")].find(x=>x.textContent.trim().startsWith("وقت البداية"));
      const s=l&&l.parentElement.querySelector("select");
      return s?[...s.options].map(o=>o.value):[];
    })()`);
    check("booked slot removed from the next list", filled.ok && !reopened2.includes(filled.start),
      "offered=" + reopened2.slice(0, 4).map((t) => t.slice(11)).join(","));
    if (filled.ok && filled.start) {
      const free = reopened2.filter((t) => mins(t) >= mins(filled.start));
      const next = free[0];
      check("next free start is the end of the booked one", !!next && mins(next) === mins(filled.start) + dur,
        "took " + String(filled.start).slice(11) + " -> next " + (next || "-").slice(11));
    }
  } catch (e) {
    check("harness ran without throwing", false, String(e && e.stack || e).slice(0, 300));
  } finally {
    for (const id of created) {
      const d = await req("DELETE", "/api/appointments", { id }, cookie);
      if (d.code !== 200) console.log("    ! could not clean appointment " + id + " " + d.code);
    }
    chrome.proc.kill();
  }
  done();
})();

function done() {
  console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
  process.exit(fail ? 1 : 0);
}
