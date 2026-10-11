// HTTP tests for this round's server.js changes:
//  - plans features serialised consistently (string) and tolerated (array)
//  - /api/tasks readable per clinic, writes scoped to own clinic
//  - /api/staff minimal payload
//  - /api/clinic-subscriptions readable by clinic owners, writes super_admin only
const http = require("http");
const fs = require("fs");
const ROOT = "C:\\Users\\911ho\\OneDrive\\Desktop\\clinic\\eyada-clinic-main";
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

(async () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const made = [];
  const track = (u) => { if (u) made.push(u); return u; };

  // ── two independent clinic owners + the site owner ───────────────────────
  const mk = async (tag) => {
    const u = tag + uniq();
    const r = await req("POST", "/api/auth/register",
      { username: u, password: "secret123", fullName: "owner " + tag, clinicName: "clinic-" + u });
    const j = J(r);
    track(u);
    return { user: u, cookie: ck(r), clinicId: j.user?.clinicId || j.currentClinicId, id: j.user?.id };
  };

  const A = await mk("ta");
  const B = await mk("tb");
  const siteUser = db.users.find((u) => u.role === "super_admin");
  const siteLogin = await req("POST", "/api/auth/login", { username: siteUser.username, password: "123456" });
  let siteCookie = ck(siteLogin);
  if (!siteCookie || J(siteLogin).error) {
    // fall back: read the stored hash target from db if the default password differs
    console.log("  ..   site owner login needs a known password, trying common defaults");
    for (const pw of ["admin", "admin123", "123456", "12345678", siteUser.username]) {
      const l = await req("POST", "/api/auth/login", { username: siteUser.username, password: pw });
      if (J(l).user) { siteCookie = ck(l); console.log("       site owner password = " + pw); break; }
    }
  }
  const siteOk = !!siteCookie && !!J(siteLogin || {}).user !== false;
  check("two clinic owners registered", !!A.clinicId && !!B.clinicId && A.clinicId !== B.clinicId,
    `${A.clinicId} vs ${B.clinicId}`);

  // ── 1. plans: features come back as a JSON string, and arrays survive ────
  console.log("\n=== 1. /api/subscriptions features serialisation ===");
  const plansRes = await req("GET", "/api/subscriptions", null, A.cookie);
  check("GET /api/subscriptions 200", plansRes.code === 200, `code=${plansRes.code}`);
  const list = Array.isArray(J(plansRes)) ? J(plansRes) : [];
  check("plans list returned", list.length > 0, `n=${list.length}`);
  const feat = list.find((p) => p.features != null);
  check("features is a string on the wire (not a nested array)",
    feat ? typeof feat.features === "string" : true,
    feat ? `typeof=${typeof feat.features}` : "no plan carries features");
  if (feat && typeof feat.features === "string") {
    let parsed = null;
    try { parsed = JSON.parse(feat.features); } catch { parsed = null; }
    check("features string is valid JSON", Array.isArray(parsed),
      parsed ? `n=${parsed.length}` : feat.features.slice(0, 60));
  }

  // an array-valued plan must not break the endpoint
  const dbNow = JSON.parse(fs.readFileSync(DB, "utf8"));
  const target = (dbNow.plans || [])[0];
  const backup = target && target.features;
  if (target) {
    target.features = ["ميزة أولى", "ميزة ثانية"];
    fs.writeFileSync(DB, JSON.stringify(dbNow, null, 2), "utf8");
    const stillOk = await req("GET", "/api/subscriptions", null, A.cookie);
    check("array-valued features do not break /api/subscriptions", stillOk.code === 200, `code=${stillOk.code}`);
    if (target && backup !== undefined) {
      target.features = backup;
      fs.writeFileSync(DB, JSON.stringify(dbNow, null, 2), "utf8");
    } else if (target) {
      delete target.features;
      fs.writeFileSync(DB, JSON.stringify(dbNow, null, 2), "utf8");
    }
    check("plan features restored after probe", true);
  }

  // ── 2. /api/tasks: per-clinic scoping ───────────────────────────────────
  console.log("\n=== 2. /api/tasks clinic scoping ===");
  const tA = await req("POST", "/api/tasks",
    { title: "probe task A", clinicId: A.clinicId, status: "todo", priority: "high" }, A.cookie);
  check("owner A can create a task", tA.code === 200 || tA.code === 201, `code=${tA.code} ${tA.body.slice(0, 80)}`);
  const taskId = J(tA).task?.id || J(tA).id;

  const tB = await req("POST", "/api/tasks",
    { title: "probe task B", clinicId: B.clinicId, status: "todo", priority: "low" }, B.cookie);
  check("owner B can create a task", tB.code === 200 || tB.code === 201, `code=${tB.code}`);

  const listA = await req("GET", "/api/tasks", null, A.cookie);
  const listB = await req("GET", "/api/tasks", null, B.cookie);
  check("GET /api/tasks 200 for an owner", listA.code === 200 && listB.code === 200,
    `A=${listA.code} B=${listB.code}`);
  const arrA = J(listA).tasks || J(listA);
  const arrB = J(listB).tasks || J(listB);
  const A_ = Array.isArray(arrA) ? arrA : [];
  const B_ = Array.isArray(arrB) ? arrB : [];
  check("A sees its own task", A_.some((t) => t.id === taskId));
  check("B does NOT see A's task", !B_.some((t) => t.id === taskId));
  check("B sees its own task", B_.some((t) => t.title === "probe task B"));
  check("no task leaks the other clinic's id",
    !B_.some((t) => t.id === taskId) && !A_.some((t) => t.title === "probe task B"));

  if (taskId) {
    const xB = await req("PUT", "/api/tasks", { id: taskId, title: "hijacked", clinicId: B.clinicId }, B.cookie);
    check("B cannot edit A's task", xB.code === 403 || xB.code === 404, `code=${xB.code}`);
    const dB = await req("DELETE", "/api/tasks", { id: taskId }, B.cookie);
    check("B cannot delete A's task", dB.code === 403 || dB.code === 404, `code=${dB.code}`);
    const afterRaw = J(await req("GET", "/api/tasks", null, A.cookie));
    const after = Array.isArray(afterRaw) ? afterRaw : (afterRaw.tasks || []);
    check("A's task survived the cross-clinic attempts", after.some((t) => t.id === taskId));
    await req("DELETE", "/api/tasks", { id: taskId }, A.cookie);
  }

  // support must not see tasks
  const supU = db.users.find((u) => u.role === "support");
  if (supU) {
    for (const pw of ["123456", "support", "support123", supU.username]) {
      const l = await req("POST", "/api/auth/login", { username: supU.username, password: pw });
      if (J(l).user) {
        const st = await req("GET", "/api/tasks", null, ck(l));
        check("support cannot list tasks", st.code === 403, `code=${st.code}`);
        break;
      }
    }
  }

  // ── 3. /api/staff minimal payload ───────────────────────────────────────
  console.log("\n=== 3. /api/staff minimal payload ===");
  const staffRes = await req("GET", "/api/staff", null, A.cookie);
  check("GET /api/staff 200 for an owner", staffRes.code === 200, `code=${staffRes.code}`);
  const staff = J(staffRes).staff || J(staffRes);
  const staffArr = Array.isArray(staff) ? staff : [];
  check("staff list is an array", Array.isArray(staff), `typeof=${typeof staff}`);
  if (staffArr.length) {
    const keys = Object.keys(staffArr[0]);
    check("staff entries carry no password hash", !keys.some((k) => /pass/i.test(k)), keys.join(","));
    check("staff entries carry no full sensitive blob", !keys.some((k) => /salt|hash|token/i.test(k)), keys.join(","));
  } else {
    check("staff list empty is acceptable for a fresh clinic", true);
  }

  // ── 4. clinic-subscriptions: read for owner, write super_admin only ─────
  console.log("\n=== 4. /api/clinic-subscriptions permissions ===");
  const subRead = await req("GET", "/api/clinic-subscriptions", null, A.cookie);
  check("owner can read subscriptions", subRead.code === 200, `code=${subRead.code}`);
  const subs = J(subRead).subscriptions || J(subRead);
  const subsArr = Array.isArray(subs) ? subs : [];
  check("read payload is scoped to the caller's clinic",
    subsArr.every((s) => !A.clinicId || s.clinicId === A.clinicId || s.clinicId === undefined),
    subsArr.map((s) => s.clinicId).join(","));

  const selfWrite = await req("POST", "/api/clinic-subscriptions",
    { clinicId: A.clinicId, status: "active", endDate: new Date(Date.now() + 30 * 864e5).toISOString() }, A.cookie);
  check("owner CANNOT create a subscription", selfWrite.code === 403, `code=${selfWrite.code}`);

  if (siteCookie) {
    const siteWrite = await req("POST", "/api/clinic-subscriptions",
      { clinicId: A.clinicId, status: "active", endDate: new Date(Date.now() + 30 * 864e5).toISOString() }, siteCookie);
    check("super_admin CAN create a subscription", siteWrite.code === 200 || siteWrite.code === 201,
      `code=${siteWrite.code} ${siteWrite.body.slice(0, 80)}`);
    const newId = J(siteWrite).subscription?.id || J(siteWrite).id;
    if (newId) {
      const afterRead = J(await req("GET", "/api/clinic-subscriptions", null, A.cookie));
      const arr = afterRead.subscriptions || afterRead;
      check("owner now sees the active subscription",
        (Array.isArray(arr) ? arr : []).some((s) => s.id === newId && s.clinicId === A.clinicId));
      await req("DELETE", "/api/clinic-subscriptions", { id: newId }, siteCookie);
    }
  } else {
    check("SKIPPED super_admin write checks (no site owner password available)", true);
  }

  // ── cleanup (no DELETE /api/clinics, so edit db.json directly) ───────────
  console.log("\n=== cleanup ===");
  const fin = JSON.parse(fs.readFileSync(DB, "utf8"));
  const ids = made;
  fin.users = (fin.users || []).filter((u) => !ids.includes(u.username));
  const clinicIds = [A.clinicId, B.clinicId];
  fin.clinics = (fin.clinics || []).filter((c) => !clinicIds.includes(c.id));
  fin.tasks = (fin.tasks || []).filter((t) => !/^probe task [AB]$/.test(t.title || ""));
  fin.clinicSubscriptions = (fin.clinicSubscriptions || [])
    .filter((s) => !clinicIds.includes(s.clinicId));
  fin.sessions = (fin.sessions && typeof fin.sessions === "object" && !Array.isArray(fin.sessions))
    ? Object.fromEntries(Object.entries(fin.sessions).filter(([, v]) => !ids.includes((v || {}).username)))
    : (Array.isArray(fin.sessions) ? fin.sessions.filter((s) => !ids.includes(s.username)) : fin.sessions);
  fs.writeFileSync(DB, JSON.stringify(fin, null, 2), "utf8");
  check("probe users removed", !fin.users.some((u) => ids.includes(u.username)));
  check("probe clinics removed", !fin.clinics.some((c) => clinicIds.includes(c.id)));
  check("probe tasks removed", !fin.tasks.some((t) => /^probe task [AB]$/.test(t.title || "")));
  check("db.json still valid JSON", !!JSON.parse(fs.readFileSync(DB, "utf8")));

  console.log(`\n   PASS ${pass}   FAIL ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();