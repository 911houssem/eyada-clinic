"use strict";

/**
 * Meta WhatsApp Cloud API provider (no dependencies — native fetch).
 *
 * config = { phoneNumberId, accessToken, apiVersion?, language?, templates?,
 *             apiBase? }
 * `apiBase` defaults to https://graph.facebook.com and exists so tests (and
 * locked-down networks) can point the provider at a mock / proxy. Only
 * template messages are sent (business-initiated messages must use approved
 * templates).
 */
module.exports = {
  name: "whatsapp-cloud",
  async send({ to, templateKey, vars = {}, config = {} }) {
    const phoneNumberId = config.phoneNumberId;
    const token = config.accessToken;
    if (!phoneNumberId || !token) throw new Error("whatsapp-cloud not configured");
    if (!to) throw new Error("whatsapp-cloud: missing recipient");

    const apiVersion = config.apiVersion || "v20.0";
    const tplDef = (config.templates && config.templates[templateKey]) || {};
    const name = tplDef.name || templateKey;
    const language = tplDef.language || config.language || "ar";

    // Approved templates expose {{1}}, {{2}} … placeholders; order them by key.
    const params = Object.keys(vars)
      .sort()
      .map((k) => ({ type: "text", text: String(vars[k] == null ? "" : vars[k]) }));

    const payload = {
      messaging_product: "whatsapp",
      to: String(to).replace(/[^\d+]/g, ""),
      type: "template",
      template: {
        name,
        language: { code: language },
        ...(params.length ? { components: [{ type: "body", parameters: params }] } : {}),
      },
    };

    const url = `${String(config.apiBase || "https://graph.facebook.com").replace(/\/+$/, "")}/${apiVersion}/${phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`whatsapp-cloud HTTP ${res.status}${text ? ": " + text.slice(0, 200) : ""}`);
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, provider: "whatsapp-cloud", id: data && data.messages && data.messages[0] && data.messages[0].id };
  },
};
