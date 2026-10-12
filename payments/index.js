"use strict";

/**
 * Payments abstraction — providers implement:
 *   createIntent({ amount, currency, invoiceId, clinicId, config }) -> { ok, id, status }
 *   verifyWebhook({ body, config }) -> { ok, id, status } (throws/400 on bad signature)
 *
 * Built-ins: cash (desk, settles immediately), transfer (pending until the
 * bank confirms — via webhook or manual confirm), mock (scripted stand-in for
 * tests; a REAL provider such as CIB/SATIM plugs in here later with its own
 * credentials + webhook scheme — never wire one without its official docs).
 */
const crypto = require("crypto");

const cash = {
  name: "cash",
  async createIntent({ amount, invoiceId }) {
    if (!(amount > 0)) throw new Error("cash: amount must be positive");
    return { ok: true, id: `cash_${crypto.randomBytes(8).toString("hex")}`, status: "paid", invoiceId };
  },
  async verifyWebhook() { throw new Error("cash has no webhook (desk payments settle inline)"); },
};

const transfer = {
  name: "transfer",
  async createIntent({ amount, invoiceId }) {
    if (!(amount > 0)) throw new Error("transfer: amount must be positive");
    return { ok: false, id: `trf_${crypto.randomBytes(8).toString("hex")}`, status: "pending", invoiceId };
  },
  // bank-initiated confirmation, HMAC-signed with the shared secret
  async verifyWebhook({ body, config }) {
    const secret = (config && config.webhookSecret) || process.env.PAYMENTS_WEBHOOK_SECRET || "";
    const { paymentId, status, signature } = body || {};
    if (!paymentId || !status || !signature) throw new Error("transfer webhook: missing fields");
    if (!secret) throw new Error("transfer webhook: no secret configured");
    const want = crypto.createHmac("sha256", secret).update(`${paymentId}.${status}`).digest("hex");
    const a = Buffer.from(String(signature)), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("transfer webhook: bad signature");
    if (!["paid", "failed"].includes(status)) throw new Error("transfer webhook: unknown status");
    return { ok: true, id: paymentId, status };
  },
};

// Scripted stand-in: amounts ending in .13 fail, everything else succeeds.
// Used by the test-suite and by integrators before touching real money.
const mock = {
  name: "mock",
  async createIntent({ amount, invoiceId }) {
    if (!(amount > 0)) throw new Error("mock: amount must be positive");
    const fail = Math.abs(amount * 100 % 100 - 13) < 1e-9;
    return fail
      ? { ok: false, id: `mock_${crypto.randomBytes(8).toString("hex")}`, status: "failed", invoiceId }
      : { ok: true, id: `mock_${crypto.randomBytes(8).toString("hex")}`, status: "paid", invoiceId };
  },
  async verifyWebhook({ body, config }) {
    return transfer.verifyWebhook({ body, config }); // same HMAC contract
  },
};

const providers = { cash, transfer, mock };

module.exports = {
  providers,
  get(name) { return providers[name] || null; },
  has(name) { return !!providers[name]; },
  signMock(secret, paymentId, status) {
    return crypto.createHmac("sha256", secret).update(`${paymentId}.${status}`).digest("hex");
  },
};
