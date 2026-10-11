"use strict";

/**
 * Development/default provider. Never fails, prints a single structured line to
 * the operational log. In production a real channel should be configured (see
 * notifiers/index.js); this provider deliberately never contains secrets.
 */
module.exports = {
  name: "console",
  send({ to, templateKey, vars, clinicId }) {
    let varsStr;
    try { varsStr = JSON.stringify(vars || {}); } catch { varsStr = "{}"; }
    console.log(
      `[notify:console] to=${to || "-"} template=${templateKey || "-"} ` +
      `clinic=${clinicId || "-"} vars=${varsStr}`
    );
    return { ok: true, provider: "console" };
  },
};
