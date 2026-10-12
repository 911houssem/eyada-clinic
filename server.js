"use strict";
/**
 * نظام عيادة — Local hosting server (hardened)
 * ============================================
 * 1. Serves the mirrored static Next.js build from this folder.
 * 2. Implements every /api/* endpoint the UI calls, so login / register
 *    and the whole dashboard work offline.
 *
 * Zero dependencies. Data is persisted to data/db.json (atomic writes).
 *
 * Run:   node server.js
 *        node server.js --port 4000
 *        PORT=4000 node server.js
 */

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const notify = require("./notifiers");

/* ══════════════════════════ 1. CONFIG ══════════════════════════ */

const ROOT = __dirname;
const IS_PROD = process.env.NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

/**
 * Where the live database + logs live. Overridable so a production deploy can
 * keep the data OUTSIDE the web root (defence in depth: even if the static
 * gate below ever regressed, the data folder would not be under ROOT).
 */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const TMP_FILE = path.join(DATA_DIR, "db.json.tmp");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const RESETS_FILE = path.join(DATA_DIR, "resets.json");
const AUDIT_FILE = path.join(DATA_DIR, "audit.log");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const CREATE_OWNER = argv.includes("--create-owner");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || argOf("port") || 3000);
const AUTO_PORT = process.env.AUTO_PORT === "1" || argv.includes("--auto-port");

const LIMITS = {
  bodyBytes: 5 * 1024 * 1024, // 5 MB
  urlBytes: 16 * 1024, // 16 KB
  maxConnections: 512,
  headersTimeout: 20_000,
  requestTimeout: 60_000,
  keepAliveTimeout: 5_000,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000, // absolute lifetime (7 days)
  sessionIdleMs: 12 * 60 * 60 * 1000, // idle timeout (12 hours)
  sessionSweepMs: 10 * 60 * 1000, // sweep every 10 minutes
  backupIntervalMs: 6 * 60 * 60 * 1000, // auto-backup every 6 hours
  backupKeep: 14, // rotate: keep the newest N snapshots
  trashTtlMs: Number(process.env.TRASH_TTL_DAYS || 30) * 24 * 60 * 60 * 1000, // soft-deleted rows purge after this
  resetTtlMs: 30 * 60 * 1000, // password-reset link lifetime
  queueSweepMs: 20 * 1000, // notification-queue worker cadence
  reminderSweepMs: 60 * 1000, // reminder scan cadence
  notifMaxAttempts: Number(process.env.NOTIFY_MAX_ATTEMPTS || 3), // tries per queued message
  notifRatePerMin: Number(process.env.NOTIFY_RATE_PER_MIN || 30), // per-clinic send ceiling
};

/* ══════════════════════════ 2. LOGGING ══════════════════════════ */

const started = Date.now();
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

const log = (...a) => console.log(`[${stamp()}]`, ...a);
const warn = (...a) => console.warn(`[${stamp()}] WARN`, ...a);
const fail = (...a) => console.error(`[${stamp()}] ERROR`, ...a);

/**
 * Anything logged here also goes to data/server.log (size-capped).
 * Synchronous on purpose: every caller is a fatal path that may call
 * process.exit() immediately after, and an async stream would be cut off
 * before it flushed. This is never on a hot path, so the cost is fine.
 */
function toFile(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const f = path.join(DATA_DIR, "server.log");
    if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + ".1");
    fs.appendFileSync(f, `${line}\n`);
    if (IS_PROD) chmodSafe(f, 0o600);
  } catch {
    /* logging must never take the server down */
  }
}

/* ── Audit trail (data/audit.log) ──
 * Append-only JSON-lines record of security-relevant actions: sign-in and
 * sign-out, 2FA + password changes, impersonation, and every create/update/
 * delete of clinics, users, patients, appointments, invoices, records and
 * inventory. One line per event, size-capped so it can't grow forever.
 */
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Strip anything that looks like a secret before it reaches a log line. */
function redact(v) {
  return String(v == null ? "" : v)
    .replace(/(token|password|passwd|secret|authorization|code)=[^\s,;&"']+/gi, "$1=***");
}

function audit(req, action, meta = {}) {
  try {
    const s = req ? currentSession(req) : null;
    const entry = {
      ts: new Date().toISOString(),
      action,
      actorId: meta.actorId || (s && s.user.id) || null,
      username: redact(meta.username || (s && s.user.username) || ""),
      role: (s && s.user.role) || null,
      ip: req ? clientIp(req) : null,
      method: req ? req.method : null,
      path: req ? redact(String(req.url || "").split("?")[0]) : null,
    };
    if (meta.detail) entry.detail = redact(meta.detail);
    if (meta.status) entry.status = meta.status;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES)
      fs.renameSync(AUDIT_FILE, AUDIT_FILE + ".1");
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n");
    if (IS_PROD) chmodSafe(AUDIT_FILE, 0o600);
  } catch {
    /* auditing must never break a request */
  }
}

/* ── Automatic backups (data/backups) ──
 * A plain copy of the (already atomic) db.json, rotated to keep the newest
 * LIMITS.backupKeep snapshots. Runs on boot and every backupIntervalMs.
 */
function runBackup(reason = "scheduled") {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `db-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const dest = path.join(BACKUP_DIR, name);
    fs.copyFileSync(DB_FILE, dest);
    if (IS_PROD) chmodSafe(dest, 0o600);
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith("db-") && f.endsWith(".json"))
      .sort();
    while (files.length > LIMITS.backupKeep) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch { /* keep rotating */ }
    }
    log(`backup written (${reason}) → ${path.join(path.basename(BACKUP_DIR), name)}`);
    return dest;
  } catch (e) {
    warn("backup failed:", e.message);
    return null;
  }
}

/* ── Optional encryption at rest (AES-256-GCM) ──
 * Off by default (ENCRYPTION_KEY unset → identity, so existing deploys and the
 * test suite are unaffected). When ENCRYPTION_KEY is set, the medical fields
 * below are sealed the moment the database is written to disk and opened again
 * on load, so db.json / the rotated backups never contain that data in clear.
 * The in-memory dataset and the API responses stay plaintext (delivered over
 * TLS); only the file on disk is encrypted.
 */
const ENC_PREFIX = "enc:v1:";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || null;
const encKey = ENCRYPTION_KEY
  ? crypto.createHash("sha256").update(String(ENCRYPTION_KEY)).digest()
  : null;
const SENSITIVE_FIELDS = {
  patients: ["bloodType", "allergies"],
  records: ["chiefComplaint", "diagnosis", "treatment", "notes"],
  // The TOTP seed is a live second factor: it must never sit in db.json in clear
  // (or in the rotated backups). Legacy plaintext values are sealed on the first
  // save after upgrade — sealValue() skips anything already prefixed.
  users: ["twoFactorSecret", "twoFactorPendingSecret"],
  // Provider credentials (WhatsApp Cloud token, webhook HMAC secret, SMTP
  // password) are sealed exactly like medical data and never echoed by the API.
  notificationConfigs: ["whatsappToken", "webhookSecret", "smtpPassword"],
};

function sealValue(v) {
  if (!encKey || typeof v !== "string" || !v || v.startsWith(ENC_PREFIX)) return v;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
  const ct = Buffer.concat([cipher.update(v, "utf8"), cipher.final()]);
  return ENC_PREFIX + [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

function openValue(v) {
  if (typeof v !== "string" || !v.startsWith(ENC_PREFIX)) return v;
  if (!encKey) return v; // key missing: keep the ciphertext rather than lose data
  const [, , ivb, tagb, ctb] = v.split(":");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", encKey, Buffer.from(ivb, "base64url"));
    d.setAuthTag(Buffer.from(tagb, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctb, "base64url")), d.final()]).toString("utf8");
  } catch {
    return v; // wrong key / tampered value: never throw on read
  }
}

function mapSensitive(obj, fn) {
  for (const [coll, fields] of Object.entries(SENSITIVE_FIELDS)) {
    const rows = obj && obj[coll];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) for (const f of fields) if (typeof row[f] === "string" && row[f]) row[f] = fn(row[f]);
  }
  return obj;
}

/* ── Filesystem permissions ──
 * A production deploy must not leave db.json / sessions.json / audit.log / the
 * backups world-readable. Best effort: chmod is a no-op-ish on Windows (only the
 * read-only bit is honoured) and may fail on exotic filesystems, so every call
 * is swallowed. Only applied in production so dev + the test suite are untouched.
 */
function chmodSafe(p, mode) {
  try { fs.chmodSync(p, mode); } catch { /* best effort */ }
}

function hardenPerms() {
  if (!IS_PROD) return;
  chmodSafe(DATA_DIR, 0o700);
  for (const f of [DB_FILE, TMP_FILE, SESSIONS_FILE, AUDIT_FILE, path.join(DATA_DIR, "server.log")])
    if (fs.existsSync(f)) chmodSafe(f, 0o600);
  try {
    if (fs.existsSync(BACKUP_DIR))
      for (const f of fs.readdirSync(BACKUP_DIR)) chmodSafe(path.join(BACKUP_DIR, f), 0o600);
  } catch { /* best effort */ }
}

/* ══════════════════════════ 3. ERRORS ══════════════════════════ */

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expected = true;
  }
}

const badRequest = (m) => new AppError(400, m);
const unauthorized = (m = "غير مصرح") => new AppError(401, m);
const forbidden = (m = "غير مصرح") => new AppError(403, m);
const notFound = (m = "غير موجود") => new AppError(404, m);

/* ══════════════════════════ 4. UTILITIES ══════════════════════════ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const uid = (p = "id") => `${p}_${crypto.randomBytes(9).toString("hex")}`;
const now = () => new Date().toISOString();
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 64);
    const known = Buffer.from(hash, "hex");
    return known.length === test.length && crypto.timingSafeEqual(known, test);
  } catch {
    return false;
  }
}

/* ── TOTP (RFC 6238) — powers the optional two-factor login ── */
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 6-digit code for a 30-second time step. */
function totpAt(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac("sha1", key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | ((mac[off + 1] & 0xff) << 16)
    | ((mac[off + 2] & 0xff) << 8) | (mac[off + 3] & 0xff);
  return String(bin % 1000000).padStart(6, "0");
}

/** Accepts the current step ±1 to tolerate clock drift. */
function verifyTotp(secret, code, window = 1) {
  const c = String(code || "").replace(/\s/g, "");
  if (!secret || !/^\d{6}$/.test(c)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) if (totpAt(secret, counter + i) === c) return true;
  return false;
}

const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

function otpauthUrl(issuer, account, secret) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
    + "&algorithm=SHA1&digits=6&period=30";
}

const qrcodeLib = require("./lib/qrcode.js");

/** Renders any text as a crisp SVG QR code (empty string on failure). */
function qrSvg(text) {
  try {
    const qr = qrcodeLib(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let cells = "";
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) cells += `<rect x="${c}" y="${r}" width="1" height="1"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
      + `<rect width="${n}" height="${n}" fill="#ffffff"/><g fill="#000000">${cells}</g></svg>`;
  } catch {
    return "";
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== "string") return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

/** Never throws — returns {} for anything unusable. */
function readBody(req) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) {
      req.resume();
      return resolve({});
    }
    const chunks = [];
    let size = 0;
    let settled = false;

    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on("data", (c) => {
      size += c.length;
      if (size > LIMITS.bodyBytes) {
        chunks.length = 0;
        req.destroy(); // frees the socket instead of buffering forever
        return done({});
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return done({});
      try {
        const parsed = JSON.parse(raw);
        done(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        done({});
      }
    });
    req.on("error", () => done({}));
    req.on("aborted", () => done({}));
  });
}

/**
 * Single funnel for every response. Guarantees we never write twice and
 * never touch a socket that is already gone.
 */
function respond(res, status, payload, headers = {}) {
  if (res.writableEnded || res.destroyed) return false;

  const body = typeof payload === "string" ? payload : JSON.stringify(payload);

  if (res.headersSent) {
    // Headers already flushed (e.g. mid-stream) — just close cleanly.
    try { res.end(); } catch { /* socket gone */ }
    return false;
  }

  const type =
    typeof payload === "string"
      ? headers["Content-Type"] || MIME[".txt"]
      : MIME[".json"];

  try {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(body);
    return true;
  } catch (e) {
    warn("respond failed:", e.message);
    try { res.end(); } catch { /* socket gone */ }
    return false;
  }
}

const json = (res, status, payload) => respond(res, status, payload);

/* ══════════════════════════ 5. DATABASE ══════════════════════════ */

const EMPTY = {
  users: [], clinics: [], patients: [], appointments: [], invoices: [],
  tasks: [], records: [], inventory: [], messages: [], services: [],
  plans: [], clinicSubscriptions: [], offers: [], auditLog: [],
  notificationConfigs: [], notificationQueue: [], notificationLog: [],
};

/**
 * The bookable menu every clinic starts with. `durationMin` is the single
 * source of truth for how long a visit lasts: the owner edits it per service in
 * settings, the public page shows it, and the slot grid steps by it.
 */
const DEFAULT_SERVICES = [
  { name: "كشفية عامة", description: "زيارة طبيب أول مع مراجعة السجل الطبي", durationMin: 20, price: 150 },
  { name: "استشارة متابعة", description: "متابعة العلاج بعد زيارة سابقة", durationMin: 20, price: 100 },
  { name: "جلسة علاج", description: "جلسة علاج طبي مطولة", durationMin: 40, price: 250 },
];

/** Give a brand-new clinic its default bookable menu. */
function seedDefaultServices(clinicId) {
  for (const [i, s] of DEFAULT_SERVICES.entries()) {
    db.services.push({
      id: uid("svc"), clinicId, name: s.name, description: s.description,
      durationMin: s.durationMin, price: s.price,
      isActive: true, sortOrder: i, createdAt: now(),
    });
  }
}

const AR_MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

/** The subscription catalogue. Fresh objects (new ids) on every call. */
function defaultPlans() {
  return [
    { id: uid("plan"), name: "الأساسية", description: "مثالية للعيادة الواحدة التي بدأت رحلتها",
      price: 199, yearlyPrice: 1990, maxPatients: 500, maxDoctors: 2, maxClinics: 1,
      isPopular: false, isActive: true, sortOrder: 0,
      features: ["إدارة مواعيد غير محدودة","ملفات المرضى الأساسية","فواتير مع ضريبة ١٥٪","تذكيرات عبر الرسائل النصية","دعم عبر البريد الإلكتروني"] },
    { id: uid("plan"), name: "الاحترافية", description: "الخيار الأكثر طلباً من أطباء العيادات النشطة",
      price: 399, yearlyPrice: 3990, maxPatients: 2000, maxDoctors: 5, maxClinics: 1,
      isPopular: true, isActive: true, sortOrder: 1,
      features: ["كل مزايا الخطة الأساسية","سجل طبي كامل وتاريخ الزيارات","إدارة المخزون والأدوية","لوحة تحكم وتحليلات متقدمة","مهام وملاحظات الفريق","دعم ذو أولوية عبر المحادثة"] },
    { id: uid("plan"), name: "المتقدمة", description: "للساسل الطبية والعيادات متعددة الفروع",
      price: 799, yearlyPrice: 7990, maxPatients: 10000, maxDoctors: 20, maxClinics: 5,
      isPopular: false, isActive: true, sortOrder: 2,
      features: ["كل مزايا الخطة الاحترافية","إدارة متعددة العيادات","صلاحيات متقدمة لكل فرع","تقارير مالية مفصّلة","محادثة داخلية بين الفرق","مدير حساب مخصص"] },
  ];
}

function seed() {
  const nowIso = now();
  const clinicId = uid("clinic");

  const plans = defaultPlans();

  const mkUser = (username, password, fullName, phone, email, role) => ({
    id: uid("user"), username, password: hashPassword(password), fullName,
    phone, email, role, clinicId, twoFactorEnabled: false, trustedDevices: [], createdAt: nowIso,
  });

  const users = [
    mkUser("admin", "admin123", "مالك العيادة", "0500000000", "admin@eyada.local", "super_admin"),
    mkUser("doctor", "doctor123", "د. أحمد المنصور", "0500000001", "doctor@eyada.local", "doctor"),
    mkUser("reception", "reception123", "أ. سارة العتيبي", "0500000002", "reception@eyada.local", "reception"),
    // helpdesk — the only account a clinic may open a conversation with
    { ...mkUser("support", "support123", "الدعم الفني", "0500000003", "support@eyada.local", "support"), clinicId: null },
  ];

  const clinics = [{
    id: clinicId, name: "عيادة النور للأسنان", phone: "0500000000",
    address: "الرياض — حي العليا", currency: "SAR",
    paymentMode: "postpaid", ownerId: users[0].id, // the seeded admin IS the site owner
    bookingSlug: "al-noor-clinic", bookingEnabled: true, createdAt: nowIso,
  }];

  const mkPatient = (fullName, gender, age, phone) => ({
    id: uid("pat"), clinicId, fullName, gender, age, phone, email: "",
    bloodType: "O+", allergies: "", createdAt: nowIso,
  });

  const patients = [
    mkPatient("محمد أحمد", "male", 32, "0551111111"),
    mkPatient("فاطمة سعد", "female", 27, "0552222222"),
    mkPatient("عبدالله خالد", "male", 45, "0553333333"),
    mkPatient("نورة العتيبي", "female", 38, "0554444444"),
    mkPatient("سعد المطيري", "male", 51, "0555555555"),
  ];

  const base = new Date();
  const at = (h, m) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const mkAppt = (patientId, doctorId, h, m, title, type, status) => ({
    id: uid("apt"), clinicId, patientId, doctorId, title, type,
    startTime: at(h, m), endTime: at(h, m + 30), status, notes: "", createdAt: nowIso,
  });

  const appointments = [
    mkAppt(patients[0].id, users[1].id, 9, 0, "كشف طبي", "consultation", "scheduled"),
    mkAppt(patients[1].id, users[1].id, 10, 30, "تنظيف وتلميع", "regular", "scheduled"),
    mkAppt(patients[2].id, users[1].id, 12, 0, "حشوة تجميلية", "regular", "scheduled"),
    mkAppt(patients[3].id, users[1].id, 14, 30, "متابعة علاج", "follow_up", "scheduled"),
  ];

  const mkInvoice = (patientId, subtotal, tax, total, paid, status, method, item) => ({
    id: uid("inv"), clinicId, patientId, subtotal, insuranceDiscount: 0,
    taxPercentage: 15, taxAmount: tax, total, paidAmount: paid, dueAmount: total - paid,
    status, paymentMethod: method,
    items: [{ item_type: "service", item_name: item, unit_price: subtotal, quantity: 1 }],
    createdAt: nowIso,
  });

  const invoices = [
    mkInvoice(patients[0].id, 200, 30, 230, 230, "paid", "cash", "كشف طبي"),
    mkInvoice(patients[1].id, 350, 52.5, 402.5, 200, "partial", "card", "تنظيف وتلميع"),
  ];

  const offers = [
    { id: uid("offer"), title: "خصم البداية للعيادات الجديدة",
      description: "خصم ٥٠٪ على أول ثلاثة أشهر عند الاشتراك في أي خطة سنوية.",
      badge: "للعيادات الجديدة", discountType: "percentage", discountValue: 50,
      startDate: nowIso, endDate: new Date(Date.now() + 60 * 864e5).toISOString(), isActive: true },
    { id: uid("offer"), title: "وفّر شهرين مع الدفع السنوي",
      description: "ادفع سنوياً واحصل على شهرين مجاناً في جميع الخطط.",
      badge: "الأكثر طلباً", discountType: "fixed", discountValue: 400,
      startDate: nowIso, endDate: new Date(Date.now() + 90 * 864e5).toISOString(), isActive: true },
    { id: uid("offer"), title: "عرض السلاسل الطبية",
      description: "خصم ٢٠٪ على كل فرع إضافي في خطة المتقدمة.",
      badge: "للعيادات المتعددة", discountType: "percentage", discountValue: 20,
      startDate: nowIso, endDate: new Date(Date.now() + 120 * 864e5).toISOString(), isActive: true },
  ];

  return {
    ...EMPTY, users, clinics, patients, appointments, invoices, offers, plans,
    tasks: [{
      id: uid("task"), clinicId, title: "طلب مخزون التخدير",
      description: "تنبيه للمورد باقتراب نفاد المخزون", assignedTo: users[0].id,
      priority: "high", status: "todo",
      dueDate: new Date(Date.now() + 2 * 864e5).toISOString(), createdAt: nowIso,
    }],
    records: [],
    inventory: [
      { id: uid("inv_item"), clinicId, itemName: "مخدر ليدوكايين", itemNameEn: "Lidocaine",
        category: "medication", quantity: 24, maxStock: 50, minStock: 10,
        unitPrice: 35, cost: 20, supplier: "شركة الدواء", createdAt: nowIso },
      { id: uid("inv_item"), clinicId, itemName: "قفازات نيتريل", itemNameEn: "Nitrile Gloves",
        category: "supply", quantity: 120, maxStock: 200, minStock: 40,
        unitPrice: 12, cost: 7, supplier: "شركة المعدات الطبية", createdAt: nowIso },
    ],
    messages: [],
    clinicSubscriptions: [{
      id: uid("cs"), clinicId, planId: plans[1].id, status: "active", startDate: nowIso,
      endDate: new Date(Date.now() + 365 * 864e5).toISOString(), trialEndDate: null,
      billingCycle: "monthly", notes: "",
    }],
  };
}

/**
 * A production database starts EMPTY except for the subscription catalogue.
 * No demo clinic, no demo patients/appointments, and — critically — no
 * well-known demo accounts. The first site owner is created separately from
 * operator-supplied credentials (OWNER_USERNAME / OWNER_PASSWORD or
 * `node server.js --create-owner`).
 */
function seedProduction() {
  return { ...EMPTY, plans: defaultPlans() };
}

/** The first site owner, built from OWNER_* env vars (null when unset). */
function makeOwnerFromEnv() {
  const username = String(process.env.OWNER_USERNAME || "").trim();
  const password = process.env.OWNER_PASSWORD || "";
  if (!username || !password) return null;
  checkPasswordPolicy(password);
  return {
    id: uid("user"), username, password: hashPassword(password),
    fullName: String(process.env.OWNER_NAME || "مالك الموقع").trim() || "مالك الموقع",
    phone: String(process.env.OWNER_PHONE || "").trim(),
    email: String(process.env.OWNER_EMAIL || "").trim(),
    role: "super_admin", clinicId: null, permissions: {},
    twoFactorEnabled: false, trustedDevices: [], createdAt: now(),
  };
}

