/* Drives the real app UI in headless Chrome:
 *  - clinic owner: new "الخدمات والأسعار" screen edits price + duration
 *  - clinic owner: new "الأمان" screen has the change-password form
 *  - clinic owner: "إدارة العيادات" still offers account creation with a
 *    permission picker
 *  - expired clinic: the workspace is replaced by the support-only lock screen
 */
const http = require("http");
const fs = require("fs");
const { launch, newPage, sleep } = require("./cdp.js");

const DB = "C:\\Users\\911ho\\Desktop\\bank\\data\\db.json";
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
const ck = (r) => (r.cookie || []).map((x) => x.split(";")[0]).join("; ");
const settle = () => sleep(700);

async function login(username, passwords) {
  for (const pw of passwords) {
    const r = await req("POST", "/api/auth/login", { username, password: pw });
    if (J(r).user) {
      // the server may set several cookies; take only the session one by name
      const m = (r.cookie || []).join(";").match(/eyada_session=([A-Za-z0-9_-]+)/);
      return m ? m[1] : "";
    }
  }
  return "";
}

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const chrome = await launch();
  console.log("chrome up on " + chrome.port);

  try {
    /* ── 1. clinic owner ── */
    const ownerRow = db.users.find((u) => u.clinicId === db.clinics[0].id && u.role === "admin")
      || db.users.find((u) => u.role === "super_admin");
    const ownerToken = await login(ownerRow.username, ["123456", "admin123", "admin"]);
    check("owner session token obtained", !!ownerToken, "user=" + ownerRow.username);
    console.log("  debug token len=" + ownerToken.length + " sample=" + JSON.stringify(ownerToken.slice(0, 12)));

    const page = await newPage(chrome.port);
    await page.send("Network.enable");
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable").catch(() => {});
    // surface whatever the page throws, otherwise a render crash just shows as
    // a blank screen and the assertion messages become useless
    const drain = (tag) => {
      const out = [];
      for (const ev of page.events.splice(0)) {
        if (ev.method === "Runtime.exceptionThrown") {
          const d = ev.params.exceptionDetails;
          out.push(tag + " EXCEPTION: " + (d.exception && (d.exception.description || d.exception.value) || d.text));
        }
        if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
          out.push(tag + " console.error: " + ev.params.args.map((a) => a.description || a.value || "").join(" ").slice(0, 400));
        }
        if (ev.method === "Log.entryAdded" && ev.params.entry.level === "error") {
          out.push(tag + " log: " + String(ev.params.entry.text).slice(0, 400));
        }
      }
      out.forEach((l) => console.log("    " + l));
      return out;
    };
    await page.send("Network.setCookie", {
      name: "eyada_session", value: ownerToken, domain: "127.0.0.1", path: "/",
    });
    await page.send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await sleep(6000);
    drain("[boot]");

    const boot = await page.eval(`(()=>{
      const nav=[...document.querySelectorAll("aside button, nav button")].map(b=>b.textContent.trim());
      return { hasApp: !!document.querySelector(".sys"), nav,
        errors: window.__errs||[], title: document.title };
    })()`);
    check("app shell rendered", boot.hasApp === true);
    check("services nav item visible", boot.nav.some((t) => t.includes("الخدمات")), JSON.stringify(boot.nav));
    check("security nav item visible", boot.nav.some((t) => t.includes("الأمان")));
    check("clinics nav item visible", boot.nav.some((t) => t.includes("إدارة العيادات")));

    const click = async (label) => {
      await page.eval(`(()=>{
        const b=[...document.querySelectorAll("aside button, nav button")].find(x=>x.textContent.includes(${JSON.stringify(label)}));
        if(b) b.click();
        return !!b;
      })()`);
      await sleep(2500);
      drain("[click " + label + "]");
    };

    /* ── services screen ── */
    await click("الخدمات والأسعار");
    const svc = await page.eval(`(()=>{
      const txt=document.body.innerText;
      const num=[...document.querySelectorAll('input[type="number"]')];
      return {
        hasTitle: txt.includes("الخدمات والأسعار"),
        addHeading: txt.includes("إضافة خدمة"),
        numInputs: num.length,
        placeholders: [...document.querySelectorAll("input")].map(i=>i.placeholder).filter(Boolean),
        mentionsDuration: txt.includes("المدة"),
        mentionsPrice: txt.includes("السعر"),
        anyTextareaError: /undefined|NaN|\\[object/.test(txt),
      };
    })()`);
    check("services screen opened", svc.hasTitle && svc.addHeading, JSON.stringify(svc.placeholders));
    check("duration inputs present", svc.mentionsDuration && svc.numInputs >= 2, "numInputs=" + svc.numInputs);
    check("price input present", svc.placeholders.includes("السعر"));
    check("no undefined/NaN leaked into the UI", svc.anyTextareaError === false);

    // edit the first service's duration through the UI and save
    const saved = await page.eval(`(async()=>{
      const card=[...document.querySelectorAll("div")].find(d=>d.className&&String(d.className).includes("md:grid-cols-[1fr_7rem_7rem_auto]"));
      const inputs=card?card.querySelectorAll("input"):[];
      if(inputs.length<4) return {ok:false,why:"inputs="+inputs.length};
      const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;s.call(el,v);el.dispatchEvent(new Event("input",{bubbles:true}))};
      set(inputs[2],"45");
      await new Promise(r=>setTimeout(r,300));
      const btn=[...card.querySelectorAll("button")].find(b=>b.textContent.includes("حفظ"));
      if(!btn) return {ok:false,why:"no save"};
      btn.click();
      await new Promise(r=>setTimeout(r,1500));
      return {ok:true};
    })()`);
    check("service row is editable and has a save button", saved.ok === true, saved.why || "");
    await settle();
    // re-read from disk: the `db` snapshot at the top predates the edit
    const fresh = JSON.parse(fs.readFileSync(DB, "utf8"));
    const dur45 = fresh.services.filter((s) => s.clinicId === fresh.clinics[0].id && s.durationMin === 45).length;
    check("duration 45 persisted through the UI", dur45 > 0, "n=" + dur45);

    /* ── security screen ── */
    await click("الأمان");
    const sec = await page.eval(`(()=>{
      const txt=document.body.innerText;
      const pw=[...document.querySelectorAll('input[type="password"]')];
      return { hasTitle: txt.includes("كلمة المرور"), count: pw.length,
        labels: [...document.querySelectorAll("label")].map(l=>l.textContent.trim()),
        submit: [...document.querySelectorAll("button[type=submit]")].map(b=>b.textContent.trim()) };
    })()`);
    check("security screen opened", sec.hasTitle);
    check("three password fields (current/new/confirm)", sec.count === 3, "n=" + sec.count);
    check("mismatch warning wired", sec.labels.some((l) => l.includes("تأكيد")), JSON.stringify(sec.labels));
    check("submit button present", sec.submit.some((s) => s.includes("تغيير")), JSON.stringify(sec.submit));

    /* ── read-only subscription tab on the clinic manager ── */
    await click("إدارة العيادات");
    const subsTab = await page.eval(`(async()=>{
      const target=${JSON.stringify(
        (db.clinics.find((c) => c.id === ownerRow.clinicId) || db.clinics[0]).name
      )};
      const chip=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()===target);
      if(!chip) return {ok:false,why:"no clinic chip"};
      chip.click(); await new Promise(r=>setTimeout(r,1500));
      const tab=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="الاشتراكات");
      if(!tab) return {ok:false,why:"no subs tab",
        tabs:[...document.querySelectorAll("button")].map(x=>x.textContent.trim()).filter(t=>t&&t.length<16).slice(0,40)};
      tab.click(); await new Promise(r=>setTimeout(r,1500));
      const txt=document.body.innerText;
      return {ok:true, heading:txt.includes("اشتراك العيادة"), ro:txt.includes("عرض فقط"),
        plan:txt.includes("الباقة"), empty:txt.includes("لا يوجد اشتراك مسجّل"),
        leaks:/undefined|NaN|\\[object/.test(txt)};
    })()`);
    check("clinic manager offers the الاشتراكات tab", subsTab.ok === true, JSON.stringify(subsTab).slice(0, 400));
    check("the tab shows the subscription read-only",
      subsTab.heading === true && subsTab.ro === true, JSON.stringify(subsTab));
    check("no undefined leaked into the tab", subsTab.leaks === false);

    await click("إدارة العيادات");
    const opened = await page.eval(`(async()=>{
      const target=${JSON.stringify(
        (db.clinics.find((c) => c.id === ownerRow.clinicId) || db.clinics[0]).name
      )};
      const chip=[...document.querySelectorAll("button")].find(x=>x.textContent.trim()===target);
      if(!chip) return {ok:false, why:"no clinic chip", buttons:[...document.querySelectorAll("button")].map(x=>x.textContent.trim()).filter(Boolean).slice(0,30)};
      chip.click();
      await new Promise(r=>setTimeout(r,1500));
      const tab=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("المستخدمون"));
      if(!tab) return {ok:false, why:"no users tab", buttons:[...document.querySelectorAll("button")].map(x=>x.textContent.trim()).slice(0,30)};
      tab.click();
      await new Promise(r=>setTimeout(r,1500));
      const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("إضافة موظف"));
      if(!b) return {ok:false, why:"no add-staff button", buttons:[...document.querySelectorAll("button")].map(x=>x.textContent.trim()).slice(0,30)};
      b.click();
      await new Promise(r=>setTimeout(r,1500));
      return {ok:true};
    })()`);
    check("add-staff button reachable", opened.ok === true, JSON.stringify(opened).slice(0, 700));
    const acc = await page.eval(`(()=>{
      const txt=document.body.innerText;
      const boxes=[...document.querySelectorAll('input[type="checkbox"]')];
      return { picker: txt.includes("الصلاحيات الممنوحة للموظف"),
        boxes: boxes.length,
        labels: boxes.map(b=>b.closest("label")?b.closest("label").textContent.trim():""),
        createForm: txt.includes("كلمة المرور") && txt.includes("الدور الوظيفي") };
    })()`);
    check("account creation form reachable", acc.createForm);
    check("permission picker shown", acc.picker && acc.boxes >= 8, "boxes=" + acc.boxes);
    check("picker covers all 8 modules", acc.labels.filter(Boolean).length >= 8, JSON.stringify(acc.labels));

    page.close();
    await sleep(500);

    /* ── 2. locked clinic ── */
    const uniq = Date.now().toString(36);
    const reg = await req("POST", "/api/auth/register", {
      username: "lk" + uniq, password: "test1234", fullName: "Locked UI",
      clinicName: "Locked UI " + uniq, clinicPhone: "0500000000",
    });
    const cid = J(reg).user && J(reg).user.clinicId;
    await settle();
    const siteToken = await login(db.users.find((u) => u.role === "super_admin").username, ["123456", "admin123"]);
    const siteCookie = siteToken ? "eyada_session=" + siteToken : "";
    const probeCookie = ck(reg);
    const probeToken = (probeCookie.match(/eyada_session=([A-Za-z0-9_-]+)/) || [])[1];
    // expire every row for that clinic, then confirm via the API before the UI check
    let expiring = J(await req("GET", "/api/clinic-subscriptions?all=true", null, siteCookie))
      .filter((x) => x.clinicId === cid);
    for (const row of expiring) {
      await req("PUT", "/api/clinic-subscriptions/" + row.id, {
        status: "expired", endDate: new Date(Date.now() - 864e5).toISOString(),
      }, siteCookie);
    }
    await settle();
    const me1 = J(await req("GET", "/api/auth/me", null, probeCookie));
    check("probe clinic created and expired", !!cid && !!probeToken && me1.locked === true,
      "rows=" + expiring.length + " locked=" + me1.locked);

    const lockToken = probeToken;
    const p2 = await newPage(chrome.port);
    await p2.send("Network.enable");
    await p2.send("Page.enable");
    await p2.send("Runtime.enable");
    await p2.send("Network.setCookie", { name: "eyada_session", value: lockToken, domain: "127.0.0.1", path: "/" });
    await p2.send("Page.navigate", { url: "http://127.0.0.1:3000/" });
    await sleep(6000);

    const lock = await p2.eval(`(()=>{
      const txt=document.body.innerText;
      return { heading: txt.includes("انتهت الفترة التجريبية"),
        contact: txt.includes("تواصل مع المالك"),
        chat: txt.includes("محادثة الدعم"),
        logout: txt.includes("تسجيل الخروج"),
        sidebarGone: !document.querySelector("aside"),
        noDashboard: !txt.includes("لوحة التحكم"),
        noPatients: !txt.includes("إدارة المرضى"),
        mailto: (document.querySelector('a[href^="mailto:"]')||{}).href||"" };
    })()`);
    check("lock screen replaces the workspace", lock.heading);
    check("sidebar is gone", lock.sidebarGone);
    check("no dashboard menu", lock.noDashboard);
    check("no patients menu", lock.noPatients);
    check("contact-the-owner button present", lock.contact && lock.mailto.includes("911houssem@gmail.com"), lock.mailto);
    check("support chat present", lock.chat);
    check("logout available", lock.logout);

    // and the chat must actually work from the lock screen
    const sent = await p2.eval(`(async()=>{
      const boxes=[...document.querySelectorAll('input')];
      const inp=boxes.find(i=>/رسالتك/.test(i.placeholder||""))||boxes[boxes.length-1];
      if(!inp) return {ok:false,why:"no input",inputs:boxes.length};
      const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
      s.call(inp,"اختبار من شاشة القفل");inp.dispatchEvent(new Event("input",{bubbles:true}));
      await new Promise(r=>setTimeout(r,400));
      const btn=[...document.querySelectorAll("button")].find(b=>b.textContent.includes("إرسال"));
      if(!btn) return {ok:false,why:"no send button"};
      btn.click();
      await new Promise(r=>setTimeout(r,2500));
      return {ok:document.body.innerText.includes("اختبار من شاشة القفل")};
    })()`);
    check("support message sends from the lock screen", sent.ok === true, JSON.stringify(sent).slice(0, 300));
    p2.close();
  } catch (e) {
    console.log("HARNESS ERROR ->", e.message, e.stack);
    fail++;
  } finally {
    chrome.proc.kill();
  }

  console.log(`\n   PASS ${pass}   FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();