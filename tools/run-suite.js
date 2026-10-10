/**
 * Runs each suite against a freshly started server, one suite per server, and
 * refuses to start until port 3000 is actually free. The old flow raced: a
 * previous server was still holding the port, the new one died with EADDRINUSE
 * and every later request got ECONNREFUSED, which looked like a product bug.
 */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");

const APP_DIR = "C:\\Users\\911ho\\Desktop\\bank";
const SUITES = process.argv.slice(2);
if (!SUITES.length) {
  console.error("usage: node run-suite.js <suite.js> [suite.js ...]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 3000, path: "/api/health", method: "GET", timeout: 1200 },
      (res) => { res.resume(); resolve(false); }
    );
    req.on("error", () => resolve(true));
    req.on("timeout", () => { req.destroy(); resolve(true); });
    req.end();
  });
}

async function waitPortFree(tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await portFree()) return true;
    await sleep(500);
  }
  return false;
}

async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: 3000, path: "/api/health", method: "GET", timeout: 1500 },
        (res) => { res.resume(); resolve(res.statusCode === 200); }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

(async () => {
  let failed = 0;
  for (const suite of SUITES) {
    console.log("\n================ " + suite + " ================");

    if (!(await waitPortFree())) {
      console.log("SKIP " + suite + " — port 3000 is still busy, refusing to fake a result");
      failed++;
      continue;
    }

    const srv = spawn(process.execPath, ["server.js"], {
      cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"],
    });
    let srvOut = "";
    srv.stdout.on("data", (d) => { srvOut += d; });
    srv.stderr.on("data", (d) => { srvOut += d; });

    const healthy = await waitHealthy();
    if (!healthy) {
      console.log("FAIL " + suite + " — server never became healthy");
      console.log(srvOut.split(/\r?\n/).slice(-25).join("\n"));
      failed++;
      srv.kill("SIGKILL");
      await sleep(1500);
      continue;
    }

    const run = spawnSync(process.execPath, [path.resolve(__dirname, suite)], {
      cwd: __dirname, encoding: "utf8", timeout: 15 * 60 * 1000,
    });
    const out = (run.stdout || "") + (run.stderr || "");
    process.stdout.write(out);

    const m = out.match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/) || out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (!m) { console.log("FAIL " + suite + " — no summary line (exit " + run.status + ")"); failed++; }
    else if (Number(m[2]) !== 0) { console.log("FAIL " + suite + " — " + m[2] + " failing assertion(s)"); failed++; }
    else console.log("OK " + suite + " — " + m[1] + " passed");

    if (/FATAL|EADDRINUSE/.test(srvOut)) {
      console.log("NOTE " + suite + " — server log reported: " +
        (srvOut.match(/FATAL[^\n]*/) || ["?"])[0]);
    }

    // save() batches its writes behind an 80ms debounce; killing the server the
    // instant the suite returns drops that last flush and the next suite sees
    // the pre-suite database (which looks like an uncleaned test fixture).
    await sleep(400);
    srv.kill("SIGKILL");
    await sleep(1500);
  }

  console.log("\n" + (failed ? failed + " suite(s) failed" : "all suites green"));
  process.exit(failed ? 1 : 0);
})();