/** Repairs anything missing/corrupt so one bad field can't break boot. */
function normalize(raw) {
  const db = { ...EMPTY, ...(raw && typeof raw === "object" ? raw : {}) };
  for (const k of Object.keys(EMPTY)) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
  return db;
}

let db;

/**
 * One-time repairs applied on every boot (idempotent).
 *  - exactly one site owner (super_admin); everyone else who was auto-promoted
 *    by an older register endpoint becomes a clinic owner (admin)
 *  - "receptionist" -> "reception" (the only spelling the UI knows)
 *  - clinics always have a bookingSlug / bookingEnabled flag
 */
function migrate() {
  const notes = [];

  for (const u of db.users) {
    const role = normalizeRole(u.role);
    if (!role) { u.role = "reception"; notes.push(`user ${u.username}: unknown role -> reception`); }
    else if (role !== u.role) { notes.push(`user ${u.username}: ${u.role} -> ${role}`); u.role = role; }
  }

  const owners = db.users.filter((u) => u.role === "super_admin")
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const siteOwner = owners[0] || null;
  if (!siteOwner && db.users.length) {
    const first = db.users.slice().sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))[0];
    first.role = "super_admin";
    notes.push(`${first.username} promoted to site owner (no super_admin existed)`);
  } else {
    for (const u of owners.slice(1)) {
      u.role = "admin";
      notes.push(`${u.username} demoted super_admin -> admin (صاحب عيادة)`);
    }
  }

  // clinics left behind by deleted accounts
  const usedIn = (cid) =>
    db.users.some((u) => u.clinicId === cid) ||
    db.patients.some((x) => x.clinicId === cid) ||
    db.appointments.some((x) => x.clinicId === cid) ||
    db.invoices.some((x) => x.clinicId === cid) ||
    db.tasks.some((x) => x.clinicId === cid) ||
    db.records.some((x) => x.clinicId === cid) ||
    db.inventory.some((x) => x.clinicId === cid);
  // deliberately NOT db.services: migrate() seeds a default menu into every
  // clinic, so counting services would make each clinic look "used" forever and
  // an abandoned clinic could never be pruned

  const orphans = db.clinics.filter((c) => !usedIn(c.id));
  if (orphans.length) {
    const dead = new Set(orphans.map((c) => c.id));
    db.clinics = db.clinics.filter((c) => !dead.has(c.id));
    db.clinicSubscriptions = db.clinicSubscriptions.filter((s) => !dead.has(s.clinicId));
    db.services = db.services.filter((s) => !dead.has(s.clinicId));
    notes.push(`removed ${orphans.length} empty clinic(s) with no owner or data`);
  }

  // services can outlive their clinic (older build, hand-edited db, a clinic
  // pruned before this sweep existed) and would otherwise linger forever
  const liveClinics = new Set(db.clinics.map((c) => c.id));
  const stray = db.services.filter((s) => !liveClinics.has(s.clinicId)).length;
  if (stray) {
    db.services = db.services.filter((s) => liveClinics.has(s.clinicId));
    notes.push(`dropped ${stray} service(s) belonging to a clinic that no longer exists`);
  }

  for (const c of db.clinics) {
    if (c.ownerId && !db.users.some((u) => u.id === c.ownerId)) {
      const heir = db.users.find((u) => u.clinicId === c.id);
      if (heir) { c.ownerId = heir.id; notes.push(`clinic ${c.name}: ownerId -> ${heir.username}`); }
      else if (siteOwner) { c.ownerId = siteOwner.id; notes.push(`clinic ${c.name}: ownerId -> ${siteOwner.username} (site owner)`); }
      else c.ownerId = "";
    }
  }

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
  for (const c of db.clinics) {
    // keep only URL-safe ASCII slugs (older ones may be Arabic -> percent-encoded links)
    if (!c.bookingSlug || !SAFE_SLUG.test(c.bookingSlug) || db.clinics.filter((o) => o.bookingSlug === c.bookingSlug).length > 1) {
      c.bookingSlug = uniqueBookingSlug(c.bookingSlug && SAFE_SLUG.test(c.bookingSlug) ? c.bookingSlug : c.name);
      notes.push(`clinic ${c.name}: booking slug = ${c.bookingSlug}`);
    }
    if (c.bookingEnabled === undefined) c.bookingEnabled = true;
    if (c.paymentMode === undefined) c.paymentMode = "postpaid";
  }

  // every bookable clinic needs at least one service, otherwise the public
  // page has nothing to offer and the duration has no meaning
  for (const c of db.clinics) {
    if (!db.services.some((s) => s.clinicId === c.id)) {
      seedDefaultServices(c.id);
      notes.push(`clinic ${c.name}: seeded ${DEFAULT_SERVICES.length} default service(s)`);
    }
  }

  // every account needs an explicit role and a permission grant
  for (const u of db.users) {
    const role = normalizeRole(u.role);
    if (!role) {
      u.role = "reception";
      notes.push(`${u.username}: unknown role -> reception`);
    } else if (role !== u.role) {
      notes.push(`${u.username}: role ${u.role} -> ${role}`);
      u.role = role;
    }
    if (!u.permissions || typeof u.permissions !== "object") {
      u.permissions = {};
      notes.push(`${u.username}: permissions initialised for ${u.role}`);
    }
  }

  // clinics need a helpdesk account to talk to
  if (!db.users.some((u) => u.role === "support")) {
    // In production the helpdesk account gets an unguessable password that is
    // never logged (the owner can reset it from the admin UI if needed). In dev
    // it keeps the familiar support/support123 so the demo stays usable.
    const pw = IS_PROD ? crypto.randomBytes(24).toString("base64url") : "support123";
    db.users.push({
      id: uid("user"), username: "support", password: hashPassword(pw),
      fullName: "الدعم الفني", phone: "", email: "support@eyada.local",
      role: "support", clinicId: null, permissions: {},
      twoFactorEnabled: false, trustedDevices: [], createdAt: now(),
    });
    notes.push(IS_PROD ? "created helpdesk account (support; password not logged)"
      : "created support account (support / support123)");
  }

  // soft-delete migration: give every trashable row explicit deletedAt/deletedBy
  const soft = migrateSoftDelete();
  if (soft) notes.push(`soft-delete: initialised deletedAt on ${soft} row(s)`);

  return notes;
}

function load() {
  loadSessions();
  loadResets();
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      const parsed = JSON.parse(raw);
      mapSensitive(parsed, openValue); // decrypt medical fields if ENCRYPTION_KEY is set
      db = normalize(parsed);
      const notes = migrate();
      // Move any legacy raw-token sessions out of db.json and into the hashed
      // session store so upgrades don't log everyone out (and old tokens can
      // no longer be replayed straight from a leaked db.json).
      if (db.sessions && typeof db.sessions === "object" && !Array.isArray(db.sessions)) {
        let moved = 0;
        for (const [token, s] of Object.entries(db.sessions)) {
          if (s && typeof s.userId === "string") {
            const h = sha256(token);
            if (!sessions[h]) { sessions[h] = s; moved++; }
          }
        }
        delete db.sessions;
        if (moved) { log(`migrated ${moved} legacy session(s) into the hashed session store`); saveSessions(); }
        save(true);
      }
      const n = pruneSessions();
      if (n) { log(`pruned ${n} expired session(s) on boot`); saveSessions(); }
      if (notes.length) { for (const line of notes) log(`migrated: ${line}`); save(true); }
      log(`database loaded — ${db.users.length} users, ${db.patients.length} patients, ${Object.keys(sessions).length} sessions`);
      return;
    }
  } catch (e) {
    fail("db.json unreadable, reseeding:", e.message);
    try { fs.renameSync(DB_FILE, `${DB_FILE}.corrupt-${Date.now()}`); } catch { /* best effort */ }
  }
  if (IS_PROD) {
    // Production never seeds a demo clinic or demo accounts. Start from the
    // empty-but-catalogued database, add the owner from OWNER_* env if present,
    // and refuse to boot without a site owner (unless we are about to create one).
    db = normalize(seedProduction());
    let owner = null;
    try { owner = makeOwnerFromEnv(); }
    catch (e) { fail("OWNER_PASSWORD rejected:", e.message); process.exit(1); }
    if (owner) { db.users.push(owner); log(`seeded site owner from OWNER_* env — ${owner.username}`); }
    migrate();
    if (!db.users.some((u) => u.role === "super_admin") && !CREATE_OWNER) {
      fail("production has no site owner. Set OWNER_USERNAME + OWNER_PASSWORD (min 12 chars),");
      fail("or run: node server.js --create-owner");
      process.exit(1);
    }
    save(true);
    log("production database initialised (empty — no demo data)");
  } else {
    db = normalize(seed());
    migrate();
    save(true);
    log("database seeded with demo data");
  }
}

/** Debounced + atomic (write to .tmp then rename) so a crash mid-write can't corrupt it. */
let saveTimer = null;
let flushing = null;   // in-flight write promise (so callers can await persistence)
let dirtyAgain = false;

function save(immediate = false) {
  if (immediate) return flush();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 80);
  if (saveTimer.unref) saveTimer.unref();
  return undefined;
}

/**
 * Serialized, awaitable write. A caller that arrives mid-write waits for it and
 * then persists its own state, so `await save(true)` in a short-lived process
 * (e.g. --create-owner) is guaranteed to have landed before exit.
 */
async function flush() {
  if (flushing) {
    dirtyAgain = true;
    try { await flushing; } catch { /* the first writer reported it */ }
    if (dirtyAgain) { dirtyAgain = false; return flush(); }
    return;
  }
  dirtyAgain = false;
  flushing = (async () => {
    let handle = null;
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      handle = await fsp.open(TMP_FILE, "w");
      const out = encKey ? mapSensitive(structuredClone(db), sealValue) : db;
      await handle.writeFile(JSON.stringify(out, null, 2), "utf8");
      await handle.sync(); // flush to disk before the rename, so a power cut can't leave a renamed-but-empty file
      await handle.close();
      handle = null;
      await fsp.rename(TMP_FILE, DB_FILE); // atomic on Windows + POSIX
      hardenPerms();
    } catch (e) {
      fail("could not persist database:", e.message);
    } finally {
      if (handle) { try { await handle.close(); } catch { /* already closed */ } }
    }
  })();
  try { await flushing; } finally { flushing = null; }
}

/* ══════════════════════════ 6. SESSIONS ══════════════════════════
 * Sessions live in their own file (data/sessions.json), NOT mixed into the
 * clinic dataset, and only a SHA-256 HASH of each token is stored: a leaked
 * sessions.json cannot be replayed as a cookie. The raw token exists only in
 * the client's HttpOnly cookie.
 */

const SESSION_COOKIE = "eyada_session";
const DEVICE_COOKIE = "eyada_device";
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

/** True when the request arrived over TLS (or we are told to assume so). */
function isSecureRequest(req) {
  if (req && req.socket && req.socket.encrypted) return true;
  if (IS_PROD) return true;
  if (TRUST_PROXY && req) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    if (proto === "https") return true;
  }
  return false;
}

