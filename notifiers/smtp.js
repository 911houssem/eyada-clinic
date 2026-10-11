"use strict";

/**
 * SMTP provider — INTERFACE ONLY.
 *
 * The project keeps "zero dependencies", and a correct SMTP client (TLS,
 * STARTTLS, auth) is far too much to hand-roll safely. Until a relay is wired
 * in, this provider refuses to pretend: it throws a clear, actionable error.
 *
 * To enable e-mail, expose a relay that speaks HTTP (use the `webhook` provider)
 * or add a reviewed dependency and implement send() here using config
 * { host, port, user, password, from }.
 */
module.exports = {
  name: "smtp",
  async send() {
    throw new Error("smtp provider is an interface only (zero-dependency build) — use a webhook relay");
  },
};
