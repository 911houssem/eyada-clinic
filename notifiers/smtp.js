"use strict";

/**
 * SMTP provider — REAL implementation, zero dependencies (net/tls only).
 *
 * Config comes from the environment (one relay for the whole install):
 *   SMTP_HOST (required)  SMTP_PORT (default 587, 465 => implicit TLS)
 *   SMTP_SECURE=1 forces implicit TLS on any port
 *   SMTP_USER / SMTP_PASS (AUTH LOGIN; omitted => no auth)
 *   SMTP_FROM (required, e.g. "عيادة النور <no-reply@example.com>")
 *   SMTP_REJECT_UNAUTHORIZED=0 only for relays with self-signed certs (default 1)
 *   SMTP_TIMEOUT_MS (default 10000)
 *
 * Supports: EHLO (multiline), STARTTLS upgrade, AUTH LOGIN, MAIL/RCPT/DATA
 * with dot-stuffing, UTF-8 subjects (RFC 2047). Passwords never appear in
 * errors or logs — every thrown message is built from server reply codes.
 */

const net = require("net");
const tls = require("tls");

const cfg = () => ({
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "1" || Number(process.env.SMTP_PORT) === 465,
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  from: process.env.SMTP_FROM || "",
  rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "0",
  timeoutMs: Number(process.env.SMTP_TIMEOUT_MS || 10000),
});

function b64(s) { return Buffer.from(String(s), "utf8").toString("base64"); }
function q2047(s) { // RFC 2047 encoded-word for non-ASCII subjects
  const t = String(s);
  return /[^\x20-\x7e]/.test(t) ? `=?UTF-8?B?${b64(t)}?=` : t;
}

/** Line reader: resolves full replies incl. multiline (250-... / 250 ...). */
function reader(socket, timeoutMs) {
  let buf = "";
  const waiting = [];
  const onLine = (line) => {
    const m = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!m) return null;
    return { code: Number(m[1]), last: m[2] === " ", text: m[3] };
  };
  socket.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const r = onLine(line);
      if (!r) continue;
      const w = waiting[0];
      if (!w) continue;
      w.lines.push(r);
      if (r.last) { waiting.shift(); w.done(w.lines); }
    }
  });
  const ask = (cmd) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("smtp timeout waiting for reply")), timeoutMs);
    waiting.push({ lines: [], done: (lines) => { clearTimeout(timer); resolve(lines); } });
    if (cmd !== null) socket.write(cmd + "\r\n", (e) => { if (e) { clearTimeout(timer); reject(e); } });
  });
  return { ask };
}