function cookieAttrs(req, maxAge) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecureRequest(req) ? "; Secure" : ""}`;
}

let sessions = {};

function loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) || {}; }
  catch { sessions = {}; }
}

let sessionsTimer = null;
function saveSessions() {
  clearTimeout(sessionsTimer);
  sessionsTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SESSIONS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(sessions), "utf8");
      fs.renameSync(tmp, SESSIONS_FILE);
      hardenPerms();
    } catch (e) { fail("could not persist sessions:", e.message); }
  }, 80);
  if (sessionsTimer.unref) sessionsTimer.unref();
}

/** Drops sessions past their absolute age or idle timeout. */
function pruneSessions() {
  const t = Date.now();
  let removed = 0;
  for (const [hash, s] of Object.entries(sessions)) {
    if (!s || typeof s.userId !== "string"
      || t - (Date.parse(s.createdAt) || 0) > LIMITS.sessionTtlMs
      || t - (Date.parse(s.lastSeen || s.createdAt) || 0) > LIMITS.sessionIdleMs) {
      delete sessions[hash];
      removed++;
    }
  }
  return removed;
}

/** Every session row of a user (excluding one optional hash). */
function userSessionHashes(userId, keepHash = null) {
  return Object.keys(sessions).filter((h) => sessions[h].userId === userId && h !== keepHash);
}

function createSession(req, res, userId, impersonatorId = null) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[sha256(token)] = { userId, impersonatorId, createdAt: now(), lastSeen: now() };
  saveSessions();
  const cookies = [`${SESSION_COOKIE}=${token}; ${cookieAttrs(req, LIMITS.sessionTtlMs / 1000)}`];
  if (impersonatorId) {
    const owner = db.users.find((u) => u.id === impersonatorId);
    cookies.push(
      `impersonator_name=${encodeURIComponent(owner ? owner.fullName : "المالك")}; Path=/; SameSite=Lax` +
      `; Max-Age=86400${isSecureRequest(req) ? "; Secure" : ""}`
    );
  } else {
    cookies.push(`impersonator_name=; Path=/; SameSite=Lax; Max-Age=0${isSecureRequest(req) ? "; Secure" : ""}`);
  }
  appendCookies(res, cookies);
  return token;
}

function appendCookies(res, cookies) {
  if (res.headersSent) return;
  const existing = res.getHeader("Set-Cookie");
  const all = [].concat(existing || [], cookies);
  try { res.setHeader("Set-Cookie", all); } catch { /* headers already out */ }
}

function clearSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const hash = token ? sha256(token) : null;
  if (hash && sessions[hash]) {
    delete sessions[hash];
    saveSessions();
  }
  const secure = isSecureRequest(req) ? "; Secure" : "";
  appendCookies(res, [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `impersonator_name=; Path=/; SameSite=Lax; Max-Age=0${secure}`,
  ]);
}

function currentSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const s = sessions[hash];
  if (!s) return null;
  const t = Date.now();
  if (t - (Date.parse(s.createdAt) || 0) > LIMITS.sessionTtlMs
    || t - (Date.parse(s.lastSeen || s.createdAt) || 0) > LIMITS.sessionIdleMs) {
    delete sessions[hash];
    saveSessions();
    return null;
  }
  const user = db.users.find((u) => u.id === s.userId);
  if (!user) return null;
  s.lastSeen = now(); // cheap; flushed by the debounced save
  return { token, hash, user, impersonatorId: s.impersonatorId || null };
}

function requireSession(req) {
  const s = currentSession(req);
  if (!s) throw unauthorized();
  return s;
}

function requireSuperAdmin(req) {
  const s = requireSession(req);
  if (s.user.role !== "super_admin") throw forbidden("هذا الإجراء متاح لمالك الموقع فقط");
  return s;
}

/* ── Trusted devices (real, hashed, revocable) ── */

function pruneTrustedDevices(user) {
  if (!Array.isArray(user.trustedDevices)) { user.trustedDevices = []; return; }
  const t = Date.now();
  user.trustedDevices = user.trustedDevices.filter(
    (d) => d && d.tokenHash && (!d.expiresAt || Date.parse(d.expiresAt) > t)
  );
}

function findTrustedDevice(req, user) {
  const raw = parseCookies(req)[DEVICE_COOKIE];
  if (!raw || !user) return null;
  pruneTrustedDevices(user);
  const h = sha256(raw);
  return user.trustedDevices.find((d) => d.tokenHash === h) || null;
}

function issueTrustedDevice(req, res, user, name) {
  const token = crypto.randomBytes(32).toString("hex");
  pruneTrustedDevices(user);
  user.trustedDevices.push({
    id: uid("dev"), name: String(name || "جهاز جديد").slice(0, 60),
    tokenHash: sha256(token), createdAt: now(), lastUsedAt: now(),
    expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS).toISOString(),
  });
  // keep at most the 10 newest remembered devices
  if (user.trustedDevices.length > 10) user.trustedDevices = user.trustedDevices.slice(-10);
  save();
  appendCookies(res, [`${DEVICE_COOKIE}=${token}; ${cookieAttrs(req, TRUSTED_DEVICE_TTL_MS / 1000)}`]);
  return token;
}

/** Any change that should force every remembered device to re-verify. */
function revokeTrustedDevices(req, res, user) {
  user.trustedDevices = [];
  save();
  appendCookies(res, [`${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureRequest(req) ? "; Secure" : ""}`]);
}

/* ── Password policy ── */

// Tiny, dependency-free subset of the well-known worst passwords + obvious
// patterns. Production requires 12+ chars and rejects these; dev stays at 8 so
// the existing test accounts keep working.
const COMMON_PASSWORDS = new Set([
  "123456", "12345678", "123456789", "1234567890", "password", "password1",
  "qwerty", "qwerty123", "111111", "000000", "admin", "admin123", "administrator",
  "letmein", "welcome", "iloveyou", "monkey", "dragon", "abc123", "sunshine",
  "princess", "football", "baseball", "master", "login", "passw0rd", "test1234",
  "aaaaaaaa", "a1234567", "changeme", "default",
]);

function passwordMin() { return IS_PROD ? 12 : 8; }

/** Throws a 400 for weak passwords; returns the (trimmed) password otherwise. */
function checkPasswordPolicy(pw) {
  const min = passwordMin();
  if (typeof pw !== "string" || pw.length < min)
    throw badRequest(`كلمة المرور يجب أن تكون ${min} أحرف على الأقل`);
  // The "common password" blocklist only applies in production so the demo
  // accounts the test suites rely on keep working in development.
  if (!IS_PROD) return pw;
  const low = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(low)) throw badRequest("كلمة المرور شائعة جداً، اختر كلمة أقوى");
  if (/^(.)\1+$/.test(pw)) throw badRequest("كلمة المرور ضعيفة جداً");
  if (/^(?:123|000|abc|qwe|password|admin)/i.test(pw))
    throw badRequest("كلمة المرور ضعيفة جداً");
  return pw;
}

/* ── Login throttling (per IP + username) ── */

const loginAttempts = new Map(); // key -> { count, until }
const LOGIN_MAX = Number(process.env.LOGIN_MAX || (IS_PROD ? 10 : 12));
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function loginKey(req, username) {
  return `${clientIp(req)}|${String(username || "").toLowerCase()}`;
}

function assertNotLockedOut(req, username) {
  const r = loginAttempts.get(loginKey(req, username));
  if (r && r.until > Date.now() && r.count >= LOGIN_MAX)
    throw new AppError(429, "عدد محاولات الدخول كبير. حاول مرة أخرى بعد ١٥ دقيقة.");
}

function recordLoginFailure(req, username) {
  const key = loginKey(req, username);
  const r = loginAttempts.get(key) || { count: 0, until: 0 };
  if (r.until <= Date.now()) { r.count = 0; r.until = Date.now() + LOGIN_WINDOW_MS; }
  r.count++;
  loginAttempts.set(key, r);
}

function clearLoginFailures(req, username) { loginAttempts.delete(loginKey(req, username)); }

/* ── Password-reset tokens (hashed at rest, single use, short TTL) ── */

let resets = {};

function loadResets() {
  if (!fs.existsSync(RESETS_FILE)) return;
  try { resets = JSON.parse(fs.readFileSync(RESETS_FILE, "utf8")) || {}; }
  catch { resets = {}; }
}

let resetsTimer = null;
function saveResets() {
  clearTimeout(resetsTimer);
  resetsTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = RESETS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(resets), "utf8");
      fs.renameSync(tmp, RESETS_FILE);
      hardenPerms();
    } catch (e) { fail("could not persist reset tokens:", e.message); }
  }, 80);
  if (resetsTimer.unref) resetsTimer.unref();
}

/** Drops used/expired reset tokens; returns how many were removed. */
function pruneResets() {
  const t = Date.now();
  let removed = 0;
  for (const [h, r] of Object.entries(resets)) {
    if (!r || r.usedAt || (Date.parse(r.expiresAt) || 0) < t) { delete resets[h]; removed++; }
  }
  return removed;
}

/** Rate limit reset requests per IP + account (uniform 429). */
const resetRequests = new Map();
const RESET_MAX = Number(process.env.RESET_MAX || (IS_PROD ? 5 : 50));
const RESET_WINDOW_MS = 15 * 60 * 1000;

function assertResetAllowed(req, account) {
  const key = `${clientIp(req)}|${String(account || "").toLowerCase()}`;
  const r = resetRequests.get(key) || { count: 0, until: 0 };
  if (r.until <= Date.now()) { r.count = 0; r.until = Date.now() + RESET_WINDOW_MS; }
  r.count++;
  resetRequests.set(key, r);
  if (r.count > RESET_MAX)
    throw new AppError(429, "طلبات كثيرة. حاول مرة أخرى بعد قليل.");
}

/**
 * Clinic owner = "admin" (صاحب عيادة). Site owner = "super_admin" (مالك الموقع).
 * A clinic owner may run their own clinic and staff; only the site owner gets
 * platform-wide powers (impersonation, global plans/offers, full backup).
 */
function requireClinicOwner(req) {
  const s = requireSession(req);
  if (s.user.role !== "super_admin" && s.user.role !== "admin")
    throw forbidden("هذا الإجراء متاح لصاحب العيادة أو مالك الموقع فقط");
  return s;
}

const isSiteOwner = (u) => !!u && u.role === "super_admin";

/** Clinics this user is allowed to touch. */
function ownedClinicIds(user) {
  if (isSiteOwner(user)) return db.clinics.map((c) => c.id);
  const ids = new Set();
  if (user.clinicId) ids.add(user.clinicId);
  for (const c of db.clinics) if (c.ownerId === user.id) ids.add(c.id);
  return [...ids];
}

/**
 * The clinic a create/write should target. A caller may only pass a clinicId
 * they actually own; anything else is a hard 403 (never a silent fallback that
 * could write into a stranger's clinic).
 */
function resolveWriteClinic(user, requested) {
  const mine = user.clinicId || null;
  if (!requested || requested === mine) {
    if (mine) return mine;
    if (isSiteOwner(user)) return (db.clinics[0] && db.clinics[0].id) || "";
    throw forbidden("لا توجد عيادة مرتبطة بحسابك");
  }
  if (isSiteOwner(user) || ownedClinicIds(user).includes(requested)) return requested;
  throw forbidden("لا يمكنك الوصول إلى عيادة أخرى");
}

/** Guard for editing/deleting a record that carries a clinicId. */
function assertRecordClinic(user, record, label = "السجل") {
  if (!record) throw notFound(`${label} غير موجود`);
  if (isSiteOwner(user) || ownedClinicIds(user).includes(record.clinicId)) return record;
  throw forbidden("لا يمكنك الوصول إلى سجل عيادة أخرى");
}

/** Records hang off a patient, so ownership is checked through the patient. */
function ownedPatient(user, patientId) {
  const p = db.patients.find((x) => x.id === patientId);
  if (!p) throw notFound("المريض غير موجود");
  if (isSiteOwner(user) || ownedClinicIds(user).includes(p.clinicId)) return p;
  throw forbidden("لا يمكنك الوصول إلى مريض عيادة أخرى");
}

/* ── ROLES & PERMISSIONS ──
 * The compiled UI already hides sidebar items with `user.permissions[key]`, and
 * the keys are fixed there, so the catalog below must keep those exact names.
 * A clinic owner grants these to the staff they hire, per user, via
 * PUT /api/users {id, permissions}. super_admin (site owner) and support are
 * platform roles and cannot be granted by a clinic owner.
 */
const ROLES = ["super_admin", "support", "admin", "doctor", "reception", "accountant", "nurse"];
/** Roles a clinic owner is allowed to hand out to their own staff. */
const GRANTABLE_ROLES = ["doctor", "reception", "accountant", "nurse"];
const ROLE_LABELS = {
  super_admin: "مالك الموقع",
  support: "الدعم",
  admin: "صاحب عيادة",
  doctor: "طبيب",
  reception: "استقبال",
  accountant: "محاسب",
  nurse: "تمريض",
};

const PERMISSIONS = [
  { key: "dashboard", label: "لوحة التحكم", group: "عام", hint: "عرض لوحة المؤشرات والإحصائيات" },
  { key: "patients", label: "المرضى", group: "العيادة", hint: "إضافة وتعديل ملفات المرضى" },
  { key: "appointments", label: "المواعيد", group: "العيادة", hint: "حجز وتعديل وإلغاء المواعيد" },
  { key: "records", label: "السجلات الطبية", group: "العيادة", hint: "الاطلاع على السجل الطبي والتشخيصات" },
  { key: "invoices", label: "الفواتير", group: "المالية", hint: "إنشاء الفواتير والتحصيل والديون" },
  { key: "inventory", label: "المخزون", group: "المالية", hint: "الأدوية والمواد وبيع المنتجات" },
  { key: "reports", label: "التقارير", group: "المالية", hint: "التقارير والتحليلات المالية" },
  { key: "settings", label: "الإعدادات", group: "الإدارة", hint: "إعدادات العيادة وإدارة الموظفين" },
];
const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const NO_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
const ALL_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));

/** Default grant per role. Anything the owner sets on the user wins. */
const ROLE_PERMISSIONS = {
  super_admin: { ...ALL_PERMISSIONS },
  // support works the tickets, not the clinic: no clinical/financial access,
  // just enough of the shell to sign in and open the conversation inbox
  support: { ...NO_PERMISSIONS, dashboard: true },
  // clinic owner (صاحب عيادة)
  admin: { ...ALL_PERMISSIONS },
  doctor: { dashboard: true, patients: true, appointments: true, records: true, invoices: false, inventory: false, reports: false, settings: false },
  reception: { dashboard: true, patients: true, appointments: true, records: false, invoices: true, inventory: false, reports: false, settings: false },
  accountant: { dashboard: true, patients: false, appointments: false, records: false, invoices: true, inventory: true, reports: true, settings: false },
  nurse: { dashboard: true, patients: true, appointments: true, records: true, invoices: false, inventory: false, reports: false, settings: false },
};

/** Historic alias used by older data and the default in POST /api/users. */
const normalizeRole = (r) => {
  if (r === "receptionist") return "reception";
  if (r === "manager" || r === "owner") return "admin";
  if (r === "superadmin") return "super_admin";
  return ROLES.includes(r) ? r : null;
};

const isSupport = (u) => !!u && u.role === "support";

/** Role defaults merged with the owner's explicit per-user grants. */
function effectivePermissions(user) {
  if (!user) return { ...NO_PERMISSIONS };
  if (user.role === "super_admin") return { ...ALL_PERMISSIONS };
  const base = { ...(ROLE_PERMISSIONS[user.role] || NO_PERMISSIONS) };
  const own = user.permissions && typeof user.permissions === "object" ? user.permissions : {};
  for (const k of PERMISSION_KEYS) {
    if (own[k] === true || own[k] === false) base[k] = own[k];
    else delete own[k];
  }
  // The owner can switch a whole section off from the subscriptions screen (the
  // permission-style picker). It beats both the role default and the per-user
  // grant: the section is gone for every member of that clinic. The same map
  // drives enforcePermission (API) and publicUser().permissions (sidebar), so
  // the menu item disappears and the endpoint refuses the call.
  if (user.clinicId && !isSiteOwner(user)) {
    const live = accessSubscription(user.clinicId);
    const off = live && live.modules;
    if (off) for (const k of PERMISSION_KEYS) if (off[k] === false) base[k] = false;
  }
  return base;
}

/** Keeps only known module keys with `false` values: absent always means on. */
function sanitizeModules(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const k of PERMISSION_KEYS) if (v[k] === false) out[k] = false;
  return out;
}

const can = (user, key) => !!user && effectivePermissions(user)[key] === true;

/** Throws unless the session's user holds `key`. */
function requirePerm(req, key) {
  const s = requireSession(req);
  if (!can(s.user, key)) throw forbidden("ليست لديك صلاحية: " + (PERMISSIONS.find((p) => p.key === key) || {}).label);
  return s;
}

/**
 * Central permission gate, applied to every /api route before its handler runs.
 * Read routes need the "view" side of a module, write routes need full access to
 * it. Roles the owner hands out therefore decide what a member of staff can see
 * in the sidebar AND what the API will actually accept.
 */
const PERMISSION_RULES = [
  { rx: /^\/api\/dashboard/, key: "dashboard" },
  { rx: /^\/api\/patients/, key: "patients" },
  { rx: /^\/api\/appointments/, key: "appointments" },
  { rx: /^\/api\/records/, key: "records" },
  { rx: /^\/api\/(invoices|debts)/, key: "invoices" },
  { rx: /^\/api\/(inventory|product-sales)/, key: "inventory" },
  { rx: /^\/api\/reports/, key: "reports" },
  // tasks are shared by the whole clinic team, so there is no permission key for
  // them: every member who works in a clinic may read/write them and the handlers
  // scope by clinicId. Support works the ticket inbox, not a clinic, so it is
  // kept out here as well as in the sidebar.
  { rx: /^\/api\/tasks/, key: null, denyRoles: ["support"] },
  // the bookable menu (price + duration) is a clinic setting: everyone in the
  // clinic may read it so the app can show it, but changing it needs settings
  { rx: /^\/api\/services/, key: "settings", methods: ["POST", "PUT", "DELETE"] },
  // reading the clinic list is already narrowed to the caller's own clinics by
  // the handler, so every signed-in member may read it; changing a clinic needs
  // the "settings" grant
  { rx: /^\/api\/clinics/, key: "settings", methods: ["POST", "PUT", "DELETE"] },
  { rx: /^\/api\/(users|roles)/, key: "settings" },
];

/* ══════════════════════════ SUBSCRIPTION GATE ══════════════════════════
 * What a clinic may still do once its trial ran out or its plan expired.
 * The rule the owner asked for: nothing works except talking to support, so
 * the app never looks broken — it looks paused, with a way out.
 * Read-only paths (session, chat, its own subscription) stay open on purpose.
 */
const OPEN_WHEN_LOCKED = [
  /^\/api\/auth\//,          // login, logout, me, change-password
  /^\/api\/chat/,            // the one thing a locked clinic may still do
  /^\/api\/subscriptions$/,  // read the plans on offer
  /^\/api\/clinic-subscriptions$/, // read its own subscription state
  /^\/api\/offers$/,         // public offers
  /^\/api\/clinics$/,        // read its own clinic record (the GET branch)
  /^\/api\/public\//,        // the public booking page must keep working
  /^\/api\/dashboard\/health$/,
];

// reading these is fine so the app can still show prices/durations, but writing
// them is real work and must stay behind the paywall
const READ_ONLY_WHEN_LOCKED = [/^\/api\/services$/];

/**
 * A clinic is locked out when it has no live subscription. The site owner and
 * the support desk are never clinic-scoped, so they are unaffected.
 */
function enforceSubscription(req, urlPath) {
  if (urlPath.startsWith("/api/public/")) return;
  if (OPEN_WHEN_LOCKED.some((rx) => rx.test(urlPath))) return;
  if (req.method === "GET" && READ_ONLY_WHEN_LOCKED.some((rx) => rx.test(urlPath))) return;

  const s = currentSession(req);
  if (!s) return;                       // unauthenticated: the route decides
  const user = s.user;
  if (isSiteOwner(user) || user.role === "support") return;
  if (!user.clinicId) return;            // not attached to a clinic

  if (!accessSubscription(user.clinicId)) {
    throw new AppError(402,
      "انتهت الفترة التجريبية أو اشتراك العيادة. يمكنك التواصل مع الدعم فقط حتى يتم تفعيل الاشتراك.");
  }
}

/** The only /api routes that may be reached without a signed-in user. Every
 *  other route — including any added in the future — is deny-by-default and
 *  must carry a valid session, even if it is not listed in PERMISSION_RULES. */
const PUBLIC_API = [
  /^\/api\/auth\/(?:register|login|logout|forgot|reset)$/,
  /^\/api\/health$/,
  /^\/api\/public\//,
  /^\/api\/subscriptions\/?$/,
  /^\/api\/offers\/?$/,
];

function enforcePermission(req, urlPath) {
  const rule = PERMISSION_RULES.find(
    (r) => r.rx.test(urlPath) && (!r.methods || r.methods.includes(req.method))
  );
  if (!rule) {
    // auth, chat, plans, backup, public booking ... are handled in-handler;
    // this backstop still guarantees no /api route is anonymously reachable.
    if (!PUBLIC_API.some((rx) => rx.test(urlPath))) requireSession(req);
    return;
  }
  const s = requireSession(req);
  if (rule.denyRoles && rule.denyRoles.includes(s.user.role))
    throw forbidden("ليست لديك صلاحية: المهام");
  if (!rule.key) return;
  if (!can(s.user, rule.key))
    throw forbidden("ليست لديك صلاحية: " + (PERMISSIONS.find((p) => p.key === rule.key) || {}).label);
}

/* ── SUBSCRIPTIONS ──
 * A trial clinic gets exactly the same features as a paying one. The single
 * exception the owner asked for: hiring staff needs a real (paid) subscription.
 */
const TRIAL_HOURS = 1;

/** Subscription that currently grants access: paid or still inside its trial. */
function accessSubscription(clinicId) {
  if (!clinicId) return null;
  const t = Date.now();
  const live = db.clinicSubscriptions.filter(
    (s) =>
      s.clinicId === clinicId &&
      (s.status === "active" || s.status === "trial") &&
      (!s.endDate || new Date(s.endDate).getTime() > t)
  );
  // a paid plan always wins over the trial row the registration left behind,
  // otherwise hiring would stay blocked after the clinic actually paid
  return live.find((s) => s.status === "active") || live[0] || null;
}

/** Subscription state of a clinic, for /api/auth/me and the UI banner. */
function subscriptionState(clinicId) {
  const sub = accessSubscription(clinicId);
  if (!sub) return { status: "none", canUse: false, canHire: false, endDate: null, trialEndDate: null, planId: null };
  const paid = sub.status === "active";
  return {
    id: sub.id,
    planId: sub.planId,
    status: sub.status,
    canUse: true,
    canHire: paid,
    endDate: sub.endDate || null,
    trialEndDate: sub.trialEndDate || null,
  };
}

/**
 * Gate for staff management (hiring / editing / removing employees).
 * Trial and expired clinics may use the whole app, but may not hire.
 */
function requireHiringSubscription(req) {
  const s = requireClinicOwner(req);
  if (isSiteOwner(s.user)) return s;
  const sub = accessSubscription(s.user.clinicId);
  if (!sub)
    throw new AppError(402, "لا يوجد اشتراك فعال لهذه العيادة — التوظيف يتطلب اشتراكاً.تواصل مع الدعم");
  if (sub.status !== "active")
    throw new AppError(402, "التوظيف داخل العيادة متاح بعد الاشتراك فقط — الفترة التجريبية تسمح بكل الصلاحيات الأخرى");
  return s;
}

/**
 * URL-safe ASCII public booking slug, unique across clinics.
 * Arabic-only names fall back to clinic-<id> so the link stays easy to
 * copy/paste without percent-encoding surprises. Owner can rename it later
 * via PUT /api/clinics {bookingSlug}.
 */
function uniqueBookingSlug(name) {
  const taken = new Set(db.clinics.map((c) => c.bookingSlug).filter(Boolean));
  const base =
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 32)
      .replace(/-+$/, "") || `clinic-${crypto.randomBytes(3).toString("hex")}`;
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

const publicUser = (u) => {
  if (!u) return null;
  // Never let a credential reach the client: the scrypt hash, the TOTP seeds
  // (pending setup + enabled), and the device list all stay server-side.
  const { password, twoFactorSecret, twoFactorPendingSecret, trustedDevices, permissions, ...rest } = u;
  return {
    ...rest,
    roleLabel: ROLE_LABELS[u.role] || u.role,
    // the UI reads user.permissions[key] to decide what to show
    permissions: effectivePermissions(u),
    subscription: subscriptionState(u.clinicId),
    // the workspace swaps itself for a support-only screen when this is true
    locked: !!u.clinicId && !subscriptionState(u.clinicId).canUse,
    twoFactorEnabled: !!u.twoFactorEnabled,
  };
};

/* ══════════════════════════ 7. DOMAIN HELPERS ══════════════════════════ */

const patientOf = (id) => db.patients.find((p) => p.id === id) || null;
const userOf = (id) => db.users.find((u) => u.id === id) || null;
const clinicOf = (id) => db.clinics.find((c) => c.id === id) || null;

function decorateAppointment(a) {
  const p = patientOf(a.patientId);
  const d = userOf(a.doctorId);
  return {
    ...a,
    patient: p ? { id: p.id, fullName: p.fullName, phone: p.phone } : null,
    doctor: d ? { id: d.id, fullName: d.fullName, role: d.role } : null,
  };
}

function decorateInvoice(i) {
  const p = patientOf(i.patientId);
  return {
    ...i,
    items: Array.isArray(i.items) ? i.items : [],
    patient: p ? { id: p.id, fullName: p.fullName, phone: p.phone } : null,
  };
}

const sameDay = (iso, d) => {
  if (!iso) return false;
  const x = new Date(iso);
  return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate();
};

const clinicScope = (req, url) => {
  const requested = url.searchParams.get("clinicId");
  const session = currentSession(req);
  const user = session ? session.user : null;
  if (!user) return null;
  const mine = user.clinicId || null;
  // A ?clinicId= is honoured only when the caller actually owns that clinic,
  // otherwise it is ignored (falls back to the caller's own clinic) — this
  // closes the read-side IDOR where any member could read another clinic.
  if (requested && (isSiteOwner(user) || ownedClinicIds(user).includes(requested))) return requested;
  return mine;
};

function buildDashboard(clinicId, empty) {
  // support has no clinic of its own: never fall back to somebody else's numbers
  const clinic = empty ? null : clinicOf(clinicId) || db.clinics[0];
  const cid = clinic ? clinic.id : null;

  const patients = db.patients.filter((p) => p.clinicId === cid && isLive(p));
  const appts = db.appointments.filter((a) => a.clinicId === cid && isLive(a));
  const invoices = db.invoices.filter((i) => i.clinicId === cid && isLive(i));

  const today = new Date();
  const todayAppointments = appts
    .filter((a) => sameDay(a.startTime, today))
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)))
    .map(decorateAppointment);

  const revenueChart = [];
  for (let k = 5; k >= 0; k--) {
    const d = new Date(today.getFullYear(), today.getMonth() - k, 1);
    revenueChart.push({
      name: AR_MONTHS[d.getMonth()],
      revenue: invoices.filter((i) => {
        const x = new Date(i.createdAt || Date.now());
        return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth();
      }).reduce((s, i) => s + num(i.total), 0),
    });
  }

  const statusLabels = { scheduled: "مجدول", completed: "تم", cancelled: "ملغي" };
  const male = patients.filter((p) => p.gender === "male").length;
  const female = patients.filter((p) => p.gender === "female").length;

  return {
    clinic: clinic || null,
    stats: {
      totalPatients: patients.length,
      todayAppointments: todayAppointments.length,
      totalRevenue: invoices.reduce((s, i) => s + num(i.total), 0),
      totalCollected: invoices.reduce((s, i) => s + num(i.paidAmount), 0),
      totalInvoices: invoices.length,
      totalPending: invoices.reduce((s, i) => s + num(i.dueAmount), 0),
    },
    todayAppointments,
    revenueChart,
    appointmentStats: Object.entries(statusLabels).map(([k, label]) => ({
      name: label, count: appts.filter((a) => a.status === k).length,
    })),
    patientStats: [
      { name: "ذكور", value: male },
      { name: "إناث", value: female },
      { name: "غير محدد", value: patients.length - male - female },
    ],
    recentPatients: patients.slice(-5).reverse(),
    upcomingAppointments: todayAppointments.filter((a) => a.status === "scheduled"),
  };
}

/* ══════════════════════════ 8. ROUTES ══════════════════════════ */

const routes = [];
const PER_PAGE = 10;

function route(method, pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
    keys.push(k);
    return "([^/]+)";
  });
  routes.push({ method, rx: new RegExp(`^${source}$`), keys, handler });
}

/* ── AUTH ── */

route("POST", "/api/auth/register", async (req, res) => {
  const b = await readBody(req);
  const username = String(b.username || "").trim();
  const password = String(b.password || "");
  const fullName = String(b.fullName || "").trim();
  const clinicName = String(b.clinicName || "").trim();

  if (!username || !password || !fullName) throw badRequest("جميع الحقول مطلوبة");
  if (!clinicName) throw badRequest("اسم العيادة مطلوب");
  if (username.length < 3) throw badRequest("اسم المستخدم يجب أن يكون ٣ أحرف على الأقل");
  checkPasswordPolicy(password);
  if (db.users.some((u) => String(u.username).toLowerCase() === username.toLowerCase()))
    throw new AppError(409, "اسم المستخدم مستخدم بالفعل");

  const clinicId = uid("clinic");
  const userId = uid("user");
  const bookingSlug = uniqueBookingSlug(clinicName);

  db.clinics.push({
    id: clinicId, name: clinicName, phone: b.clinicPhone || "",
    address: b.clinicAddress || "", currency: b.clinicCurrency || "SAR",
    paymentMode: "postpaid", ownerId: userId,
    bookingSlug, bookingEnabled: true, createdAt: now(),
  });
  seedDefaultServices(clinicId);

  db.users.push({
    id: userId, username, password: hashPassword(password), fullName,
    phone: b.phone || "", email: b.email || "",
    // صاحب عيادة — not مالك الموقع. super_admin stays reserved for the site owner.
    role: "admin", clinicId,
    twoFactorEnabled: false, trustedDevices: [], createdAt: now(),
  });

  const free = db.plans.filter((p) => p.isActive).sort((a, c) => a.sortOrder - c.sortOrder)[0];
  if (free) {
    // trial = 1 hour, and it grants everything except hiring (see TRIAL_HOURS)
    const trialEnd = new Date(Date.now() + TRIAL_HOURS * 36e5).toISOString();
    db.clinicSubscriptions.push({
      id: uid("cs"), clinicId, planId: free.id, status: "trial",
      startDate: now(), endDate: trialEnd, trialEndDate: trialEnd,
      billingCycle: "monthly", notes: `فترة تجريبية ${TRIAL_HOURS} ساعة — كل الصلاحيات عدا التوظيف`,
    });
  }

  const user = db.users.find((u) => u.id === userId);
  createSession(req, res, userId);
  save();
  audit(req, "register.success", { actorId: userId, username, detail: clinicId });
  json(res, 200, { user: publicUser(user), currentClinicId: clinicId });
});

route("POST", "/api/auth/login", async (req, res) => {
  const b = await readBody(req);
  const username = String(b.username || "").trim();
  const password = String(b.password || "");

  assertNotLockedOut(req, username);

  const user = db.users.find((u) => String(u.username).toLowerCase() === username.toLowerCase());
  // scrypt on a missing user too, so timing doesn't reveal which usernames exist
  const okPw = user
    ? verifyPassword(password, user.password)
    : (verifyPassword(password, hashPassword("dummy")), false);

  if (!user || !okPw) {
    recordLoginFailure(req, username);
    audit(req, "login.failure", { username });
    throw new AppError(401, "اسم المستخدم أو كلمة المرور غير صحيحة");
  }
  clearLoginFailures(req, username);

  // 2FA is a hard gate: a correct password alone never yields a session. A
  // remembered device may stand in for the code, but only if it was minted
  // earlier with a valid TOTP code.
  if (user.twoFactorEnabled) {
    const trusted = b.trustDevice === true ? findTrustedDevice(req, user) : null;
    if (!trusted) {
      if (!b.twoFactorCode) return json(res, 200, { requiresTwoFactor: true, userId: user.id });
      if (!verifyTotp(user.twoFactorSecret, b.twoFactorCode))
        throw new AppError(401, "رمز التحقق غير صحيح");
      if (b.trustDevice === true) issueTrustedDevice(req, res, user, b.deviceName);
    } else {
      trusted.lastUsedAt = now();
      save();
    }
  }

  createSession(req, res, user.id);
  audit(req, "login.success", { actorId: user.id, username: user.username });
  json(res, 200, { user: publicUser(user), currentClinicId: user.clinicId });
});

route("GET", "/api/auth/me", async (req, res) => {
  const s = requireSession(req);
  // canUse, not the object itself: subscriptionState() always returns a shape,
  // so a truthiness check here would never mark a clinic as locked
  const sub = s.user.clinicId ? subscriptionState(s.user.clinicId) : null;
  json(res, 200, {
    user: publicUser(s.user),
    currentClinicId: s.user.clinicId,
    // the client uses this to swap the whole workspace for the "talk to
    // support" screen instead of letting every list fail with a 402
    subscription: sub,
    locked: !!s.user.clinicId && !(sub && sub.canUse),
  });
});

route("POST", "/api/auth/logout", async (req, res) => {
  const s = currentSession(req);
  clearSession(req, res);
  audit(req, "logout", { actorId: s && s.user.id, username: s && s.user.username });
  json(res, 200, { success: true });
});

/* ── Password reset (forgot / reset / logout-all) ── */

/** Public base URL used to build reset links (no trailing slash). */
function publicBaseUrl() {
  return String(process.env.PUBLIC_URL || process.env.ORIGIN || "").replace(/\/+$/, "")
    || `http://${HOST}:${PORT}`;
}

