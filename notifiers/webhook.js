"use strict";

/**
 * Generic outbound webhook provider. POSTs a JSON envelope to a URL and signs
 * the raw body with HMAC-SHA256 (header `X-Eyada-Signature: sha256=<hex>`) when
 * a secret is configured, so the receiver can verify authenticity.
 *
 * config = { url, secret?, headers? }
 */
const crypto = require("crypto");

module.exports = {
  name: "webhook",
  async send({ to, templateKey, vars = {}, clinicId, config = {} }) {
    if (!config.url) throw new Error("webhook not configured");
    const body = JSON.stringify({
      templateKey, to: to || null, clinicId: clinicId || null, vars,
      sentAt: new Date().toISOString(),
    });
    const headers = { "Content-Type": "application/json", ...(config.headers || {}) };
    if (config.secret) {
      headers["X-Eyada-Signature"] = "sha256=" + crypto.createHmac("sha256", config.secret).update(body).digest("hex");
    }
    const res = await fetch(config.url, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
    return { ok: true, provider: "webhook" };
  },
};