async function sendMail({ to, subject, text }) {
  const c = cfg();
  if (!c.host) throw new Error("smtp not configured (SMTP_HOST missing)");
  if (!c.from) throw new Error("smtp not configured (SMTP_FROM missing)");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("smtp: invalid recipient address");

  const openPlain = () => new Promise((resolve, reject) => {
    const s = net.connect({ host: c.host, port: c.port, timeout: c.timeoutMs });
    s.once("connect", () => resolve(s));
    s.once("timeout", () => { s.destroy(); reject(new Error("smtp connection timeout")); });
    s.once("error", reject);
  });
  const openTls = (plain) => new Promise((resolve, reject) => {
    const opts = { socket: undefined, rejectUnauthorized: c.rejectUnauthorized, servername: c.host };
    const s = plain
      ? tls.connect({ ...opts, socket: plain })
      : tls.connect({ host: c.host, port: c.port, ...opts, timeout: c.timeoutMs });
    const timer = setTimeout(() => { s.destroy(); reject(new Error("smtp TLS timeout")); }, c.timeoutMs);
    s.once("secureConnect", () => { clearTimeout(timer); resolve(s); });
    s.once("timeout", () => { clearTimeout(timer); s.destroy(); reject(new Error("smtp TLS timeout")); });
    s.once("error", (e) => { clearTimeout(timer); reject(e); });
  });

  let socket = c.secure ? await openTls(null) : await openPlain();
  socket.setTimeout(c.timeoutMs);
  let io = reader(socket, c.timeoutMs);
  const expect = async (cmd, codes, what) => {
    const lines = await io.ask(cmd);
    const code = lines[lines.length - 1].code;
    if (!codes.includes(code)) throw new Error(`smtp ${what} failed (server said ${code})`);
    return lines;
  };

  try {
    await expect(null, [220], "greeting");
    const caps1 = await expect(`EHLO ${require("os").hostname()}`, [250], "EHLO");
    const offersTls = caps1.some((l) => /^STARTTLS/i.test(l.text));
    if (!c.secure && offersTls) {
      await expect("STARTTLS", [220], "STARTTLS");
      socket.removeAllListeners("data");
      socket = await openTls(socket);
      socket.setTimeout(c.timeoutMs);
      io = reader(socket, c.timeoutMs);
      await expect(`EHLO ${require("os").hostname()}`, [250], "EHLO-after-TLS");
    }
    if (c.user) {
      const lines = await io.ask("AUTH LOGIN");
      const first = lines[lines.length - 1].code;
      if (first !== 334) throw new Error(`smtp AUTH rejected (server said ${first})`);
      const u = await io.ask(b64(c.user));
      if (u[u.length - 1].code !== 334) throw new Error("smtp AUTH username rejected (535?)");
      const p = await io.ask(b64(c.pass));
      if (p[p.length - 1].code !== 235) throw new Error("smtp AUTH failed (535 bad credentials?)");
    }
    const fromAddr = /<([^<>]+)>/.exec(c.from)?.[1] || c.from;
    await expect(`MAIL FROM:<${fromAddr}>`, [250], "MAIL FROM");
    await expect(`RCPT TO:<${to}>`, [250, 251], "RCPT TO");
    await expect("DATA", [354], "DATA");
    const headers = [
      `From: ${c.from}`,
      `To: ${to}`,
      `Subject: ${q2047(subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "Date: " + new Date().toUTCString(),
      "",
    ].join("\r\n");
    const stuffed = String(text).split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
    await new Promise((resolve, reject) => {
      socket.write(headers + stuffed + "\r\n", (e) => (e ? reject(e) : resolve()));
    });
    await expect(".", [250], "message body");
    try { await io.ask("QUIT"); } catch { /* goodbye is best-effort */ }
    return { ok: true, provider: "smtp" };
  } finally {
    try { socket.destroy(); } catch { /* gone */ }
  }
}

function render(templateKey, vars = {}) {
  const v = (k, d = "") => (vars[k] == null ? d : String(vars[k]));
  switch (templateKey) {
    case "password_reset":
      return { subject: "إعادة تعيين كلمة المرور", text: `مرحباً ${v("name")},\nرابط إعادة التعيين (صالح ${v("ttlMinutes", "30")} دقيقة):\n${v("link")}\nإن لم تطلب ذلك تجاهل الرسالة.` };
    case "booking_confirmation":
      return { subject: "تأكيد الحجز", text: v("message") || `تم تأكيد حجزك في ${v("clinic")} يوم ${v("date")} الساعة ${v("time")}.` };
    case "reminder_24h":
    case "reminder_2h":
      return { subject: "تذكير بموعدك", text: v("message") || `تذكير: موعدك في ${v("clinic")} بتاريخ ${v("date")} الساعة ${v("time")}.` };
    case "appointment_cancelled":
      return { subject: "إلغاء الموعد", text: v("message") || `تم إلغاء موعدك في ${v("clinic")}.` };
    case "invoice":
      return { subject: "فاتورة جديدة", text: v("message") || `فاتورة جديدة بمبلغ ${v("total")} — المتبقي ${v("due")}.` };
    case "test":
      return { subject: "رسالة اختبار", text: v("message") || "رسالة اختبار من نظام عيادة." };
    default:
      return { subject: "إشعار", text: v("message") || templateKey };
  }
}

module.exports = {
  name: "smtp",
  async send({ to, templateKey, vars = {} }) {
    if (!to) throw new Error("smtp: missing recipient");
    const { subject, text } = render(templateKey, vars);
    return sendMail({ to: String(to).trim(), subject, text });
  },
  _internals: { cfg, render, q2047 },
};