function findUserByAccount(account) {
  const a = String(account || "").trim().toLowerCase();
  if (!a) return null;
  return db.users.find(
    (u) => String(u.username).toLowerCase() === a
      || (u.email && String(u.email).toLowerCase() === a)
      || (u.phone && String(u.phone) === a)
  ) || null;
}

route("POST", "/api/auth/forgot", async (req, res) => {
  const b = await readBody(req);
  const account = b.username || b.email || b.account || "";
  assertResetAllowed(req, account);

  const user = findUserByAccount(account);
  // Always do comparable work + always return the same body so the endpoint
  // cannot be used to enumerate accounts (or their existence) by timing/response.
  const genericOk = { success: true, message: "إن كان الحساب موجوداً فستصلك رسالة لإعادة تعيين كلمة المرور." };

  if (user) {
    pruneResets();
    const token = crypto.randomBytes(32).toString("hex");
    resets[sha256(token)] = {
      userId: user.id,
      createdAt: now(),
      expiresAt: new Date(Date.now() + LIMITS.resetTtlMs).toISOString(),
      usedAt: null,
    };
    saveResets();
    const link = `${publicBaseUrl()}/?resetToken=${token}`;
    // Delivered through the notifier abstraction, never inline.
    const result = await notify.send({
      channel: process.env.NOTIFY_CHANNEL || "console",
      to: user.email || user.phone || user.username,
      templateKey: "password_reset",
      clinicId: user.clinicId || null,
      vars: { name: user.fullName || user.username, link, ttlMinutes: Math.round(LIMITS.resetTtlMs / 60000) },
    });
    if (!result || !result.ok) log(`reset link for ${user.username}: ${link}`);
    audit(req, "password.reset.request", { actorId: user.id, username: user.username });
  } else {
    // burn roughly the same CPU as the real branch (scrypt) to level timing
    hashPassword(crypto.randomBytes(12).toString("hex"));
    audit(req, "password.reset.request", { username: account, detail: "unknown-account" });
  }
  json(res, 200, genericOk);
});

route("POST", "/api/auth/reset", async (req, res) => {
  const b = await readBody(req);
  const token = String(b.token || "");
  const next = String(b.newPassword || b.password || "");
  checkPasswordPolicy(next);
  if (!token) throw badRequest("رمز إعادة التعيين مطلوب");

  const hash = sha256(token);
  const rec = resets[hash];
  if (!rec || rec.usedAt || (Date.parse(rec.expiresAt) || 0) < Date.now())
    throw new AppError(400, "رابط إعادة التعيين غير صالح أو منتهي الصلاحية");

  const user = db.users.find((u) => u.id === rec.userId);
  if (!user) throw new AppError(400, "رابط إعادة التعيين غير صالح أو منتهي الصلاحية");

  // If 2FA is on, the reset alone is not enough: require a current TOTP code so
  // an attacker with only the e-mail cannot seize the account.
  if (user.twoFactorEnabled) {
    if (!b.twoFactorCode) throw new AppError(400, "رمز التحقق الثنائي مطلوب لإكمال إعادة التعيين");
    if (!verifyTotp(user.twoFactorSecret, b.twoFactorCode))
      throw new AppError(400, "رمز التحقق الثنائي غير صحيح");
  }

  if (verifyPassword(next, user.password)) throw badRequest("كلمة المرور الجديدة مطابقة للحالية");

  user.password = hashPassword(next);
  if (Array.isArray(user.trustedDevices)) user.trustedDevices = [];

  // single use + revoke every existing session for this account
  rec.usedAt = now();
  pruneResets();
  for (const h of userSessionHashes(user.id)) delete sessions[h];
  saveResets();
  saveSessions();
  save();
  audit(req, "password.reset.success", { actorId: user.id, username: user.username });
  json(res, 200, { success: true });
});

route("POST", "/api/auth/logout-all", async (req, res) => {
  const s = requireSession(req);
  for (const h of userSessionHashes(s.user.id, s.hash)) delete sessions[h];
  saveSessions();
  audit(req, "logout-all");
  json(res, 200, { success: true, keptCurrent: true });
});

/* ── TWO-FACTOR (TOTP) ── */

route("GET", "/api/auth/2fa", async (req, res) => {
  const s = requireSession(req);
  json(res, 200, { enabled: !!s.user.twoFactorEnabled });
});

route("POST", "/api/auth/2fa/setup", async (req, res) => {
  const s = requireSession(req);
  if (s.user.twoFactorEnabled) throw badRequest("التحقق الثنائي مفعّل بالفعل");
  const secret = newTotpSecret();
  s.user.twoFactorPendingSecret = secret;
  save();
  const clinic = s.user.clinicId ? clinicOf(s.user.clinicId) : null;
  const issuer = (clinic && clinic.name) || "Eyada";
  const url = otpauthUrl(issuer, s.user.username, secret);
  json(res, 200, { secret, otpauthUrl: url, qr: qrSvg(url) });
});

route("POST", "/api/auth/2fa/enable", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const secret = s.user.twoFactorPendingSecret;
  if (!secret) throw badRequest("ابدأ إعداد التحقق الثنائي أولاً");
  if (!verifyTotp(secret, b.code)) throw new AppError(400, "رمز التحقق غير صحيح");
  s.user.twoFactorSecret = secret;
  s.user.twoFactorEnabled = true;
  delete s.user.twoFactorPendingSecret;
  save();
  audit(req, "2fa.enable");
  json(res, 200, { enabled: true });
});

route("POST", "/api/auth/2fa/disable", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  if (s.user.twoFactorEnabled && !verifyTotp(s.user.twoFactorSecret, b.code))
    throw new AppError(400, "رمز التحقق غير صحيح");
  s.user.twoFactorEnabled = false;
  delete s.user.twoFactorSecret;
  delete s.user.twoFactorPendingSecret;
  // remembered devices only exist to skip 2FA; with 2FA off they go too
  revokeTrustedDevices(req, res, s.user);
  save();
  audit(req, "2fa.disable");
  json(res, 200, { enabled: false });
});

route("POST", "/api/auth/change-password", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const next = String(b.newPassword || "");
  if (!verifyPassword(String(b.currentPassword || ""), s.user.password))
    throw badRequest("كلمة المرور الحالية غير صحيحة");
  checkPasswordPolicy(next);
  if (verifyPassword(next, s.user.password))
    throw badRequest("كلمة المرور الجديدة مطابقة للحالية");

  s.user.password = hashPassword(next);
  // every other session + every remembered device must sign in again
  for (const h of userSessionHashes(s.user.id, s.hash)) delete sessions[h];
  revokeTrustedDevices(req, res, s.user);
  saveSessions();
  save();
  audit(req, "change-password");
  json(res, 200, { success: true });
});

route("POST", "/api/auth/impersonate", async (req, res) => {
  const s = requireSuperAdmin(req);
  const b = await readBody(req);
  const target = db.users.find((u) => u.id === b.userId);
  if (!target) throw notFound("المستخدم غير موجود");

  sessions[s.hash].impersonatorId = s.user.id;
  saveSessions();
  audit(req, "impersonate.start", { detail: target.username });
  appendCookies(res, [
    `${SESSION_COOKIE}=${s.token}; ${cookieAttrs(req, LIMITS.sessionTtlMs / 1000)}`,
    `impersonator_name=${encodeURIComponent(s.user.fullName)}; Path=/; SameSite=Lax; Max-Age=86400${isSecureRequest(req) ? "; Secure" : ""}`,
  ]);
  json(res, 200, {
    user: publicUser(target), currentClinicId: target.clinicId, impersonatorName: s.user.fullName,
  });
});

route("DELETE", "/api/auth/impersonate", async (req, res) => {
  const s = requireSession(req);
  if (!s.impersonatorId) throw badRequest("لا يوجد وضع انتحال نشط");

  const owner = userOf(s.impersonatorId);
  sessions[s.hash].impersonatorId = null;
  saveSessions();
  audit(req, "impersonate.stop");
  appendCookies(res, [
    `${SESSION_COOKIE}=${s.token}; ${cookieAttrs(req, LIMITS.sessionTtlMs / 1000)}`,
    `impersonator_name=; Path=/; SameSite=Lax; Max-Age=0${isSecureRequest(req) ? "; Secure" : ""}`,
  ]);
  json(res, 200, {
    user: publicUser(owner), currentClinicId: owner ? owner.clinicId : null,
  });
});

/* ── HEALTH ── */

route("GET", "/api/health", async (req, res) => {
  json(res, 200, {
    status: "ok",
    uptimeSec: Math.round((Date.now() - started) / 1000),
    sessions: Object.keys(sessions).length,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
  });
});

/* ── CLINICS ── */

route("GET", "/api/clinics", async (req, res, p, url) => {
  const s = requireSession(req);
  const ids = new Set(ownedClinicIds(s.user));
  const list = db.clinics.filter((c) => ids.has(c.id));

  const id = url.searchParams.get("id");
  if (id) {
    const found = list.find((c) => c.id === id);
    if (!found) throw notFound("العيادة غير موجودة");
    return json(res, 200, { clinic: found, ...found });
  }
  json(res, 200, list);
});

route("POST", "/api/clinics", async (req, res) => {
  const s = requireClinicOwner(req);
  const b = await readBody(req);
  if (!b.name) throw badRequest("اسم العيادة مطلوب");
  const clinic = {
    id: uid("clinic"), name: b.name, phone: b.phone || "", address: b.address || "",
    currency: b.currency || "SAR",
    paymentMode: b.paymentMode || "postpaid",
    ownerId: s.user.id, bookingSlug: uniqueBookingSlug(b.name),
    bookingEnabled: b.bookingEnabled !== false,
    siteClosed: false, siteClosedMessage: "", siteClosedUntil: "",
    siteClosedAt: "", siteClosedBy: "",
    createdAt: now(),
  };
  db.clinics.push(clinic);
  seedDefaultServices(clinic.id);
  save();
  audit(req, "clinic.create", { detail: clinic.id });
  json(res, 200, clinic);
});

route("PUT", "/api/clinics", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const clinic = clinicOf(b.id);
  if (!clinic) throw notFound("العيادة غير موجودة");
  if (!isSiteOwner(s.user) && !new Set(ownedClinicIds(s.user)).has(clinic.id))
    throw forbidden("لا يمكنك تعديل عيادة أخرى");
  for (const k of ["name", "phone", "address", "currency", "paymentMode"])
    if (b[k] !== undefined) clinic[k] = b[k];
  // slotDuration is gone: appointment length is decided per service
  if (b.bookingEnabled !== undefined) clinic.bookingEnabled = !!b.bookingEnabled;
  if (b.bookingSlug !== undefined) {
    const wanted = String(b.bookingSlug || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (wanted) {
      const clash = db.clinics.some((c) => c.id !== clinic.id && c.bookingSlug === wanted);
      if (clash) throw new AppError(409, "هذا الرابط محجوز، اختر رابطاً آخر");
      clinic.bookingSlug = wanted;
    }
  }
  if (!clinic.bookingSlug) clinic.bookingSlug = uniqueBookingSlug(clinic.name);
  // "إغلاق الموقع": clinic staff can take their public booking site offline
  // (holidays, full schedule, maintenance) with an optional notice + reopen date.
  if (b.siteClosedMessage !== undefined) clinic.siteClosedMessage = String(b.siteClosedMessage || "").slice(0, 500);
  if (b.siteClosedUntil !== undefined) clinic.siteClosedUntil = String(b.siteClosedUntil || "").slice(0, 40);
  if (b.siteClosed !== undefined) {
    const closed = !!b.siteClosed;
    if (closed !== !!clinic.siteClosed) {
      clinic.siteClosedAt = closed ? now() : "";
      clinic.siteClosedBy = closed ? (s.user.fullName || s.user.username || "") : "";
    }
    clinic.siteClosed = closed;
  }
  save();
  audit(req, "clinic.update", { detail: clinic.id });
  json(res, 200, clinic);
});

/* ── DASHBOARD ── */

route("GET", "/api/dashboard", async (req, res, p, url) => {
  const s = requireSession(req);
  if (isSupport(s.user)) return json(res, 200, buildDashboard(null, true));
  json(res, 200, buildDashboard(url.searchParams.get("clinicId") || s.user.clinicId));
});

/* ── SOFT DELETE + PAGINATION (shared) ──
 * A row is "in the trash" when it carries a deletedAt stamp; absent/undefined
 * counts as live, so old db.json files keep working untouched. Permanent removal
 * only happens through the auto-purge sweep after LIMITS.trashTtlMs.
 */

const TRASH_TYPES = {
  patients: { coll: "patients", label: "المريض", search: ["fullName", "fileNumber", "phone"] },
  appointments: { coll: "appointments", label: "الموعد", search: ["title", "notes"] },
  invoices: { coll: "invoices", label: "الفاتورة", search: ["id", "paymentMethod", "status"] },
  records: { coll: "records", label: "السجل", search: ["chiefComplaint", "diagnosis", "treatment"] },
  inventory: { coll: "inventory", label: "الصنف", search: ["itemName", "itemNameEn", "category", "supplier"] },
  services: { coll: "services", label: "الخدمة", search: ["name"] },
  tasks: { coll: "tasks", label: "المهمة", search: ["title"] },
};

const isLive = (x) => !!x && !x.deletedAt;

function liveByClinic(coll, clinicId) {
  return db[coll].filter((x) => x.clinicId === clinicId && isLive(x));
}

/** Stamps a live row as deleted (reversible). */
function softDeleteRow(req, row) {
  const s = requireSession(req);
  row.deletedAt = now();
  row.deletedBy = s.user.id;
  row.deletedByName = s.user.fullName || s.user.username || "";
  save();
  return row;
}

/** Idempotent back-fill: every trashable row gets explicit deletedAt/deletedBy. */
function migrateSoftDelete() {
  let n = 0;
  for (const { coll } of Object.values(TRASH_TYPES)) {
    if (!Array.isArray(db[coll])) continue;
    for (const row of db[coll]) {
      if (row.deletedAt === undefined) { row.deletedAt = null; n++; }
      if (row.deletedBy === undefined) row.deletedBy = null;
    }
  }
  return n;
}

/** Permanently drops trash rows older than the TTL. Returns how many went. */
function purgeExpiredTrash() {
  const t = Date.now();
  let removed = 0;
  for (const { coll } of Object.values(TRASH_TYPES)) {
    const before = db[coll].length;
    db[coll] = db[coll].filter((row) => {
      if (!row.deletedAt) return true;
      return t - (Date.parse(row.deletedAt) || 0) < LIMITS.trashTtlMs;
    });
    removed += before - db[coll].length;
  }
  if (removed) save();
  return removed;
}

const PAGING_DEFAULT_LIMIT = 50;
const PAGING_MAX_LIMIT = 200;

function wantsPaging(url) {
  return url.searchParams.has("page") || url.searchParams.has("limit");
}

function searchFilter(list, term, fields) {
  const q = String(term || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((x) => fields.some((f) => String(x[f] == null ? "" : x[f]).toLowerCase().includes(q)));
}

function sortList(list, sortParam) {
  if (!sortParam) return list;
  const dir = String(sortParam).startsWith("-") ? -1 : 1;
  const key = String(sortParam).replace(/^-/, "");
  return list.slice().sort((a, b) => {
    const av = a[key]; const bv = b[key];
    if (typeof av === "number" || typeof bv === "number")
      return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
    return String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv)) * dir;
  });
}

/**
 * Backward compatible paging: returns {items,total,page,limit} ONLY when the
 * caller sent ?page= or ?limit=. Otherwise returns null so the handler keeps its
 * historical response shape (a bare array, or {patients,pages}, ...).
 */
function pagedResponse(url, list, searchFields) {
  if (!wantsPaging(url)) return null;
  let out = searchFields ? searchFilter(list, url.searchParams.get("q") || url.searchParams.get("search"), searchFields) : list.slice();
  out = sortList(out, url.searchParams.get("sort"));
  const page = Math.max(1, num(url.searchParams.get("page"), 1));
  const limit = Math.min(PAGING_MAX_LIMIT, Math.max(1, num(url.searchParams.get("limit"), PAGING_DEFAULT_LIMIT)));
  const total = out.length;
  const start = (page - 1) * limit;
  return { items: out.slice(start, start + limit), total, page, limit };
}

/* ── TRASH (view / restore) ── */

route("GET", "/api/trash", async (req, res, p, url) => {
  const s = requireSession(req);
  const ids = new Set(ownedClinicIds(s.user));
  const only = url.searchParams.get("type");
  const out = [];
  for (const [slug, def] of Object.entries(TRASH_TYPES)) {
    if (only && only !== slug) continue;
    for (const row of db[def.coll]) {
      if (isLive(row)) continue;
      if (!ids.has(row.clinicId)) continue;
      out.push({
        type: slug, id: row.id, clinicId: row.clinicId,
        label: def.label, deletedAt: row.deletedAt || null,
        deletedBy: row.deletedBy || null, deletedByName: row.deletedByName || "",
        summary: row.fullName || row.title || row.name || row.id,
      });
    }
  }
  out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  json(res, 200, { items: out, total: out.length });
});

route("POST", "/api/trash/:type/:id/restore", async (req, res, p) => {
  // owner/manager only — staff can delete but only the boss can resurrect
  const s = requireClinicOwner(req);
  const def = TRASH_TYPES[p.type];
  if (!def) throw badRequest("نوع غير معروف");
  const row = db[def.coll].find((x) => x.id === p.id && !isLive(x));
  if (!row) throw notFound("غير موجود في المهملات");
  if (!ownedClinicIds(s.user).includes(row.clinicId)) throw forbidden("هذه العيادة ليست لك");
  row.deletedAt = null;
  row.deletedBy = null;
  row.deletedByName = "";
  save();
  audit(req, "trash.restore", { detail: `${p.type}:${p.id}` });
  json(res, 200, { success: true, type: p.type, id: p.id });
});

route("DELETE", "/api/trash/:type/:id", async (req, res, p) => {
  const s = requireClinicOwner(req);
  const def = TRASH_TYPES[p.type];
  if (!def) throw badRequest("نوع غير معروف");
  const i = db[def.coll].findIndex((x) => x.id === p.id && !isLive(x));
  if (i < 0) throw notFound("غير موجود في المهملات");
  if (!ownedClinicIds(s.user).includes(db[def.coll][i].clinicId)) throw forbidden("هذه العيادة ليست لك");
  db[def.coll].splice(i, 1);
  save();
  audit(req, "trash.purge", { detail: `${p.type}:${p.id}` });
  json(res, 200, { success: true });
});

/* ── NOTIFICATIONS (config + queue + providers + reminders) ──
 * Every outbound message goes through notifiers/ (console / whatsapp-cloud /
 * webhook / smtp). Secrets are sealed at rest and never returned by the API.
 * Delivery is asynchronous via db.notificationQueue with exponential backoff.
 */

const DEFAULT_NOTIFY = {
  enabled: false,
  channel: "console",
  timezone: "Asia/Riyadh",
  quietHours: { start: 22, end: 7 },
  reminderOffsets: [24, 2],
  templates: {
    booking_confirmation: "تم تأكيد حجزك في {clinic} يوم {date} الساعة {time}.",
    reminder_24h: "تذكير: موعدك في {clinic} غداً {date} الساعة {time}.",
    reminder_2h: "تذكير: موعدك في {clinic} خلال ساعتين ({date} {time}).",
    appointment_cancelled: "تم إلغاء موعدك في {clinic}.",
  },
};

function defaultNotifyConfig() { return JSON.parse(JSON.stringify(DEFAULT_NOTIFY)); }
function notifyConfig(clinicId) { return db.notificationConfigs.find((c) => c.clinicId === clinicId) || null; }
function notifyConfigOr(clinicId) { return notifyConfig(clinicId) || { clinicId, ...defaultNotifyConfig() }; }

/** Clinic id the caller may manage notifications for (owner/manager only callers). */
function notifyScopeClinic(s, url) {
  if (isSiteOwner(s.user)) {
    const q = url && url.searchParams.get("clinicId");
    return q || s.user.clinicId || (db.clinics[0] && db.clinics[0].id) || null;
  }
  return s.user.clinicId || (db.clinics[0] && db.clinics[0].id) || null;
}

/** Provider credentials never leave the server. */
function publicNotifyConfig(clinicId) {
  const row = notifyConfig(clinicId);
  const base = row ? { ...row } : { clinicId, ...defaultNotifyConfig() };
  delete base.whatsappToken; delete base.webhookSecret; delete base.smtpPassword;
  base.whatsappTokenSet = !!(row && row.whatsappToken);
  base.webhookSecretSet = !!(row && row.webhookSecret);
  base.smtpPasswordSet = !!(row && row.smtpPassword);
  return base;
}

function providerConfig(clinicId) {
  const c = notifyConfig(clinicId) || {};
  if ((c.channel || "console") === "whatsapp-cloud")
    return { phoneNumberId: c.whatsappPhoneNumberId, accessToken: c.whatsappToken, language: c.language, templates: c.providerTemplates || {} };
  if (c.channel === "webhook") return { url: c.webhookUrl, secret: c.webhookSecret };
  return {};
}

