/* Minimal Chrome DevTools Protocol client using Node's native WebSocket.
 * Enough to: set a cookie, navigate, run JS in the page, and read results. */
const { spawn } = require("child_process");
const http = require("http");
const crypto = require("crypto");
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

function createSocket(url) {
  if (typeof WebSocket !== "undefined") return new WebSocket(url); // Node 21+
  return new MiniWS(url); // Node 18/20 fallback — zero dependencies
}

/**
 * Smallest usable WebSocket client: HTTP upgrade, masked text frames out,
 * reassembly + ping/pong in. Only what CDP needs (short JSON messages).
 */
class MiniWS {
  constructor(url) {
    this.handlers = { open: [], error: [], message: [], close: [] };
    this.buf = Buffer.alloc(0);
    this.msg = [];
    this.dead = false;
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method: "GET",
      headers: {
        Upgrade: "websocket", Connection: "Upgrade",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (res, socket) => {
      this.socket = socket;
      socket.on("data", (d) => this.onData(d));
      socket.on("close", () => this.emit("close"));
      socket.on("error", (e) => this.emit("error", e));
      this.emit("open");
    });
    req.on("error", (e) => this.emit("error", e));
    req.end();
  }
  addEventListener(ev, fn) { if (this.handlers[ev]) this.handlers[ev].push(fn); }
  emit(ev, arg) { for (const fn of this.handlers[ev] || []) { try { fn(arg); } catch { /* listener bug */ } } }
  send(data) {
    const payload = Buffer.from(String(data));
    let head;
    if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) {
      head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const mask = crypto.randomBytes(4);
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([head, mask, out]));
  }
  pong(data) {
    const head = Buffer.from([0x8a, data.length]);
    this.socket.write(Buffer.concat([head, data]));
  }
  close() { this.dead = true; try { this.socket.destroy(); } catch { /* gone */ } }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      // server frames are never masked; tolerate a mask anyway
      if (this.buf[1] & 0x80) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      if (this.buf[1] & 0x80) {
        const m = this.buf.slice(off - 4, off);
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ m[i % 4];
        payload = out;
      }
      this.buf = this.buf.slice(off + len);
      if (op === 0x9) { this.pong(payload); continue; }        // ping -> pong
      if (op === 0x8 || op === 0xa) continue;                   // close / pong
      if (op === 0x1 || op === 0x2 || op === 0x0) this.msg.push(payload); // text/binary/continuation
      if (fin && this.msg.length) {
        const text = Buffer.concat(this.msg).toString("utf8");
        this.msg = [];
        this.emit("message", { data: text });
      }
      if (this.dead) return;
    }
  }
}

function connect(wsUrl, targetId) {
  return new Promise((resolve, reject) => {
    const ws = createSocket(wsUrl);
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