"use strict";

/**
 * Transport-agnostic notifier.
 *
 * `send()` is the only entry point every feature uses:

 *   await notify.send({ channel, to, templateKey, vars, clinicId });
 *
 * Callers must never build/send messages inline, so swapping the transport
 * (console → WhatsApp Cloud API → webhook → SMTP) is a one-place change and no
 * secret handling leaks into business logic. Providers are synchronous-in/async-out
 * and must never throw (send() catches anyway).
 *
 * Phase 3 registers the real providers (whatsapp-cloud / webhook / smtp) here.
 */

const providers = {
  console: require("./console"),
};

const DEFAULT_CHANNEL = process.env.NOTIFY_CHANNEL || "console";

function get(name) {
  return providers[name] || null;
}

async function send({ channel, to, templateKey, vars, clinicId } = {}) {
  const ch = channel || DEFAULT_CHANNEL;
  const provider = get(ch);
  if (!provider) {
    console.log(`[notify] no provider for channel "${ch}" (template=${templateKey || "-"}); skipping`);
    return { ok: false, provider: null, reason: "no-provider" };
  }
  try {
    const r = await provider.send({ to, templateKey, vars, clinicId });
    return r || { ok: true, provider: ch };
  } catch (e) {
    console.error(`[notify] provider "${ch}" failed:`, (e && e.message) || e);
    return { ok: false, provider: ch, reason: (e && e.message) || "error" };
  }
}

module.exports = { send, get, providers, DEFAULT_CHANNEL };