const maskTo = (v) => { const s = String(v || ""); return s.length <= 4 ? "***" : "***" + s.slice(-4); };

function enqueueNotification({ clinicId = null, channel = null, to = "", templateKey, vars = {}, at = null }) {
  const job = {
    id: uid("ntf"), clinicId, channel, to, templateKey, vars,
    status: "pending", attempts: 0, createdAt: now(),
    nextAttemptAt: at || now(), sentAt: null, lastError: "",
  };
  db.notificationQueue.push(job);
  return job;
}

/** One delivery pass. Serialized so overlapping sweeps can't double-send. */
let notifyRunning = false;
async function processNotificationQueue() {
  if (notifyRunning) return 0;
  notifyRunning = true;
  let sentCount = 0;
  try {
    const atMs = Date.now();
    const cutoff = atMs - 60_000;
    const perClinic = new Map();
    for (const j of db.notificationQueue)
      if (j.status === "sent" && j.sentAt && Date.parse(j.sentAt) > cutoff)
        perClinic.set(j.clinicId, (perClinic.get(j.clinicId) || 0) + 1);

    const due = db.notificationQueue
      .filter((j) => j.status === "pending" && (Date.parse(j.nextAttemptAt) || 0) <= atMs)
      .slice(0, 100);

    let changed = false;
    for (const job of due) {
      const used = perClinic.get(job.clinicId) || 0;
      if (used >= LIMITS.notifRatePerMin) break; // per-clinic ceiling: resume next sweep
      const cfg = notifyConfigOr(job.clinicId);
      const channel = job.channel || cfg.channel || "console";
      const res = await notify.send({
        channel, to: job.to, templateKey: job.templateKey, vars: job.vars,
        clinicId: job.clinicId, config: providerConfig(job.clinicId),
      });
      job.attempts++;
      if (res && res.ok) {
        job.status = "sent"; job.sentAt = now(); job.lastError = "";
        perClinic.set(job.clinicId, used + 1);
        sentCount++;
        // operational log: who/when/template only — no medical content, no secrets
        db.notificationLog.push({
          id: uid("nlog"), clinicId: job.clinicId, channel,
          to: maskTo(job.to), templateKey: job.templateKey, sentAt: job.sentAt,
        });
      } else {
        job.lastError = (res && res.reason) || "error";
        if (job.attempts >= LIMITS.notifMaxAttempts) job.status = "failed";
        else job.nextAttemptAt = new Date(atMs + Math.pow(2, job.attempts) * 60_000).toISOString();
      }
      changed = true;
    }
    if (changed) save();
  } finally { notifyRunning = false; }
  return sentCount;
}

function clinicDateParts(tz, ms) {
  const d = new Date(ms);
  try {
    return {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
      time: new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d),
    };
  } catch { return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) }; }
}

function clinicHour(tz, ms) {
  try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(ms))); }
  catch { return new Date(ms).getHours(); }
}

function inQuietHours(cfg, ms) {
  const q = cfg.quietHours || {};
  const start = num(q.start, 22); const end = num(q.end, 7);
  if (start === end) return false;
  const h = clinicHour(cfg.timezone || "Asia/Riyadh", ms);
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

const renderTemplate = (text, vars) =>
  String(text || "").replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));

/** Scan upcoming appointments and queue 24h/2h reminders exactly once each.
 *  Markers persist on the appointment, so a restart never re-sends. */
function sweepReminders(atMs = Date.now()) {
  let queued = 0;
  for (const clinic of db.clinics) {
    const cfg = notifyConfig(clinic.id);
    if (!cfg || !cfg.enabled) continue;
    if (inQuietHours(cfg, atMs)) continue; // defer the whole clinic; next sweep retries
    const offsets = Array.isArray(cfg.reminderOffsets) ? cfg.reminderOffsets : [24, 2];
    for (const a of db.appointments) {
      if (a.clinicId !== clinic.id || !isLive(a)) continue;
      if (["cancelled", "canceled", "completed"].includes(String(a.status))) continue;
      const startMs = Date.parse(a.startTime);
      if (!Number.isFinite(startMs) || startMs <= atMs) continue;
      a.reminders = a.reminders || {};
      for (const h of offsets) {
        const key = "h" + h;
        if (a.reminders[key]) continue;
        if (atMs < startMs - h * 3600_000) continue; // window not open yet
        const patient = db.patients.find((p) => p.id === a.patientId && isLive(p));
        const parts = clinicDateParts(cfg.timezone || "Asia/Riyadh", startMs);
        const vars = { clinic: clinic.name, name: patient ? patient.fullName : "", date: parts.date, time: parts.time };
        vars.message = renderTemplate((cfg.templates || {})["reminder_" + h + "h"] || "تذكير بموعدك", vars);
        enqueueNotification({ clinicId: clinic.id, channel: cfg.channel, to: patient ? patient.phone : "", templateKey: "reminder_" + h + "h", vars });
        a.reminders[key] = now();
        queued++;
      }
    }
  }
  if (queued) save();
  return queued;
}

/* ── NOTIFICATION ENDPOINTS ── */

route("GET", "/api/notifications", async (req, res, p, url) => {
  const s = requireClinicOwner(req);
  const clinicId = notifyScopeClinic(s, url);
  const queue = db.notificationQueue
    .filter((j) => j.clinicId === clinicId)
    .slice(-100).reverse()
    .map((j) => ({
      id: j.id, templateKey: j.templateKey, to: maskTo(j.to), channel: j.channel,
      status: j.status, attempts: j.attempts, createdAt: j.createdAt,
      sentAt: j.sentAt, lastError: redact(j.lastError),
    }));
  const log = db.notificationLog.filter((l) => l.clinicId === clinicId).slice(-100).reverse();
  json(res, 200, { config: publicNotifyConfig(clinicId), queue, log });
});

route("PUT", "/api/notifications", async (req, res, p, url) => {
  const s = requireClinicOwner(req);
  const clinicId = notifyScopeClinic(s, url);
  if (!clinicId) throw badRequest("لا توجد عيادة مرتبطة بحسابك");
  const b = await readBody(req);
  const existing = notifyConfig(clinicId);
  // mutate a copy so a rejected request can never poison the live config
  const row = existing
    ? { ...existing, quietHours: { ...(existing.quietHours || {}) }, templates: { ...(existing.templates || {}) } }
    : { id: uid("ncfg"), clinicId, ...defaultNotifyConfig(), createdAt: now() };

  if (b.enabled !== undefined) row.enabled = !!b.enabled;
  if (b.channel !== undefined) {
    const ch = String(b.channel);
    if (ch !== "console" && !notify.has(ch)) throw badRequest("قناة غير مدعومة: " + ch);
    row.channel = ch;
  }
  if (b.timezone !== undefined) row.timezone = String(b.timezone).slice(0, 60);
  if (b.quietHours !== undefined && b.quietHours)
    row.quietHours = { start: num(b.quietHours.start, 22), end: num(b.quietHours.end, 7) };
  if (Array.isArray(b.reminderOffsets))
    row.reminderOffsets = b.reminderOffsets.map((x) => Math.max(1, num(x))).filter(Boolean).slice(0, 6);
  if (b.templates !== undefined && b.templates) row.templates = { ...(row.templates || {}), ...b.templates };
  if (b.whatsappPhoneNumberId !== undefined) row.whatsappPhoneNumberId = String(b.whatsappPhoneNumberId);
  if (b.whatsappLanguage !== undefined) row.language = String(b.whatsappLanguage);
  if (b.webhookUrl !== undefined) row.webhookUrl = String(b.webhookUrl);
  // secrets: overwrite only when a value is supplied; "" clears
  if (b.whatsappToken !== undefined) row.whatsappToken = String(b.whatsappToken || "");
  if (b.webhookSecret !== undefined) row.webhookSecret = String(b.webhookSecret || "");
  if (b.smtpPassword !== undefined) row.smtpPassword = String(b.smtpPassword || "");

  if (row.channel === "whatsapp-cloud" && (!row.whatsappToken || !row.whatsappPhoneNumberId))
    throw badRequest("إعداد واتساب ناقص (رقم المرسل + التوكن)");
  if (row.channel === "webhook" && !row.webhookUrl) throw badRequest("رابط الويبهوك مطلوب");

  if (existing) Object.assign(existing, row);
  else db.notificationConfigs.push(row);
  save();
  audit(req, "notifications.update", { detail: clinicId });
  json(res, 200, { config: publicNotifyConfig(clinicId) });
});

route("POST", "/api/notifications/test", async (req, res, p, url) => {
  const s = requireClinicOwner(req);
  const clinicId = notifyScopeClinic(s, url);
  const b = await readBody(req);
  if (!b.to) throw badRequest("المستلم مطلوب");
  const cfg = notifyConfigOr(clinicId);
  enqueueNotification({ clinicId, channel: cfg.channel, to: b.to, templateKey: "test",
    vars: { message: "رسالة اختبار من نظام عيادة" } });
  const sent = await processNotificationQueue();
  json(res, 200, { success: true, sent });
});

/* ── PUBLIC BOOKING MANAGE (cancel / reschedule via hashed token) ── */

function manageAppointment(slug, token) {
  const clinic = clinicBySlug(slug);
  if (!clinic) throw notFound("العيادة غير موجودة");
  if (!token) throw badRequest("رمز الإدارة مطلوب");
  const h = sha256(String(token));
  const appt = db.appointments.find((a) => a.manageTokenHash === h && a.clinicId === clinic.id && isLive(a));
  if (!appt) throw notFound("رابط غير صالح أو منتهي");
  const startMs = Date.parse(appt.startTime);
  if (!Number.isFinite(startMs) || Date.now() > startMs) throw new AppError(410, "انتهت صلاحية إدارة هذا الحجز");
  return { clinic, appt };
}

function appointmentPatientPhone(appt) {
  const p = db.patients.find((x) => x.id === appt.patientId && isLive(x));
  return p ? p.phone : "";
}

route("GET", "/api/public/booking/:slug/appointment", async (req, res, p, url) => {
  const { clinic, appt } = manageAppointment(p.slug, url.searchParams.get("token"));
  const parts = clinicDateParts(clinic.timezone || "Asia/Riyadh", Date.parse(appt.startTime));
  json(res, 200, {
    appointment: {
      clinicName: clinic.name, date: parts.date, time: parts.time,
      status: appt.status, serviceId: appt.serviceId || "", doctorId: appt.doctorId || "",
    },
    canCancel: !["cancelled", "canceled"].includes(String(appt.status)),
  });
});

route("POST", "/api/public/booking/:slug/cancel", async (req, res, p) => {
  throttleBooking(req);
  const b = await readBody(req);
  const { clinic, appt } = manageAppointment(p.slug, b.token);
  if (["cancelled", "canceled"].includes(String(appt.status))) throw badRequest("الحجز ملغي بالفعل");
  appt.status = "cancelled";
  appt.cancelledAt = now();
  appt.cancelledBy = "patient";
  const cfg = notifyConfig(clinic.id);
  if (cfg && cfg.enabled) {
    const vars = { clinic: clinic.name };
    vars.message = renderTemplate((cfg.templates || {}).appointment_cancelled || "تم إلغاء موعدك", vars);
    enqueueNotification({ clinicId: clinic.id, channel: cfg.channel, to: appointmentPatientPhone(appt), templateKey: "appointment_cancelled", vars });
  }
  save();
  audit(req, "booking.cancel", { detail: appt.id });
  json(res, 200, { success: true });
});

route("POST", "/api/public/booking/:slug/reschedule", async (req, res, p) => {
  throttleBooking(req);
  const b = await readBody(req);
  const { clinic, appt } = manageAppointment(p.slug, b.token);
  if (["cancelled", "canceled"].includes(String(appt.status))) throw badRequest("لا يمكن تعديل حجز ملغي");
  const date = String(b.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("التاريخ غير صالح");

  const svc = appt.serviceId ? db.services.find((x) => x.id === appt.serviceId && isLive(x)) : null;
  const durationMin = svc ? serviceDuration(svc) : DEFAULT_APPTMENT_MIN;
  const slots = bookingSlots(clinic, date, appt.doctorId, durationMin);
  const chosen = slots.find((s) => s.available);
  if (!chosen) throw new AppError(409, "لا توجد مواعيد متاحة في هذا اليوم — جرّب يوماً آخر");
  const startMs = new Date(`${date}T${chosen.time}:00`).getTime();
  if (appointmentClashes(clinic.id, appt.doctorId, startMs, startMs + durationMin * 60000, appt.id))
    throw new AppError(409, "هذا الوقت لم يعد متاحاً — جرّب يوماً آخر");

  appt.startTime = new Date(startMs).toISOString();
  appt.endTime = new Date(startMs + durationMin * 60000).toISOString();
  appt.status = "scheduled";
  appt.reminders = {}; // let the 24h/2h reminders fire again for the new time
  const cfg = notifyConfig(clinic.id);
  const parts = clinicDateParts((cfg && cfg.timezone) || "Asia/Riyadh", startMs);
  if (cfg && cfg.enabled) {
    const vars = { clinic: clinic.name, name: appointmentPatientPhone(appt) ? "" : "", date: parts.date, time: parts.time };
    vars.message = renderTemplate((cfg.templates || {}).booking_confirmation || "تم تعديل حجزك", vars);
    enqueueNotification({ clinicId: clinic.id, channel: cfg.channel, to: appointmentPatientPhone(appt), templateKey: "booking_confirmation", vars });
  }
  save();
  audit(req, "booking.reschedule", { detail: appt.id });
  json(res, 200, { success: true, appointment: { date: parts.date, time: parts.time, clinicName: clinic.name } });
});

/* ── PATIENTS ── */

route("GET", "/api/patients", async (req, res, p, url) => {
  requireSession(req);
  const clinicId = clinicScope(req, url);
  ensurePatientFiles(clinicId);
  const search = (url.searchParams.get("search") || "").trim();
  const page = num(url.searchParams.get("page"), 1);

  let list = db.patients.filter((x) => x.clinicId === clinicId && isLive(x));
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(
      (x) => String(x.fullName || "").toLowerCase().includes(q)
        || String(x.phone || "").includes(q)
        || String(x.fileNumber || "").toLowerCase().includes(q)
    );
  }
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const paged = pagedResponse(url, list, TRASH_TYPES.patients.search);
  if (paged) return json(res, 200, paged);

  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const start = (Math.max(1, page) - 1) * PER_PAGE;
  json(res, 200, { patients: list.slice(start, start + PER_PAGE), pages });
});

const PATIENT_FIELDS = ["fullName", "phone", "email", "gender", "age", "bloodType",
  "allergies", "insuranceNumber", "insuranceCompany", "notes"];

/** رقم الملف: sequential per clinic (P-0001, P-0002 ...). */
function nextPatientFileNumber(clinicId) {
  let max = 0;
  for (const p of db.patients) {
    if (p.clinicId !== clinicId) continue;
    const m = /(\d+)/.exec(String(p.fileNumber || ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "P-" + String(max + 1).padStart(4, "0");
}

/** Back-fill رقم الملف for rows created before the column existed, so the
 *  patients table is never blank. Runs once per clinic. */
function ensurePatientFiles(clinicId) {
  const missing = db.patients
    .filter((p) => p.clinicId === clinicId && !p.fileNumber)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (!missing.length) return;
  for (const p of missing) p.fileNumber = nextPatientFileNumber(clinicId);
  save();
}

route("POST", "/api/patients", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  if (!String(b.fullName || "").trim()) throw badRequest("يرجى إدخال اسم المريض");
  const clinicId = resolveWriteClinic(s.user, b.clinicId);
  const patient = {
    id: uid("pat"), clinicId, fileNumber: nextPatientFileNumber(clinicId), fullName: b.fullName,
    phone: b.phone || "", email: b.email || "", gender: b.gender || "",
    age: b.age === "" || b.age == null ? "" : num(b.age),
    bloodType: b.bloodType || "", allergies: b.allergies || "",
    insuranceNumber: b.insuranceNumber || "", insuranceCompany: b.insuranceCompany || "",
    notes: b.notes || "", createdAt: now(),
  };
  db.patients.push(patient);
  save();
  json(res, 200, patient);
});

route("PUT", "/api/patients", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const patient = db.patients.find((x) => x.id === b.id);
  assertRecordClinic(s.user, patient, "المريض");
  for (const k of PATIENT_FIELDS) if (b[k] !== undefined) patient[k] = b[k];
  save();
  json(res, 200, patient);
});

route("DELETE", "/api/patients", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const patient = db.patients.find((x) => x.id === b.id && isLive(x));
  if (!patient) throw notFound("المريض غير موجود");
  assertRecordClinic(s.user, patient, "المريض");
  // money still owed blocks a silent delete: caller must pass confirm:true
  const unpaid = db.invoices.filter((i) => i.patientId === patient.id && isLive(i) && num(i.dueAmount) > 0);
  if (unpaid.length && b.confirm !== true)
    throw new AppError(409, `المريض عليه ${unpaid.length} فاتورة غير مسددة. أعد الطلب مع confirm:true للتأكيد.`);
  softDeleteRow(req, patient);
  audit(req, "patient.delete", { detail: patient.id });
  json(res, 200, { success: true, softDeleted: true });
});

/* ── APPOINTMENTS ── */

/**
 * Half-open overlap test: [start, end) vs [start, end). Two appointments may sit
 * back to back (10:00-10:20 and 10:20-10:40) but never inside each other.
 * Only same-clinic, same-doctor, still-live appointments count.
 */
function appointmentClashes(clinicId, doctorId, startMs, endMs, ignoreId) {
  return db.appointments.some((a) => {
    if (a.id === ignoreId) return false;
    if (!isLive(a)) return false;
    if (a.clinicId !== clinicId) return false;
    if (String(a.status) === "cancelled" || String(a.status) === "canceled") return false;
    if (doctorId && a.doctorId !== doctorId) return false;
    const s = new Date(a.startTime).getTime();
    if (!Number.isFinite(s)) return false;
    const e = a.endTime ? new Date(a.endTime).getTime() : s;
    return startMs < e && s < endMs;
  });
}

route("GET", "/api/appointments", async (req, res, p, url) => {
  requireSession(req);
  const clinicId = clinicScope(req, url);
  const date = url.searchParams.get("date");
  let list = db.appointments.filter((a) => a.clinicId === clinicId && isLive(a));
  if (date) {
    const d = new Date(date);
    if (!Number.isNaN(d.getTime())) list = list.filter((a) => sameDay(a.startTime, d));
  }
  list.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
  const paged = pagedResponse(url, list, TRASH_TYPES.appointments.search);
  if (paged) return json(res, 200, { ...paged, items: paged.items.map(decorateAppointment) });
  json(res, 200, list.map(decorateAppointment));
});

route("POST", "/api/appointments", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const clinicId = resolveWriteClinic(s.user, b.clinicId);
  const clinic = clinicOf(clinicId) || {};
  // a patient/doctor from another clinic must never be attached
  if (b.patientId) {
    const pat = db.patients.find((x) => x.id === b.patientId);
    if (!pat || pat.clinicId !== clinicId) throw badRequest("المريض المحدد غير موجود في هذه العيادة");
  }
  if (b.doctorId && !db.users.some((u) => u.id === b.doctorId && u.clinicId === clinicId))
    throw badRequest("الطبيب المحدد غير موجود في هذه العيادة");

  const start = b.startTime ? new Date(b.startTime) : new Date();
  if (Number.isNaN(start.getTime())) throw badRequest("تاريخ الموعد غير صالح");
  // the service decides how long the visit is; only a bare enquiry falls back
  const svc = b.serviceId ? db.services.find((x) => x.id === b.serviceId && x.clinicId === clinicId) : null;
  const durationMin = Math.max(5, num(b.duration, svc ? serviceDuration(svc) : DEFAULT_APPTMENT_MIN)
    || (svc ? serviceDuration(svc) : DEFAULT_APPTMENT_MIN));
  const end = new Date(start.getTime() + durationMin * 60000);

  if (appointmentClashes(clinicId, b.doctorId || "", start.getTime(), end.getTime()))
    throw new AppError(409, "هذا الوقت يتعارض مع موعد موجود للطبيب نفسه");

  const appt = {
    id: uid("apt"), clinicId, patientId: b.patientId || "", doctorId: b.doctorId || "",
    title: b.title || "كشف طبي", type: b.type || "consultation",
    serviceId: b.serviceId || "",
    startTime: start.toISOString(), endTime: end.toISOString(),
    status: b.status || "scheduled", notes: b.notes || "", createdAt: now(),
  };
  db.appointments.push(appt);
  save();
  json(res, 200, decorateAppointment(appt));
});

route("PUT", "/api/appointments", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const appt = db.appointments.find((a) => a.id === b.id);
  assertRecordClinic(s.user, appt, "الموعد");
  if (b.patientId) {
    const pat = db.patients.find((x) => x.id === b.patientId);
    if (!pat || pat.clinicId !== appt.clinicId) throw badRequest("المريض المحدد غير موجود في هذه العيادة");
  }
  if (b.doctorId && !db.users.some((u) => u.id === b.doctorId && u.clinicId === appt.clinicId))
    throw badRequest("الطبيب المحدد غير موجود في هذه العيادة");
  const EDITABLE = ["patientId", "doctorId", "title", "type", "status", "notes", "startTime", "endTime"];
  const prev = {};
  for (const k of EDITABLE) prev[k] = appt[k];
  for (const k of EDITABLE) if (b[k] !== undefined) appt[k] = b[k];

  // re-check after the move, otherwise dragging an appointment on top of
  // another one silently double-books the doctor
  const st = new Date(appt.startTime).getTime();
  const e = new Date(appt.endTime).getTime();
  if (Number.isFinite(st) && Number.isFinite(e) &&
      appointmentClashes(appt.clinicId, appt.doctorId, st, e, appt.id)) {
    for (const k of EDITABLE) appt[k] = prev[k];
    throw new AppError(409, "هذا الوقت يتعارض مع موعد موجود للطبيب نفسه");
  }

  save();
  json(res, 200, decorateAppointment(appt));
});

