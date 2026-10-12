/**
 * Patient-files suite — upload allowlist + magic bytes, clinic isolation,
 * download gating + audit, trash/restore/purge with byte cleanup.
 *
 * Own throwaway server (temp DATA_DIR, ENCRYPTION_KEY on so sealed filenames
 * are covered too). Prints "PASS n   FAIL n".
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const PORT = 3201;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "eyada-pfiles-"));
const ENC_KEY = "unit-test-encryption-key-0123456789";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x41)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 0x42)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x43)]);
const b64 = (b) => b.toString("base64");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   " + extra : ""}`);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, { body, cookie, raw = false } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    if (cookie) h["Cookie"] = cookie;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: h, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let j = null; try { j = JSON.parse(buf.toString("utf8")); } catch { /* binary */ }
        resolve({ status: res.statusCode, headers: res.headers, json: j, buf });
      });
    });
    r.on("error", (e) => resolve({ status: 0, headers: {}, json: null, buf: Buffer.alloc(0), err: String(e.message) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, json: null, buf: Buffer.alloc(0) }); });
    if (data) r.write(data); r.end();
  });
}
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const r = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", method: "GET", timeout: 1000 },
        (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on("error", () => resolve(false));
      r.on("timeout", () => { r.destroy(); resolve(false); });
      r.end();
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}
const cookieOf = (r) => (r.headers?.["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
const filesOnDisk = () => {
  const d = path.join(TMP, "files");
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

(async () => {
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, DATA_DIR: TMP, PORT: String(PORT), HOST: "127.0.0.1", ENCRYPTION_KEY: ENC_KEY, FILE_MAX_BYTES: "300" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let srvOut = "";
  srv.stdout.on("data", (d) => (srvOut += d));
  srv.stderr.on("data", (d) => (srvOut += d));
  const finish = (code) => {
    try { srv.kill("SIGKILL"); } catch { /* gone */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\n   PASS ${pass}   FAIL ${fail}`);
    process.exit(code);
  };
  if (!(await waitHealthy())) { console.log("server never became healthy:\n" + srvOut); finish(1); return; }

  const login = await req("POST", "/api/auth/login", { body: { username: "admin", password: "admin123" } });
  const A = cookieOf(login);
  check("seeded owner signs in", login.status === 200 && !!A, `code=${login.status}`);

  const p = await req("POST", "/api/patients", { cookie: A, body: { fullName: "File Probe", phone: "0555000101" } });
  const pid = p.json?.id;
  check("probe patient created", p.status === 200 && !!pid, `code=${p.status}`);
  const base = `/api/patients/${pid}/files`;

  const up1 = await req("POST", base, { cookie: A, body: { filename: "ashia-sadr.pdf", mime: "application/pdf", data: b64(PDF) } });
  check("pdf upload accepted", up1.status === 200 && !!up1.json?.id, `code=${up1.status}`);
  const up2 = await req("POST", base, { cookie: A, body: { filename: "scan.png", mime: "image/png", data: b64(PNG) } });
  check("png upload accepted", up2.status === 200, `code=${up2.status}`);
  const fid = up1.json?.id;

  const exeMime = await req("POST", base, { cookie: A, body: { filename: "run.exe", mime: "application/x-msdownload", data: b64(EXE) } });
  check("exe mime rejected (400)", exeMime.status === 400, `code=${exeMime.status}`);
  const exeMagic = await req("POST", base, { cookie: A, body: { filename: "fake.pdf", mime: "application/pdf", data: b64(EXE) } });
  check("magic mismatch rejected (400)", exeMagic.status === 400, `code=${exeMagic.status}`);
  const big = await req("POST", base, { cookie: A, body: { filename: "big.pdf", mime: "application/pdf", data: b64(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(500, 0x41)])) } });
  check("oversize rejected (413, cap=300B)", big.status === 413, `code=${big.status}`);

  const list = await req("GET", base, { cookie: A });
  check("list shows the two files", list.status === 200 && (list.json || []).length === 2, `n=${(list.json || []).length}`);

  const dl = await req("GET", `${base}/${fid}/download`, { cookie: A });
  check("download 200 with pdf bytes", dl.status === 200 && dl.buf.equals(PDF), `code=${dl.status} bytes=${dl.buf.length}`);
  check("download content-type is the allowlisted mime", dl.headers["content-type"] === "application/pdf");
  check("download is attachment", String(dl.headers["content-disposition"] || "").startsWith("attachment"));

  // original filename sealed at rest, stored name random
  await sleep(800);
  const rawDb = fs.readFileSync(path.join(TMP, "db.json"), "utf8");
  check("original filename sealed in db.json", !rawDb.includes("ashia-sadr.pdf"));
  const disk = filesOnDisk();
  check("stored under a random name", disk.length === 2 && !disk.some((f) => f.includes("ashia")), disk.join(","));

  // ── IDOR: clinic B ──
  const reg = await req("POST", "/api/auth/register", { body: { username: "fileb", password: "File-B-2026!", fullName: "B Owner", clinicName: "Clinic B Files" } });
  const B = cookieOf(reg);
  const bList = await req("GET", base, { cookie: B });
  check("IDOR: clinic B cannot list A's files (403)", bList.status === 403, `code=${bList.status}`);
  const bDl = await req("GET", `${base}/${fid}/download`, { cookie: B });
  check("IDOR: clinic B cannot download A's file", bDl.status === 403 || bDl.status === 404, `code=${bDl.status}`);

  // ── trash cycle ──
  const del = await req("DELETE", `${base}/${fid}`, { cookie: A });
  check("delete soft-deletes (200)", del.status === 200 && del.json?.softDeleted === true, `code=${del.status}`);
  const dlGone = await req("GET", `${base}/${fid}/download`, { cookie: A });
  check("trashed file no longer downloads (404)", dlGone.status === 404, `code=${dlGone.status}`);
  const trash = await req("GET", "/api/trash?type=patientFiles", { cookie: A });
  check("trashed file listed", trash.status === 200 && (trash.json?.items || []).some((x) => x.id === fid));
  const rest = await req("POST", `/api/trash/patientFiles/${fid}/restore`, { cookie: A });
  check("restore works", rest.status === 200, `code=${rest.status}`);
  const dlBack = await req("GET", `${base}/${fid}/download`, { cookie: A });
  check("restored file downloads again", dlBack.status === 200 && dlBack.buf.equals(PDF));
  await req("DELETE", `${base}/${fid}`, { cookie: A });
  const purge = await req("DELETE", `/api/trash/patientFiles/${fid}`, { cookie: A });
  check("permanent purge (200)", purge.status === 200, `code=${purge.status}`);
  check("purge removed the bytes from disk", !filesOnDisk().some((f) => {
    try { return fs.readFileSync(path.join(TMP, "files", f)).equals(PDF); } catch { return false; }
  }) && filesOnDisk().length === 1, filesOnDisk().join(","));

  finish(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
