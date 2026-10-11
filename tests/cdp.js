/* Minimal Chrome DevTools Protocol client using Node's native WebSocket.
 * Enough to: set a cookie, navigate, run JS in the page, and read results. */
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");

const CHROME = (() => {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return process.env.CHROME_PATH || "chrome"; // fall back to whatever is on PATH
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: 10000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function launch({ port = 9333, width = 1440, height = 1000 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-"));
  const proc = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ], { stdio: "ignore" });

  // wait for the debugger to come up
  let info = null;
  for (let i = 0; i < 60; i++) {
    try { info = JSON.parse(await get(`http://127.0.0.1:${port}/json/version`)); break; }
    catch { await sleep(250); }
  }
  if (!info) { proc.kill(); throw new Error("chrome debugger never came up"); }
  return { proc, port, profile };
}

async function newPage(port) {
  // Chrome >= 111 needs PUT for /json/new
  let raw = "";
  try { raw = await get(`http://127.0.0.1:${port}/json/new?about:blank`, "PUT"); }
  catch { raw = await get(`http://127.0.0.1:${port}/json/new?about:blank`); }
  const target = JSON.parse(raw);
  return connect(target.webSocketDebuggerUrl, target.id);
}

function connect(wsUrl, targetId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    const api = {
      events,
      send(method, params = {}) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => {
          pending.set(msgId, { res, rej });
          setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); rej(new Error("CDP timeout: " + method)); } }, 30000);
        });
      },
      async eval(expression) {
        const r = await api.send("Runtime.evaluate", {
          expression, returnByValue: true, awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
        return r.result.value;
      },
      close() { try { ws.close(); } catch {} },
    };
    ws.addEventListener("open", () => resolve(api));
    ws.addEventListener("error", (e) => reject(new Error("ws error " + (e.message || ""))));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
  });
}

module.exports = { launch, newPage, sleep, get, CHROME };