route("DELETE", "/api/appointments", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const appt = db.appointments.find((a) => a.id === b.id && isLive(a));
  if (!appt) throw notFound("الموعد غير موجود");
  assertRecordClinic(s.user, appt, "الموعد");
  softDeleteRow(req, appt);
  audit(req, "appointment.delete", { detail: appt.id });
  json(res, 200, { success: true, softDeleted: true });
});

/* ── INVOICES ── */

route("GET", "/api/invoices", async (req, res, p, url) => {
  requireSession(req);
  const clinicId = clinicScope(req, url);
  const status = url.searchParams.get("status");
  let list = db.invoices.filter((i) => i.clinicId === clinicId && isLive(i));
  if (status) list = list.filter((i) => i.status === status);
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const paged = pagedResponse(url, list, TRASH_TYPES.invoices.search);
  if (paged) return json(res, 200, { ...paged, items: paged.items.map(decorateInvoice) });
  json(res, 200, { invoices: list.map(decorateInvoice) });
});

route("POST", "/api/invoices", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const subtotal = num(b.subtotal);
  const taxPercentage = num(b.taxPercentage);
  const taxAmount = num(b.taxAmount, (subtotal * taxPercentage) / 100);
  const total = num(b.total, subtotal + taxAmount);
  const paidAmount = num(b.paidAmount);

  const invoice = {
    id: uid("inv"), clinicId: resolveWriteClinic(s.user, b.clinicId), patientId: b.patientId || "",
    subtotal, insuranceDiscount: num(b.insuranceDiscount), taxPercentage, taxAmount, total,
    paidAmount, dueAmount: total - paidAmount,
    status: b.status || (total - paidAmount > 0 ? "pending" : "paid"),
    paymentMethod: b.paymentMethod || "cash",
    items: Array.isArray(b.items) ? b.items : [], createdAt: now(),
  };
  db.invoices.push(invoice);
  save();
  json(res, 200, decorateInvoice(invoice));
});

route("PUT", "/api/invoices", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const invoice = db.invoices.find((i) => i.id === b.id);
  assertRecordClinic(s.user, invoice, "الفاتورة");
  for (const k of ["paidAmount", "status", "paymentMethod", "items"])
    if (b[k] !== undefined) invoice[k] = b[k];
  if (b.paidAmount !== undefined) {
    invoice.dueAmount = num(invoice.total) - num(invoice.paidAmount);
    invoice.status = invoice.dueAmount <= 0 ? "paid" : invoice.paidAmount > 0 ? "partial" : "pending";
  }
  save();
  json(res, 200, decorateInvoice(invoice));
});

route("DELETE", "/api/invoices", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const invoice = db.invoices.find((x) => x.id === b.id && isLive(x));
  if (!invoice) throw notFound("الفاتورة غير موجودة");
  assertRecordClinic(s.user, invoice, "الفاتورة");
  softDeleteRow(req, invoice);
  audit(req, "invoice.delete", { detail: invoice.id });
  json(res, 200, { success: true, softDeleted: true });
});

/* ── USERS ── */

route("GET", "/api/users", async (req, res, p, url) => {
  const s = requireSession(req);
  const ids = new Set(ownedClinicIds(s.user));
  const list = isSiteOwner(s.user)
    ? db.users
    : db.users.filter((u) => ids.has(u.clinicId) || u.id === s.user.id);
  const paged = pagedResponse(url, list, ["username", "fullName", "phone", "email", "role"]);
  if (paged) return json(res, 200, { ...paged, items: paged.items.map(publicUser) });
  json(res, 200, list.map(publicUser));
});

route("POST", "/api/users", async (req, res) => {
  // hiring is the one thing a trial clinic may not do
  const s = requireHiringSubscription(req);
  const b = await readBody(req);
  const username = String(b.username || "").trim();
  const password = String(b.password || "");
  if (!username || !b.fullName) throw badRequest("اسم المستخدم والاسم الكامل مطلوبان");
  checkPasswordPolicy(password);
  if (db.users.some((u) => String(u.username).toLowerCase() === username.toLowerCase()))
    throw new AppError(409, "اسم المستخدم مستخدم بالفعل");

  const role = normalizeRole(b.role) || "reception";
  if (!isSiteOwner(s.user) && !GRANTABLE_ROLES.includes(role))
    throw forbidden("لا يمكنك منح هذه الرتبة — الرتب المتاحة للموظفين: " + GRANTABLE_ROLES.map((r) => ROLE_LABELS[r]).join("، "));

  // a clinic owner can only staff their own clinic
  const ids = new Set(ownedClinicIds(s.user));
  const clinicId = isSiteOwner(s.user) && b.clinicId ? b.clinicId : s.user.clinicId;
  if (!isSiteOwner(s.user) && b.clinicId && !ids.has(b.clinicId))
    throw forbidden("لا يمكنك إضافة موظفين لعيادة أخرى");

  const user = {
    id: uid("user"), username, password: hashPassword(password), fullName: b.fullName,
    phone: b.phone || "", email: b.email || "", role, clinicId,
    // start from the role defaults; the owner may narrow or widen them below
    permissions: sanitizePermissions(b.permissions, role),
    twoFactorEnabled: false, trustedDevices: [], createdAt: now(),
  };
  db.users.push(user);
  save();
  audit(req, "user.create", { detail: user.id });
  json(res, 200, publicUser(user));
});

/** Keep only real permission keys with boolean values. */
function sanitizePermissions(input, role) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const k of PERMISSION_KEYS) {
    if (input[k] === true || input[k] === false) out[k] = input[k];
  }
  return out;
}

route("PUT", "/api/users", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const user = db.users.find((u) => u.id === b.id);
  if (!user) throw notFound("المستخدم غير موجود");

  const isSelf = user.id === s.user.id;
  const managesStaff = !isSelf;
  // never let a clinic owner touch a staff member of a different clinic
  if (managesStaff && !isSiteOwner(s.user) && !new Set(ownedClinicIds(s.user)).has(user.clinicId))
    throw forbidden("لا يمكنك تعديل مستخدم من عيادة أخرى");
  // editing someone else's account is staff management -> needs a paid subscription
  if (managesStaff && !isSiteOwner(s.user)) {
    requireHiringSubscription(req);
    if (s.user.role !== "admin")
      throw forbidden("تعديل الموظفين متاح لصاحب العيادة أو مالك الموقع فقط");
  }

  let roleChanged = false;
  if (b.role !== undefined) {
    const role = normalizeRole(b.role);
    if (!role) throw badRequest("رتبة غير معروفة");
    if (!isSiteOwner(s.user) && !GRANTABLE_ROLES.includes(role))
      throw forbidden("لا يمكنك منح هذه الرتبة — الرتب المتاحة: " + GRANTABLE_ROLES.map((r) => ROLE_LABELS[r]).join("، "));
    roleChanged = user.role !== role;
    user.role = role;
    // a new rank means a new baseline: drop the previous explicit grants so the
    // role defaults apply, unless the owner sent a fresh permission set below
    if (roleChanged && b.permissions === undefined) user.permissions = {};
  }
  if (b.permissions !== undefined) {
    if (!isSiteOwner(s.user) && s.user.role !== "admin")
      throw forbidden("منح الصلاحيات متاح لصاحب العيادة فقط");
    user.permissions = sanitizePermissions(b.permissions, user.role);
  }
  if (b.clinicId !== undefined && !isSiteOwner(s.user)) {
    if (!new Set(ownedClinicIds(s.user)).has(b.clinicId))
      throw forbidden("لا يمكنك نقل مستخدم إلى عيادة أخرى");
    user.clinicId = b.clinicId;
  }
  for (const k of ["fullName", "phone", "email", "twoFactorEnabled"])
    if (b[k] !== undefined) user[k] = b[k];
  if (b.password) {
    checkPasswordPolicy(String(b.password));
    user.password = hashPassword(b.password);
    // a password reset must invalidate every existing session + remembered device
    for (const h of userSessionHashes(user.id)) delete sessions[h];
    user.trustedDevices = [];
    saveSessions();
  }
  save();
  audit(req, "user.update", { detail: user.id + (b.password ? " (password reset)" : "") });
  json(res, 200, publicUser(user));
});

route("DELETE", "/api/users", async (req, res) => {
  const s = requireHiringSubscription(req);
  const b = await readBody(req);
  if (b.id === s.user.id) throw badRequest("لا يمكنك حذف حسابك الحالي");
  const i = db.users.findIndex((u) => u.id === b.id);
  if (i < 0) throw notFound("المستخدم غير موجود");
  if (!isSiteOwner(s.user) && !new Set(ownedClinicIds(s.user)).has(db.users[i].clinicId))
    throw forbidden("لا يمكنك حذف مستخدم من عيادة أخرى");
  db.users.splice(i, 1);
  save();
  audit(req, "user.delete", { detail: b.id });
  json(res, 200, { success: true });
});

/* ── ROLE & PERMISSION CATALOG (drives the owner's staff-permission UI) ── */

/** Who a locked clinic should talk to. Open on purpose: it is the one thing a
 *  clinic without a subscription is still allowed to do. */
route("GET", "/api/chat/support", async (req, res) => {
  requireSession(req);
  const helpdesk = db.users.find(isSupport);
  json(res, 200, {
    support: helpdesk ? { id: helpdesk.id, fullName: helpdesk.fullName, email: helpdesk.email } : null,
    ownerEmail: "911houssem@gmail.com",
  });
});

route("GET", "/api/roles", async (req, res) => {
  const s = requireSession(req);
  const siteOwner = isSiteOwner(s.user);
  json(res, 200, {
    permissions: PERMISSIONS,
    roles: Object.keys(ROLE_LABELS).map((id) => ({
      id,
      label: ROLE_LABELS[id],
      grantable: siteOwner || GRANTABLE_ROLES.includes(id),
      permissions: { ...(ROLE_PERMISSIONS[id] || NO_PERMISSIONS) },
    })),
    // what the caller itself may hand out
    grantableRoles: siteOwner ? ROLES : GRANTABLE_ROLES,
  });
});

/* ── RECORDS ── */

route("GET", "/api/records", async (req, res, p, url) => {
  const s = requireSession(req);
  const patientId = url.searchParams.get("patientId");
  const clinicId = clinicScope(req, url);
  const owned = new Set(ownedClinicIds(s.user));

  const decorate = (r) => {
    const d = userOf(r.doctorId);
    return { ...r, doctor: d ? { id: d.id, fullName: d.fullName } : null };
  };
  const list = db.records
    .filter((r) => {
      if (!isLive(r)) return false;
      const pt = patientOf(r.patientId);
      // never cross the clinic boundary, even when a patientId is supplied
      if (!pt || (!isSiteOwner(s.user) && !owned.has(pt.clinicId))) return false;
      if (patientId) return r.patientId === patientId;
      return !clinicId || pt.clinicId === clinicId;
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const paged = pagedResponse(url, list, TRASH_TYPES.records.search);
  if (paged) return json(res, 200, { ...paged, items: paged.items.map(decorate) });
  json(res, 200, list.map(decorate));
});

route("POST", "/api/records", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  if (!b.patientId) throw badRequest("المريض مطلوب");
  ownedPatient(s.user, b.patientId);
  const record = {
    id: uid("rec"), patientId: b.patientId, doctorId: b.doctorId || s.user.id,
    chiefComplaint: b.chiefComplaint || "", diagnosis: b.diagnosis || "",
    treatment: b.treatment || "", notes: b.notes || "", createdAt: now(),
  };
  db.records.push(record);
  save();
  json(res, 200, record);
});

route("PUT", "/api/records", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const r = db.records.find((x) => x.id === b.id);
  if (!r) throw notFound("السجل غير موجود");
  ownedPatient(s.user, r.patientId);
  for (const k of ["chiefComplaint", "diagnosis", "treatment", "notes"]) if (b[k] !== undefined) r[k] = b[k];
  save();
  json(res, 200, r);
});

route("DELETE", "/api/records", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const r = db.records.find((x) => x.id === b.id && isLive(x));
  if (!r) throw notFound("السجل غير موجود");
  ownedPatient(s.user, r.patientId);
  softDeleteRow(req, r);
  audit(req, "record.delete", { detail: r.id });
  json(res, 200, { success: true, softDeleted: true });
});

/* ── TASKS ──
 * Clinic-wide: every member of staff sees the same list. The handlers below
 * pin each task to the caller's own clinic so nobody can inject or edit a task
 * belonging to a clinic they do not work for.
 */

const clinicOfTask = (user, task) =>
  isSiteOwner(user) ||
  task.clinicId === user.clinicId ||
  new Set(ownedClinicIds(user)).has(task.clinicId);

route("GET", "/api/tasks", async (req, res, p, url) => {
  requireSession(req);
  const clinicId = clinicScope(req, url);
  const status = url.searchParams.get("status");
  let list = db.tasks.filter((t) => t.clinicId === clinicId && isLive(t));
  if (status) list = list.filter((t) => t.status === status);
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const paged = pagedResponse(url, list, TRASH_TYPES.tasks.search);
  if (paged) return json(res, 200, paged);
  json(res, 200, list);
});

/** Name list for pickers: who works here, with no credentials attached. */
route("GET", "/api/staff", async (req, res) => {
  const s = requireSession(req);
  const ids = new Set(ownedClinicIds(s.user));
  const list = db.users
    .filter((u) => ids.has(u.clinicId))
    .map((u) => ({ id: u.id, fullName: u.fullName, role: u.role, clinicId: u.clinicId }));
  json(res, 200, list);
});

route("POST", "/api/tasks", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  if (!b.title) throw badRequest("عنوان المهمة مطلوب");
  const wanted = b.clinicId || s.user.clinicId;
  const clinicId = wanted && (isSiteOwner(s.user) || new Set(ownedClinicIds(s.user)).has(wanted))
    ? wanted : s.user.clinicId;
  if (!clinicId) throw forbidden("لا توجد عيادة مرتبطة بحسابك");
  const task = {
    id: uid("task"), clinicId, title: b.title,
    description: b.description || "", assignedTo: b.assignedTo || "",
    priority: b.priority || "medium", status: b.status || "todo",
    dueDate: b.dueDate || "", createdAt: now(),
  };
  db.tasks.push(task);
  save();
  json(res, 200, task);
});

route("PUT", "/api/tasks", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const task = db.tasks.find((t) => t.id === b.id);
  if (!task) throw notFound("المهمة غير موجودة");
  if (!clinicOfTask(s.user, task)) throw forbidden("هذه المهمة تخص عيادة أخرى");
  for (const k of ["title", "description", "assignedTo", "priority", "status", "dueDate"])
    if (b[k] !== undefined) task[k] = b[k];
  save();
  json(res, 200, task);
});

route("DELETE", "/api/tasks", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const task = db.tasks.find((t) => t.id === b.id && isLive(t));
  if (!task) throw notFound("المهمة غير موجودة");
  if (!clinicOfTask(s.user, task)) throw forbidden("هذه المهمة تخص عيادة أخرى");
  softDeleteRow(req, task);
  audit(req, "task.delete", { detail: task.id });
  json(res, 200, { success: true, softDeleted: true });
});

/* ── SERVICES (the bookable menu: name + price + duration) ── */

/** Resolve the caller's clinic for a service write, mirroring the tasks rules. */
function serviceClinicId(user, wanted) {
  const clinicId = wanted || user.clinicId;
  if (!clinicId) throw forbidden("لا توجد عيادة مرتبطة بحسابك");
  if (!isSiteOwner(user) && !new Set(ownedClinicIds(user)).has(clinicId))
    throw forbidden("هذه الخدمة تخص عيادة أخرى");
  return clinicId;
}

/**
 * How long a service takes, in minutes. The owner sets this per service and the
 * number is authoritative: a 1 minute consultation stays 1 minute and a 45
 * minute treatment stays 45 — it is only clamped to a sane 1–10000 minute range.
 * The booking grid is unaffected: slot starts still chain in `dur` steps (never
 * finer than 15 minutes, see bookingSlots) so the day stays tidy.
 */
const DEFAULT_APPTMENT_MIN = 15;

function serviceDuration(service) {
  const wanted = num(service && service.durationMin, DEFAULT_APPTMENT_MIN);
  return Math.max(1, Math.min(10000, Math.round(wanted) || DEFAULT_APPTMENT_MIN));
}

route("GET", "/api/services", async (req, res, p, url) => {
  const s = requireSession(req);
  const ids = new Set(ownedClinicIds(s.user));
  let list = db.services.filter((x) => ids.has(x.clinicId) && isLive(x));
  if (url.searchParams.get("all") !== "true") list = list.filter((x) => x.isActive !== false);
  list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const paged = pagedResponse(url, list, TRASH_TYPES.services.search);
  if (paged) return json(res, 200, paged);
  json(res, 200, list);
});

route("POST", "/api/services", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  if (!b.name) throw badRequest("اسم الخدمة مطلوب");
  const clinicId = serviceClinicId(s.user, b.clinicId);
  const service = {
    id: uid("svc"), clinicId, name: String(b.name).slice(0, 120),
    description: String(b.description || "").slice(0, 300),
    durationMin: serviceDuration(b),
    price: Math.max(0, num(b.price, 0)),
    isActive: b.isActive !== false,
    sortOrder: num(b.sortOrder, db.services.filter((x) => x.clinicId === clinicId).length),
    createdAt: now(),
  };
  db.services.push(service);
  save();
  json(res, 200, service);
});

route("PUT", "/api/services", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const service = db.services.find((x) => x.id === b.id);
  if (!service) throw notFound("الخدمة غير موجودة");
  serviceClinicId(s.user, service.clinicId);
  if (b.name !== undefined) service.name = String(b.name).slice(0, 120);
  if (b.description !== undefined) service.description = String(b.description).slice(0, 300);
  if (b.durationMin !== undefined) service.durationMin = serviceDuration(b);
  if (b.price !== undefined) service.price = Math.max(0, num(b.price, 0));
  if (b.isActive !== undefined) service.isActive = !!b.isActive;
  if (b.sortOrder !== undefined) service.sortOrder = num(b.sortOrder, service.sortOrder || 0);
  save();
  json(res, 200, service);
});

route("DELETE", "/api/services", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const service = db.services.find((x) => x.id === b.id && isLive(x));
  if (!service) throw notFound("الخدمة غير موجودة");
  serviceClinicId(s.user, service.clinicId);
  softDeleteRow(req, service);
  audit(req, "service.delete", { detail: service.id });
  json(res, 200, { success: true, softDeleted: true });
});

/* ── INVENTORY ── */

route("GET", "/api/inventory", async (req, res, p, url) => {
  requireSession(req);
  let list = db.inventory.filter((i) => i.clinicId === clinicScope(req, url) && isLive(i));
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const paged = pagedResponse(url, list, TRASH_TYPES.inventory.search);
  if (paged) return json(res, 200, paged);
  json(res, 200, list);
});

const INV_NUMERIC = new Set(["quantity", "maxStock", "minStock", "unitPrice", "cost"]);

route("POST", "/api/inventory", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  if (!b.itemName) throw badRequest("اسم الصنف مطلوب");
  const item = {
    id: uid("inv_item"), clinicId: resolveWriteClinic(s.user, b.clinicId), itemName: b.itemName,
    itemNameEn: b.itemNameEn || "", category: b.category || "supply",
    quantity: num(b.quantity), maxStock: num(b.maxStock), minStock: num(b.minStock),
    unitPrice: num(b.unitPrice), cost: num(b.cost), supplier: b.supplier || "", createdAt: now(),
  };
  db.inventory.push(item);
  save();
  json(res, 200, item);
});

route("PUT", "/api/inventory", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const item = db.inventory.find((i) => i.id === b.id);
  assertRecordClinic(s.user, item, "الصنف");
  for (const k of ["itemName", "itemNameEn", "category", "quantity", "maxStock",
    "minStock", "unitPrice", "cost", "supplier"]) {
    if (b[k] !== undefined) item[k] = INV_NUMERIC.has(k) ? num(b[k]) : b[k];
  }
  save();
  json(res, 200, item);
});

route("DELETE", "/api/inventory", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  const item = db.inventory.find((x) => x.id === b.id && isLive(x));
  if (!item) throw notFound("الصنف غير موجود");
  assertRecordClinic(s.user, item, "الصنف");
  softDeleteRow(req, item);
  audit(req, "inventory.delete", { detail: item.id });
  json(res, 200, { success: true, softDeleted: true });
});

/* ── CHAT ──
 * A clinic (owner or staff) may only open a conversation with SUPPORT — the
 * "تواصل مع المالك" button is for reaching the helpdesk, not the site owner.
 * The site owner and support agents themselves can talk to anybody, because
 * support has to be able to answer the clinics.
 */
function chatPartners(user) {
  if (isSiteOwner(user) || isSupport(user)) return db.users;
  return db.users.filter((u) => isSupport(u));
}

function assertCanMessage(sender, receiverId) {
  // "support" is accepted as an alias so a locked clinic can reach the helpdesk
  // without knowing its internal user id
  const want = String(receiverId || "").trim();
  const receiver = userOf(want === "support"
    ? (db.users.find(isSupport) || {}).id
    : want);
  if (!receiver) throw notFound("المستخدم غير موجود");
  if (receiver.id === sender.id) throw badRequest("لا يمكنك مراسلة نفسك");
  if (isSiteOwner(sender) || isSupport(sender)) return receiver;
  if (!isSupport(receiver))
    throw forbidden("التواصل متاح مع الدعم الفني فقط");
  return receiver;
}

route("GET", "/api/chat", async (req, res, p, url) => {
  const s = requireSession(req);

  if (url.searchParams.get("mode") === "conversations") {
    const partners = chatPartners(s.user);
    const allUsers = partners
      .filter((u) => u.id !== s.user.id)
      .map((u) => ({ id: u.id, fullName: u.fullName, role: u.role, clinicId: u.clinicId }));
    const conversations = allUsers
      .map((u) => {
        const msgs = db.messages.filter(
          (m) => (m.senderId === s.user.id && m.receiverId === u.id) ||
                 (m.senderId === u.id && m.receiverId === s.user.id)
        );
        const last = msgs[msgs.length - 1];
        return {
          // The UI reads conversation.partner / conversation.partnerId and treats
          // lastMessage as an object ({senderId, message, createdAt}).
          partnerId: u.id,
          partner: u,
          lastMessage: last ? { ...last } : null,
          lastMessageAt: last ? last.createdAt : null,
          unreadCount: msgs.filter((m) => m.senderId === u.id && !m.isRead).length,
        };
      })
      .sort((a, b) => String(b.lastMessageAt || "").localeCompare(String(a.lastMessageAt || "")));
    const paged = pagedResponse(url, conversations, ["partnerId"]);
    if (paged) return json(res, 200, { ...paged, conversations: paged.items, allUsers });
    return json(res, 200, { conversations, allUsers });
  }

  const withId = url.searchParams.get("with");
  if (withId) {
    // reading a thread is the same door as writing to it: a clinic may only
    // open the thread it is allowed to have, i.e. with support
    assertCanMessage(s.user, withId);
    let dirty = false;
    for (const m of db.messages) {
      if (m.senderId === withId && m.receiverId === s.user.id && !m.isRead) { m.isRead = true; dirty = true; }
    }
    if (dirty) save();

    const messages = db.messages
      .filter((m) => (m.senderId === s.user.id && m.receiverId === withId) ||
                     (m.senderId === withId && m.receiverId === s.user.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((m) => {
        const sender = userOf(m.senderId);
        return { ...m, sender: sender ? { id: sender.id, fullName: sender.fullName, role: sender.role } : null };
      });
    const paged = pagedResponse(url, messages, ["message"]);
    if (paged) return json(res, 200, paged);
    return json(res, 200, { messages });
  }

  json(res, 200, { messages: [] });
});

route("POST", "/api/chat", async (req, res) => {
  const s = requireSession(req);
  const b = await readBody(req);
  if (!b.receiverId || !String(b.message || "").trim())
    throw badRequest("الرسالة أو المستلم مطلوب");
  assertCanMessage(s.user, b.receiverId);
  const msg = {
    id: uid("msg"), senderId: s.user.id, receiverId: b.receiverId,
    message: String(b.message).trim(), isRead: false, createdAt: now(),
  };
  db.messages.push(msg);
  save();
  json(res, 200, msg);
});

/* ── PLANS (public: landing page pricing) ── */

/**
 * `plan.features` historically lives in the db as an array while the client
 * JSON.parses it, and a single array value used to throw inside a React render
 * and blank the whole page. Always hand the client one predictable shape.
 */
function planForClient(plan) {
  const raw = plan.features;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; }
    catch { list = raw.split("\n").map((x) => x.trim()).filter(Boolean); }
  }
  return { ...plan, features: JSON.stringify(list.map((x) => String(x))) };
}

route("GET", "/api/subscriptions", async (req, res, p, url) => {
  const s = currentSession(req);
  const isAdmin = s && s.user.role === "super_admin" && url.searchParams.get("all") === "true";
  json(res, 200, db.plans.filter((x) => isAdmin || x.isActive).sort((a, b) => a.sortOrder - b.sortOrder).map(planForClient));
});

route("POST", "/api/subscriptions", async (req, res) => {
  requireSuperAdmin(req);
  const b = await readBody(req);
  if (!b.name) throw badRequest("اسم الخطة مطلوب");
  const plan = {
    id: uid("plan"), name: b.name, description: b.description || "",
    price: num(b.price), yearlyPrice: num(b.yearlyPrice), maxPatients: num(b.maxPatients),
    maxDoctors: num(b.maxDoctors), maxClinics: num(b.maxClinics),
    isPopular: !!b.isPopular, isActive: b.isActive !== false,
    sortOrder: num(b.sortOrder, db.plans.length),
    features: planFeatureList(b.features),
    createdAt: now(),
  };
  db.plans.push(plan);
  save();
  json(res, 200, planForClient(plan));
});

route("PUT", "/api/subscriptions/:id", async (req, res, p) => {
  requireSuperAdmin(req);
  const b = await readBody(req);
  const plan = db.plans.find((x) => x.id === p.id);
  if (!plan) throw notFound("الخطة غير موجودة");
  for (const k of ["name", "description", "price", "yearlyPrice", "maxPatients",
    "maxDoctors", "maxClinics", "isPopular", "isActive", "sortOrder"])
    if (b[k] !== undefined) plan[k] = b[k];
  if (b.features !== undefined) plan.features = planFeatureList(b.features);
  save();
  json(res, 200, planForClient(plan));
});

route("DELETE", "/api/subscriptions/:id", async (req, res, p) => {
  requireSuperAdmin(req);
  const i = db.plans.findIndex((x) => x.id === p.id);
  if (i < 0) throw notFound("الخطة غير موجودة");
  db.plans.splice(i, 1);
  save();
  json(res, 200, { success: true });
});

/** Accepts an array, a JSON string or newline separated text; stores an array. */
function planFeatureList(input) {
  if (Array.isArray(input)) return input.map((x) => String(x)).filter(Boolean);
  const text = String(input || "").trim();
  if (!text) return [];
  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean); }
  catch { /* fall through to the plain-text shape */ }
  return text.split("\n").map((x) => x.trim()).filter(Boolean);
}

/* ── CLINIC SUBSCRIPTIONS ── */

route("GET", "/api/clinic-subscriptions", async (req, res, p, url) => {
  const s = requireSession(req);
  // the site owner has no clinicId of their own, so ?all=true is the only way
  // they can ever see the list they are supposed to manage
  const all = isSiteOwner(s.user) && url.searchParams.get("all") === "true";
  const list = all
    ? db.clinicSubscriptions
    : db.clinicSubscriptions.filter((c) => c.clinicId === s.user.clinicId);
  json(res, 200, list.map((c) => ({
    ...c,
    plan: db.plans.find((x) => x.id === c.planId) || null,
    clinicName: (clinicOf(c.clinicId) || {}).name || "",
  })));
});

route("POST", "/api/clinic-subscriptions", async (req, res) => {
  // only the site owner may switch a clinic to a paid plan: otherwise a trial
  // owner could grant themselves an active subscription and hire anyway
  const s = requireSuperAdmin(req);
  const b = await readBody(req);
  const clinicId = String(b.clinicId || "");
  if (!clinicId || !db.clinics.some((c) => c.id === clinicId))
    throw badRequest("العيادة غير موجودة");
  const planId = String(b.planId || "");
  // planId is optional: the owner often just wants to switch a clinic to a paid
  // term without picking a tier, so a missing/blank one means the default plan.
  // A planId that IS given but unknown is still a client bug worth reporting.
  const plan = db.plans.find((p) => p.id === planId) ||
    (planId ? null : db.plans[0]);
  if (!plan) throw badRequest("الخطة غير موجودة");
  const planRef = planId || plan.id;

  const status = ["active", "trial", "cancelled", "expired"].includes(b.status) ? b.status : "active";
  const start = b.startDate || now();
  // default to the plan's own term so a grant always has a real end date
  const end = b.endDate ||
    new Date(Date.now() + (b.billingCycle === "yearly" ? 365 : 30) * 864e5).toISOString();

  // one live row per clinic: stacking them left the old trial shadowing the
  // grant, and accessSubscription() kept picking whichever sorted first
  const live = db.clinicSubscriptions.filter(
    (c) => c.clinicId === clinicId && ["active", "trial"].includes(c.status)
  );
  let sub;
  if (live.length) {
    sub = live[0];
    Object.assign(sub, { planId: planRef, status, startDate: start, endDate: end,
      trialEndDate: status === "trial" ? end : null,
      billingCycle: b.billingCycle || "monthly", notes: b.notes || "" });
    // older data may already hold several live rows for one clinic: keep the
    // first as the grant and retire the rest so nothing shadows it later
    for (const extra of live.slice(1)) {
      extra.status = "expired";
      extra.endDate = start;
      extra.notes = "استُبدل باشتراك جديد";
    }
  } else {
    sub = {
      id: uid("cs"), clinicId, planId: planRef, status, startDate: start, endDate: end,
      trialEndDate: status === "trial" ? end : null,
      billingCycle: b.billingCycle || "monthly", notes: b.notes || "",
    };
    db.clinicSubscriptions.push(sub);
  }
  save();
  json(res, 200, { ...sub, plan, clinicName: (clinicOf(clinicId) || {}).name || "" });
});

route("PUT", "/api/clinic-subscriptions/:id", async (req, res, p) => {
  requireSuperAdmin(req);
  const b = await readBody(req);
  const sub = db.clinicSubscriptions.find((c) => c.id === p.id);
  if (!sub) throw notFound("الاشتراك غير موجود");
  for (const k of ["planId", "status", "startDate", "endDate", "trialEndDate", "billingCycle", "notes"])
    if (b[k] !== undefined) sub[k] = b[k];
  // per-clinic module off-switches — the owner's "like permissions" picker
  if (b.modules !== undefined) sub.modules = sanitizeModules(b.modules);
  save();
  json(res, 200, sub);
});

route("DELETE", "/api/clinic-subscriptions/:id", async (req, res, p) => {
  requireSuperAdmin(req);
  const i = db.clinicSubscriptions.findIndex((c) => c.id === p.id);
  if (i < 0) throw notFound("الاشتراك غير موجود");
  db.clinicSubscriptions.splice(i, 1);
  save();
  json(res, 200, { success: true });
});

/* ── OFFERS (public: landing page offers) ── */

route("GET", "/api/offers", async (req, res) => {
  const s = currentSession(req);
  const isAdmin = s && s.user.role === "super_admin";
  json(res, 200, db.offers.filter((o) => isAdmin || o.isActive));
});

route("POST", "/api/offers", async (req, res) => {
  requireSuperAdmin(req);
  const b = await readBody(req);
  if (!b.title) throw badRequest("عنوان العرض مطلوب");
  const offer = {
    id: uid("offer"), title: b.title, description: b.description || "", badge: b.badge || "",
    discountType: b.discountType || "percentage", discountValue: num(b.discountValue),
    startDate: b.startDate || "", endDate: b.endDate || "",
    isActive: b.isActive !== false, createdAt: now(),
  };
  db.offers.push(offer);
  save();
  json(res, 200, offer);
});

route("PUT", "/api/offers/:id", async (req, res, p) => {
  requireSuperAdmin(req);
  const b = await readBody(req);
  const offer = db.offers.find((o) => o.id === p.id);
  if (!offer) throw notFound("العرض غير موجود");
  for (const k of ["title", "description", "badge", "discountType", "discountValue", "startDate", "endDate", "isActive"])
    if (b[k] !== undefined) offer[k] = b[k];
  save();
  json(res, 200, offer);
});

route("DELETE", "/api/offers/:id", async (req, res, p) => {
  requireSuperAdmin(req);
  const i = db.offers.findIndex((o) => o.id === p.id);
  if (i < 0) throw notFound("العرض غير موجود");
  db.offers.splice(i, 1);
  save();
  json(res, 200, { success: true });
});

/* ── PUBLIC PATIENT BOOKING (no login) ── */

/* The public day grid runs exactly like the app's own one: 08:00 through 22:00. */
const BOOKING_WINDOW = { openHour: 8, closeHour: 22, daysAhead: 90 };

/** Tiny in-memory throttle so the public form can't be used to flood the db. */
const bookingHits = new Map();
function throttleBooking(req) {
  const ip = req.socket.remoteAddress || "unknown";
  const cutoff = Date.now() - 10 * 60 * 1000;
  const list = (bookingHits.get(ip) || []).filter((t) => t > cutoff);
  if (list.length >= 8) throw new AppError(429, "محاولات كثيرة جداً، حاول بعد قليل");
  list.push(Date.now());
  bookingHits.set(ip, list);
  if (bookingHits.size > 5000) bookingHits.clear(); // keep the map bounded
}

const clinicBySlug = (slug) =>
  db.clinics.find((c) => String(c.bookingSlug || "").toLowerCase() === String(slug || "").toLowerCase()) || null;

function requireBookable(slug) {
  const clinic = clinicBySlug(slug);
  if (!clinic) throw notFound("رابط الحجز غير صحيح");
  if (!clinic.bookingEnabled) throw new AppError(403, "الحجز عبر الموقع غير مفعّل لهذه العيادة");
  return clinic;
}

/** Present when clinic staff have closed the public site, else null. */
function bookingClosure(clinic) {
  if (!clinic || !clinic.siteClosed) return null;
  return {
    message: String(clinic.siteClosedMessage || ""),
    until: String(clinic.siteClosedUntil || ""),
    by: String(clinic.siteClosedBy || ""),
    at: String(clinic.siteClosedAt || ""),
  };
}

const SITE_CLOSED_MSG = "الموقع مغلق مؤقتاً — يرجى التواصل مع العيادة مباشرةً";

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The clinic's active bookable menu, ordered for display. */
function clinicServices(clinic, activeOnly = true) {
  return db.services
    .filter((x) => x.clinicId === clinic.id && isLive(x) && (!activeOnly || x.isActive !== false))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
}

/** Public-safe shape of a service: no internal ids beyond its own. */
function serviceForClient(clinic, s) {
  return {
    id: s.id, name: s.name, description: s.description || "",
    durationMin: serviceDuration(s), price: num(s.price, 0),
  };
}

/**
 * Slot start times for a date, minus anything already booked — by the app or by
 * this page. Slots chain: the first starts at the opening hour (08:00) and each
 * following start lands exactly `durationMin` after the previous one, so a 15
 * minute clinic offers 08:00, 08:15, 08:30 … A busy stretch (a longer treatment
 * booked from the app) is skipped and the chain resumes the moment it ends, so
 * the next patient always starts when the previous visit is actually over.
 */
function bookingSlots(clinic, dateStr, doctorId, durationMin) {
  const day = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(day.getTime())) throw badRequest("التاريخ غير صالح");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const max = new Date(today); max.setDate(max.getDate() + BOOKING_WINDOW.daysAhead);
  if (day < today) throw badRequest("لا يمكن الحجز في تاريخ سابق");
  if (day > max) throw badRequest(`الحجز متاح حتى ${BOOKING_WINDOW.daysAhead} يوماً مقدماً`);

  const dur = Math.max(1, num(durationMin, DEFAULT_APPTMENT_MIN) || DEFAULT_APPTMENT_MIN);
  const step = Math.max(DEFAULT_APPTMENT_MIN, dur);

  // busy = [startMs, endMs) of everything already booked that day, whichever
  // door it came through (the app, or this page) — a booked hour is a booked hour
  const busy = db.appointments
    .filter((a) => a.clinicId === clinic.id && isLive(a) && !["cancelled", "canceled"].includes(String(a.status)))
    .filter((a) => (doctorId ? a.doctorId === doctorId : true))
    .filter((a) => sameDay(a.startTime, day))
    .map((a) => {
      const startMs = new Date(a.startTime).getTime();
      const endMs = a.endTime ? new Date(a.endTime).getTime() : startMs + dur * 60000;
      return [startMs, Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + dur * 60000];
    });

  const out = [];
  const nowMs = Date.now();
  const openMin = BOOKING_WINDOW.openHour * 60;
  const closeMin = BOOKING_WINDOW.closeHour * 60;   // 22:00 is a valid start, like in the app
  for (let t = openMin; t <= closeMin; t += step) {
    const hh = Math.floor(t / 60), mm = t % 60;
    const start = new Date(day); start.setHours(hh, mm, 0, 0);
    const startMs = start.getTime();
    const endMs = startMs + dur * 60000;
    const clash = busy.some(([bs, be]) => startMs < be && bs < endMs);
    out.push({
      time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      available: !clash && startMs > nowMs,
    });
  }
  return out;
}

/**
 * The earliest bookable slot on or after `fromDateStr` (today when missing),
 * scanning the whole booking window. Returns { date, time } or null when the
 * clinic is fully booked for the next `daysAhead` days. This is what lets the
 * public page hand the patient a time instead of asking them to pick one.
 */
function nextAvailable(clinic, fromDateStr, doctorId, durationMin) {
  const start = new Date(`${fromDateStr}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const base = Number.isNaN(start.getTime()) || start < today ? today : start;
  const max = new Date(today); max.setDate(max.getDate() + BOOKING_WINDOW.daysAhead);
  for (let i = 0; i <= BOOKING_WINDOW.daysAhead; i++) {
    const d = new Date(base); d.setDate(d.getDate() + i);
    if (d > max) break;
    const ds = ymd(d);
    const free = bookingSlots(clinic, ds, doctorId, durationMin).find((s) => s.available);
    if (free) return { date: ds, time: free.time };
  }
  return null;
}

/** Look up one bookable service of this clinic, or null. */
function pickService(clinic, serviceId) {
  if (!serviceId) return null;
  return clinicServices(clinic).find((x) => x.id === String(serviceId)) || null;
}

route("GET", "/api/public/booking/:slug", async (req, res, p) => {
  const clinic = requireBookable(p.slug);
  res.setHeader("Cache-Control", "no-store");
  const closure = bookingClosure(clinic);
  json(res, 200, {
    clinic: {
      name: clinic.name, address: clinic.address || "", phone: clinic.phone || "",
      currency: clinic.currency || "SAR",
    },
    closed: !!closure,
    closedMessage: closure ? closure.message : "",
    closedUntil: closure ? closure.until : "",
    services: clinicServices(clinic).map((s) => serviceForClient(clinic, s)),
    doctors: db.users
      .filter((u) => u.clinicId === clinic.id && ["doctor", "nurse"].includes(u.role))
      .map((u) => ({ id: u.id, fullName: u.fullName })),
    window: BOOKING_WINDOW,
  });
});

route("GET", "/api/public/booking/:slug/slots", async (req, res, p, url) => {
  const clinic = requireBookable(p.slug);
  res.setHeader("Cache-Control", "no-store");
  if (clinic.siteClosed)
    return json(res, 200, { closed: true, date: url.searchParams.get("date") || "", durationMin: DEFAULT_APPTMENT_MIN, next: null, slots: [] });
  const date = url.searchParams.get("date") || ymd(new Date());
  const doctorId = url.searchParams.get("doctorId") || "";
  const service = pickService(clinic, url.searchParams.get("serviceId"));
  const durationMin = service ? serviceDuration(service) : DEFAULT_APPTMENT_MIN;
  json(res, 200, {
    date,
    durationMin,
    next: nextAvailable(clinic, date, doctorId, durationMin),
    slots: bookingSlots(clinic, date, doctorId, durationMin),
  });
});

route("POST", "/api/public/booking/:slug", async (req, res, p) => {
  throttleBooking(req);
  const clinic = requireBookable(p.slug);
  const b = await readBody(req);
  if (clinic.siteClosed)
    throw new AppError(423, bookingClosure(clinic)?.message || SITE_CLOSED_MSG);

  const name = String(b.patientName || b.name || "").trim();
  const phone = String(b.phone || "").trim();
  const date = String(b.date || "").trim();
  const wanted = String(b.time || "").trim();
  const doctorId = String(b.doctorId || "");

  if (name.length < 3) throw badRequest("الاسم مطلوب (٣ أحرف على الأقل)");
  if (name.length > 80) throw badRequest("الاسم طويل جداً");
  if (!/^[\d+\-\s()]{7,20}$/.test(phone)) throw badRequest("رقم جوال غير صالح");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("التاريخ غير صالح");
  // A real clock time is required when one is supplied — otherwise "99:99"
  // silently fell through to the earliest free slot and booked it.
  if (wanted && !/^([01]\d|2[0-3]):[0-5]\d$/.test(wanted)) throw badRequest("الوقت غير صالح");
  const email = String(b.email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("البريد الإلكتروني غير صالح");

  if (doctorId && !db.users.some((u) => u.id === doctorId && u.clinicId === clinic.id))
    throw badRequest("الطبيب المحدد غير موجود");

  const service = pickService(clinic, b.serviceId);
  if (b.serviceId && !service) throw badRequest("الخدمة المحددة غير متاحة");
  const durationMin = service ? serviceDuration(service) : DEFAULT_APPTMENT_MIN;

  // One visit per person per day: match on the phone digits so different
  // spellings of the same number can't sneak a second booking through.
  const phoneDigits = (v) => String(v).replace(/\D/g, "");
  const samePhoneDay = db.appointments.some((a) => {
    if (a.clinicId !== clinic.id) return false;
    if (!isLive(a)) return false;
    if (a.status === "cancelled" || a.status === "canceled") return false;
    if (!a.startTime || ymd(new Date(a.startTime)) !== date) return false;
    const owner = db.patients.find((p2) => p2.id === a.patientId && isLive(p2));
    return !!owner && phoneDigits(owner.phone) === phoneDigits(phone);
  });
  if (samePhoneDay)
    throw new AppError(409, "لديك موعد محجوز بالفعل في هذا اليوم — لا يمكن حجز أكثر من موعد واحد في نفس اليوم");

  // The patient never picks a time: the clinic hands out the earliest free slot
  // on the chosen day, chained right after whatever is already booked. An
  // explicit, still-free `time` from an older client is still honoured.
  const daySlots = bookingSlots(clinic, date, doctorId, durationMin);
  const chosen =
    (wanted && daySlots.find((s) => s.time === wanted && s.available)) ||
    daySlots.find((s) => s.available);
  if (!chosen)
    throw new AppError(409, "عذراً، انتهت المواعيد المتاحة في هذا اليوم — جرّب يوماً آخر");
  const time = chosen.time;

  const startMs = new Date(`${date}T${time}:00`).getTime();
  if (appointmentClashes(clinic.id, doctorId, startMs, startMs + durationMin * 60000))
    throw new AppError(409, "عذراً، انتهت المواعيد المتاحة في هذا اليوم — جرّب يوماً آخر");

  // reuse an existing patient with the same phone, otherwise create one
  let patient = db.patients.find((p2) => p2.clinicId === clinic.id && p2.phone === phone && isLive(p2));
  if (!patient) {
    patient = {
      id: uid("pat"), clinicId: clinic.id, fullName: name, gender: b.gender || "",
      age: Math.min(130, Math.max(0, num(b.age, 0))), phone, email,
      bloodType: "", allergies: "", source: "booking", createdAt: now(),
    };
    db.patients.push(patient);
  }

  const start = new Date(`${date}T${time}:00`);
  const manageToken = crypto.randomBytes(32).toString("hex");
  const appt = {
    id: uid("apt"), clinicId: clinic.id, patientId: patient.id, doctorId,
    title: service ? service.name : "حجز عبر الموقع", type: "consultation",
    serviceId: service ? service.id : "",
    price: service ? num(service.price, 0) : 0,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + durationMin * 60000).toISOString(),
    status: "scheduled", notes: String(b.note || "").slice(0, 500),
    source: "booking", createdAt: now(),
    // cancel/reschedule capability: only the holder of the raw token can act,
    // and only up to the appointment time
    manageTokenHash: sha256(manageToken),
    manageTokenExpiresAt: start.toISOString(),
    consentAt: b.consent === true ? now() : null,
  };
  db.appointments.push(appt);

  // confirmation, only when the clinic opted into notifications
  const ncfg = notifyConfig(clinic.id);
  if (ncfg && ncfg.enabled) {
    const parts = clinicDateParts(ncfg.timezone || "Asia/Riyadh", start.getTime());
    const vars = { clinic: clinic.name, name, date: parts.date, time: parts.time };
    vars.message = renderTemplate((ncfg.templates || {}).booking_confirmation || "تم تأكيد حجزك", vars);
    enqueueNotification({ clinicId: clinic.id, channel: ncfg.channel, to: phone, templateKey: "booking_confirmation", vars });
  }
  save();

  json(res, 200, {
    success: true,
    appointment: {
      id: appt.id, date, time, clinicName: clinic.name,
      serviceName: service ? service.name : "",
      durationMin, price: appt.price, currency: clinic.currency || "SAR",
      manageToken,
      manageUrl: `${publicBaseUrl()}/booking/${clinic.bookingSlug}?manage=${manageToken}`,
    },
    message: `تم استلام طلب الحجز بنجاح، ${name}.`,
  });
});

/* ── PUBLIC BOOKING PAGE (self-contained, no build step) ── */

const { buildBookingPage } = require("./booking-page.js");

/**
 * Resolve the clinic behind the slug and hand the resolved values to the
 * standalone builder in booking-page.js, which owns the page's HTML/CSS/JS.
 */
function bookingPage(slug) {
  const clinic = clinicBySlug(slug);
  const name = clinic ? clinic.name : "عيادة";
  const ok = !!clinic && !!clinic.bookingEnabled;
  return buildBookingPage({
    slug: ok ? slug : null,
    name,
    daysAhead: BOOKING_WINDOW.daysAhead,
  });
}

/* ── BACKUP ── */

route("POST", "/api/backup/export", async (req, res) => {
  const s = requireSuperAdmin(req);
  const payload = {
    exportedAt: now(),
    exportedBy: s.user.fullName,
    clinics: db.clinics,
    users: db.users.map(publicUser),
    patients: db.patients,
    appointments: db.appointments,
    invoices: db.invoices,
    tasks: db.tasks,
    records: db.records,
    inventory: db.inventory,
    plans: db.plans,
    clinicSubscriptions: db.clinicSubscriptions,
    offers: db.offers,
  };
  respond(res, 200, JSON.stringify(payload, null, 2), {
    "Content-Type": MIME[".json"],
    "Content-Disposition": `attachment; filename="clinic-backup-${Date.now()}.json"`,
  });
  audit(req, "backup.export");
});

/* ══════════════════════════ 9. STATIC FILES ══════════════════════════
 * Deny-by-default: only a small, explicit allowlist of public assets is ever
 * served. Everything else (server.js, the data/ folder, tools/, tests, dotfiles,
 * any .json except the web manifest, backups, source files) 404s — even though
 * it technically lives under ROOT.
 */

const STATIC_ALLOW = [
  /^\/$/,
  /^\/index\.html$/i,
  /^\/booking-page\.js$/i,
  /^\/favicon\.(?:ico|svg|png|webmanifest)$/i,
  /^\/manifest\.json$/i,
  /^\/robots\.txt$/i,
  /^\/_next\/static\/[A-Za-z0-9._\/-]+$/,
  /^\/lib\/[A-Za-z0-9._\/-]+$/,
  /^\/docs\/screenshots\/[A-Za-z0-9._-]+\.png$/i,
];
// Folders that must never be web-reachable, whatever their contents.
const STATIC_BLOCK_DIRS = new Set(["data", "tools", "tests", "node_modules", ".git", ".github", "backups"]);

/** Rejects dotfiles, traversal segments and private folders. */
function staticSegmentsSafe(p) {
  for (const seg of p.split("/").filter(Boolean)) {
    if (seg === "." || seg === "..") return false;
    if (seg.startsWith(".")) return false; // .gitignore, .env, .git, ...
    if (STATIC_BLOCK_DIRS.has(seg.toLowerCase())) return false;
  }
  return true;
}

/** True only for paths on the public allowlist (checked before touching disk). */
function staticPathAllowed(rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath); } catch { return false; }
  if (p.includes("\0")) return false;
  if (!staticSegmentsSafe(p)) return false;

  const segs = p.split("/").filter(Boolean);
  const last = (segs[segs.length - 1] || "").toLowerCase();
  const isManifest = last === "manifest.json";
  if (!isManifest && /\.(?:json|md|log|env|bak|tmp|orig|orig2|db|sqlite|sqlite3|yml|yaml|map)$/.test(last))
    return false;
  if (last.endsWith(".pre-ui8")) return false;
  return STATIC_ALLOW.some((rx) => rx.test(p));
}

/** Client-side routes may fall back to the app shell, but never dotfiles/private dirs. */
function spaFallbackAllowed(rawPath) {
  let p;
  try { p = decodeURIComponent(rawPath); } catch { return false; }
  if (p.includes("\0") || !staticSegmentsSafe(p)) return false;
  return !path.extname(p) || p.endsWith("/");
}

/** Returns an absolute path inside ROOT, or null if it escapes / is unusable. */
function resolveStatic(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;

  if (decoded.endsWith("/")) decoded += "index.html";
  const target = path.resolve(ROOT, `.${path.posix.normalize(decoded)}`);
  const root = path.resolve(ROOT);

  if (target !== root && !target.startsWith(root + path.sep)) return null; // traversal
  return target;
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** Streams a file. Every failure mode resolves instead of throwing. */
function pipeFile(req, res, file, st, cacheControl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const stream = fs.createReadStream(file);

    stream.on("error", (e) => {
      fail("static read failed:", path.relative(ROOT, file), e.code || e.message);
      if (!res.headersSent) respond(res, 500, { error: "تعذّر قراءة الملف" });
      else try { res.end(); } catch { /* gone */ }
      done();
    });

    res.on("close", () => { stream.destroy(); done(); }); // client aborted
    res.on("error", () => { stream.destroy(); done(); });
    res.on("finish", done);

    try {
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": cacheControl,
        "Last-Modified": st.mtime.toUTCString(),
      });
      stream.pipe(res);
    } catch (e) {
      fail("static write failed:", e.message);
      stream.destroy();
      try { res.end(); } catch { /* gone */ }
      done();
    }
  });
}

async function serveStatic(req, res, urlPath) {
  // deny-by-default gate first: never even stat a non-allowlisted path
  const target = staticPathAllowed(urlPath) ? resolveStatic(urlPath) : null;

  if (target) {
    let st = await statOrNull(target);
    if (st && st.isDirectory()) {
      const idx = path.join(target, "index.html");
      st = await statOrNull(idx);
      if (st && st.isFile())
        return pipeFile(req, res, idx, st, "no-store");
    } else if (st && st.isFile()) {
      const ext = path.extname(target).toLowerCase();
      return pipeFile(req, res, target, st, ext === ".html" ? "no-store" : "public, max-age=3600");
    }
  }

  // SPA fallback — the app is client-side routed, so unknown paths get the shell.
  if (spaFallbackAllowed(urlPath)) {
    const shell = path.join(ROOT, "index.html");
    const st = await statOrNull(shell);
    if (st && st.isFile()) return pipeFile(req, res, shell, st, "no-store");
  }

  return false;
}

/* ══════════════════════════ 10. REQUEST PIPELINE ══════════════════════════ */

const ALLOWED_ORIGIN = process.env.ORIGIN || null;

/** Hardened response headers applied to EVERY response (API, static, shell). */
function securityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  // The exported SPA + booking page both embed a small inline <script> and use
  // inline style attributes, so 'unsafe-inline' is required for script/style.
  // Everything else is locked to same-origin and objects are disabled.
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  if (isSecureRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

/**
 * An Origin is "ours" only when it exactly equals the configured ORIGIN, or —
 * when no ORIGIN is configured — when its host matches the Host we were reached
 * on (i.e. same-origin). Anything else is refused, including on OPTIONS.
 */
function originAllowed(req, origin) {
  if (!origin || !req) return false;
  if (ALLOWED_ORIGIN) return origin === ALLOWED_ORIGIN;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function cors(req, res) {
  const origin = req.headers.origin;
  // Reflect ONLY an origin we trust. A foreign Origin gets no ACAO at all, so
  // the browser blocks the response — for simple requests and preflights alike.
  if (origin && originAllowed(req, origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  // Vary on Origin whenever the caller sent one (a shared cache must not reuse a
  // response minted for another origin). A missing Origin (curl, same-origin GET,
  // navigations) needs no ACAO: CORS does not apply to it.
  if (origin) res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS");
  securityHeaders(req, res);
}

/* ── Rate limiting (in-memory token buckets keyed by client IP) ──
 * The first matching rule wins; requests are only throttled under /api/ so
 * static assets and the app shell are never affected. */

const rateBuckets = new Map(); // "name:ip" -> { count, reset }
const RATE_RULES = [
  { name: "login", test: (p) => p === "/api/auth/login", max: IS_PROD ? 15 : 150, windowMs: 60_000 },
  { name: "auth", test: (p) => p.startsWith("/api/auth/"), max: IS_PROD ? 60 : 600, windowMs: 60_000 },
  { name: "booking", test: (p) => p.startsWith("/api/public/"), max: IS_PROD ? 120 : 1200, windowMs: 60_000 },
  { name: "api", test: () => true, max: IS_PROD ? 300 : 5000, windowMs: 60_000 },
];

function checkRate(req, urlPath) {
  const ip = clientIp(req);
  const nowMs = Date.now();
  const rule = RATE_RULES.find((r) => r.test(urlPath));
  if (!rule) return;
  const key = `${rule.name}:${ip}`;
  let b = rateBuckets.get(key);
  if (!b || b.reset <= nowMs) { b = { count: 0, reset: nowMs + rule.windowMs }; rateBuckets.set(key, b); }
  b.count++;
  if (b.count > rule.max) throw new AppError(429, "طلبات كثيرة جداً — حاول بعد قليل");
}

function pruneRateBuckets() {
  const nowMs = Date.now();
  for (const [k, b] of rateBuckets) if (b.reset <= nowMs) rateBuckets.delete(k);
}

/* ── CSRF defence ──
 * Cookies are SameSite=Lax (a cross-site form post won't carry them), and any
 * request that carries a body MUST be application/json — something a cross-site
 * HTML form cannot produce without a CORS preflight. A mismatched Origin is
 * rejected outright when present. */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function assertRequestSafe(req) {
  if (!UNSAFE_METHODS.has(req.method)) return;

  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = ALLOWED_ORIGIN ? origin === ALLOWED_ORIGIN : new URL(origin).host === req.headers.host; }
    catch { ok = false; }
    if (!ok) throw forbidden("طلب من أصل غير مسموح");
  }

  const len = Number(req.headers["content-length"]);
  const hasBody = (Number.isFinite(len) && len > 0) || !!req.headers["transfer-encoding"];
  if (hasBody) {
    const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json")
      throw new AppError(415, "نوع المحتوى يجب أن يكون application/json");
  }
}

async function handle(req, res) {
  cors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let urlPath;
  try {
    const raw = req.url || "/";
    if (raw.length > LIMITS.urlBytes) throw badRequest("الرابط طويل جداً");
    urlPath = new URL(raw, "http://localhost").pathname;
  } catch (e) {
    respond(res, 400, { error: e.expected ? e.message : "طلب غير صالح" });
    return;
  }

  if (urlPath.startsWith("/api/")) {
    try { checkRate(req, urlPath); assertRequestSafe(req); }
    catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      respond(res, status, { error: e.message });
      return;
    }

    const match = routes.find((r) => r.method === req.method && r.rx.test(urlPath));
    if (!match) {
      const pathExists = routes.some((r) => r.rx.test(urlPath));
      respond(res, pathExists ? 405 : 404,
        { error: pathExists ? "طريقة الطلب غير مدعومة" : "المسار غير موجود" });
      return;
    }

    const m = urlPath.match(match.rx);
    const params = {};
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

    try {
      enforceSubscription(req, urlPath);
      enforcePermission(req, urlPath);
      await match.handler(req, res, params, new URL(req.url, "http://localhost"));
    } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      if (status >= 500) fail(`${req.method} ${urlPath} →`, e.stack || e.message);
      else warn(`${req.method} ${urlPath} → ${status} ${e.message}`);
      respond(res, status, { error: status >= 500 ? "حدث خطأ في الخادم" : e.message });
    }
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    // liveness/readiness probe for a reverse proxy or orchestrator
    if (urlPath === "/healthz" || urlPath === "/readyz") {
      respond(res, 200, "ok");
      return;
    }
    // public booking page: /booking/<slug>
    const bmatch = urlPath.match(/^\/booking\/([^/]+)\/?$/);
    if (bmatch) {
      let slug = "";
      try { slug = decodeURIComponent(bmatch[1]); } catch { slug = bmatch[1]; }
      respond(res, 200, bookingPage(slug), {
        "Content-Type": `${MIME[".html"]}; charset=utf-8`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      });
      return;
    }
    if (await serveStatic(req, res, urlPath)) return;
  }

  respond(res, 404, { error: "الصفحة غير موجودة" }, { "Content-Type": MIME[".html"] });
}

const server = http.createServer((req, res) => {
  // A reset/broken socket is normal on the web — never let it reach the process.
  res.on("error", () => {});
  req.on("error", () => {});
  req.on("aborted", () => {});

  // The single safety net: nothing an async handler does can kill the process.
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((e) => {
      fail("unhandled in request pipeline:", (e && e.stack) || e);
      respond(res, 500, { error: "حدث خطأ في الخادم" });
    });
});

server.maxConnections = LIMITS.maxConnections;
server.headersTimeout = LIMITS.headersTimeout;
server.requestTimeout = LIMITS.requestTimeout;
server.keepAliveTimeout = LIMITS.keepAliveTimeout;
server.on("clientError", (e, socket) => {
  warn("clientError:", e.code || e.message);
  if (socket && !socket.destroyed && socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  else if (socket && !socket.destroyed) socket.destroy();
});

/* ══════════════════════════ 11. BOOT & LIFECYCLE ══════════════════════════ */

function processAliveHooks() {
  process.on("uncaughtException", (e) => {
    fail("UNCAUGHT EXCEPTION — server kept alive:", (e && e.stack) || e);
    toFile(`FATAL uncaughtException: ${(e && e.stack) || e}`);
  });

  process.on("unhandledRejection", (reason) => {
    fail("UNHANDLED REJECTION — server kept alive:", (reason && reason.stack) || reason);
    toFile(`FATAL unhandledRejection: ${(reason && reason.stack) || reason}`);
  });

  process.on("warning", (w) => warn("process warning:", w.name, w.message));

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  log(`${signal} received — shutting down gracefully...`);
  clearInterval(sweeper);
  clearInterval(backupTimer);
  server.close(() => {
    flush().finally(() => {
      runBackup("shutdown");
      log("goodbye.");
      process.exit(0);
    });
  });
  // don't hang forever on stuck keep-alive sockets
  setTimeout(() => {
    warn("forcing exit after 5s");
    process.exit(0);
  }, 5000).unref();
}

function listen(port, host, attemptsLeft = 12) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") {
      const hint =
        `\n  ✖ المنفذ ${port} مستخدم بالفعل — هناك نسخة أخرى تعمل.\n` +
        `\n` +
        `   Solutions:\n` +
        `      • افتح الموقع في المتصفح:  http://${host}:${port}\n` +
        `      • أوقف النسخة الأخرى:      taskkill /PID <PID> /F\n` +
        `      • أو شغّل على منفذ آخر:     node server.js --port ${port + 1}\n` +
        `      • أو منفذ تلقائي:           node server.js --auto-port\n`;

      if (AUTO_PORT && attemptsLeft > 0) {
        warn(`port ${port} busy — trying ${port + 1}`);
        listen(port + 1, host, attemptsLeft - 1);
        return;
      }
      fail(hint);
      toFile(`FATAL EADDRINUSE on ${host}:${port} — another instance is already running`);
      process.exit(1); // explicit, with a readable message instead of a raw stack dump
    }

    if (e.code === "EACCES") {
      fail(
        `\n  ✖ لا توجد صلاحية لاستخدام المنفذ ${port}.\n` +
          `    Use a port above 1023, e.g.  node server.js --port ${port + 1}\n`
      );
      toFile(`FATAL EACCES on ${host}:${port}`);
      process.exit(1);
    }

    fail("listen failed:", (e && e.stack) || e);
    toFile(`FATAL listen: ${(e && e.stack) || e}`);
    process.exit(1);
  });

  server.listen(port, host);
}

const sweeper = setInterval(() => {
  try {
    const removed = pruneSessions();
    if (removed) {
      saveSessions();
      log(`swept ${removed} expired session(s)`);
    }
    const purged = purgeExpiredTrash();
    if (purged) log(`purged ${purged} trashed row(s) past the ${Math.round(LIMITS.trashTtlMs / 86400000)}-day window`);
    const staleResets = pruneResets();
    if (staleResets) saveResets();
    pruneRateBuckets();
  } catch (e) {
    fail("session sweeper error:", e.message); // never let the interval die
  }
}, LIMITS.sessionSweepMs);
if (sweeper.unref) sweeper.unref();

const queueTimer = setInterval(() => { processNotificationQueue().catch((e) => fail("queue worker error:", e.message)); }, LIMITS.queueSweepMs);
if (queueTimer.unref) queueTimer.unref();

const reminderTimer = setInterval(() => {
  try { sweepReminders(); } catch (e) { fail("reminder sweep error:", e.message); }
}, LIMITS.reminderSweepMs);
if (reminderTimer.unref) reminderTimer.unref();

const backupTimer = setInterval(() => runBackup("scheduled"), LIMITS.backupIntervalMs);
if (backupTimer.unref) backupTimer.unref();

function banner(actualPort) {
  const mem = Math.round(process.memoryUsage().rss / 1048576);
  const creds = IS_PROD
    ? "     الإنتاج     لا حسابات تجريبية — أنشئ المالك عبر OWNER_* أو --create-owner"
    : `     حسابات تجريبية:
       admin      / admin123       مدير عام
       doctor     / doctor123      طبيب
       reception  / reception123   استقبال`;
  console.log(`
  ==============================================
    نظام عيادة — يعمل${IS_PROD ? " (إنتاج)" : " محلياً"}
  ==============================================

     ▸ الموقع     http://${HOST}:${actualPort}
     ▸ الصحة      http://${HOST}:${actualPort}/api/health
     ▸ Node       ${process.version}   (RSS ${mem} MB)

${creds}

     البيانات    ${path.relative(path.resolve(ROOT), DATA_DIR) || DATA_DIR}
     السجل       ${path.join(path.relative(path.resolve(ROOT), DATA_DIR) || DATA_DIR, "server.log")}
     إيقاف       Ctrl+C
`);
}

function startupChecks() {
  const rel = path.relative(path.resolve(ROOT), path.resolve(DATA_DIR));
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    warn(`DATA_DIR is inside the web root (${DATA_DIR}). The static allowlist blocks it,`);
    warn("but production should point DATA_DIR at a folder outside the deploy directory.");
  }
  if (IS_PROD && !ALLOWED_ORIGIN)
    warn("NODE_ENV=production without ORIGIN set: CORS will only accept same-host origins.");
  if (IS_PROD && HOST !== "127.0.0.1" && HOST !== "localhost" && !TRUST_PROXY)
    warn("listening on a public interface without TRUST_PROXY=1: client IP throttling may see the proxy IP.");
  if (!ENCRYPTION_KEY) {
    if (IS_PROD) {
      fail("ENCRYPTION_KEY is required when NODE_ENV=production (it seals the TOTP");
      fail("seeds and the medical fields at rest). Set a long random value and restart.");
      process.exit(1);
    }
    warn("ENCRYPTION_KEY is unset: medical fields (blood type, allergies, record notes) are stored in clear.");
  }
}

/**
 * `node server.js --create-owner` — create (or reset) the first site owner from
 * OWNER_USERNAME / OWNER_PASSWORD (or --owner-username / --owner-password),
 * persist, and exit. The password is never printed.
 */
function createOwnerCli() {
  const username = String(process.env.OWNER_USERNAME || argOf("owner-username") || "").trim();
  const password = process.env.OWNER_PASSWORD || argOf("owner-password") || "";
  if (!username || !password) {
    fail("usage: OWNER_USERNAME=<name> OWNER_PASSWORD=<12+ chars> node server.js --create-owner");
    process.exit(2);
  }
  try { checkPasswordPolicy(password); }
  catch (e) { fail("owner password rejected:", e.message); process.exit(2); }

  const existing = db.users.find((u) => String(u.username).toLowerCase() === username.toLowerCase());
  if (existing) {
    existing.password = hashPassword(password);
    existing.role = "super_admin";
    log(`owner password set for ${username} (not logged)`);
  } else {
    db.users.push({
      id: uid("user"), username, password: hashPassword(password),
      fullName: String(process.env.OWNER_NAME || "مالك الموقع").trim() || "مالك الموقع",
      phone: String(process.env.OWNER_PHONE || "").trim(),
      email: String(process.env.OWNER_EMAIL || "").trim(),
      role: "super_admin", clinicId: null, permissions: {},
      twoFactorEnabled: false, trustedDevices: [], createdAt: now(),
    });
    log(`owner account created: ${username} (not logged)`);
  }
  audit(null, "owner.create", { username });
  hardenPerms();
}

processAliveHooks();
startupChecks();
load();
if (CREATE_OWNER) {
  createOwnerCli();
  flush().then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  hardenPerms();
  runBackup("boot");
  listen(PORT, HOST);
  server.on("listening", () => banner(server.address().port));
}