/* Claude Haiku client. No SDK: one fetch call. Everything it returns is treated as untrusted text.
   The bouncer uses Anthropic prompt caching on its static system prompt and temperature 0. */
const { BOUNCER_SYSTEM } = require("./bouncer-prompt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

/* Finds the first complete {...} object in a string, even inside prose or ```json fences. */
function extractJson(text) {
  const s = String(text || ""), start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return repairJson(s.slice(start, i + 1)); } }
  }
  return null;
}
/* Small repairs for the usual model slips: trailing commas, smart quotes around keys, single-quoted strings. */
function repairJson(raw) {
  try { return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/[\u201C\u201D]/g, '"')); } catch { /* next */ }
  try { return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/'([^'\\]*)'/g, '"$1"')); } catch { return null; }
}

const DECISIONS = ["PASS", "REJECT"];
const ENTITIES = ["REAL_SERVICE_BUSINESS", "MARKETING_AGENCY", "COURSE_CREATOR", "PERSONAL_OR_SPAM"];
const clip = (v, n) => { const s = v == null ? "" : String(v).replace(/\s+/g, " ").trim(); return s ? s.slice(0, n) : null; };

/* Turns whatever came back into the exact schema, or null if it cannot be trusted. */
function normalizeDecision(o, { allowAgencies = false } = {}) {
  if (!o || typeof o !== "object") return null;
  const decision = String(o.decision || "").toUpperCase().trim(), entity = String(o.entity_type || "").toUpperCase().trim();
  if (!DECISIONS.includes(decision) || !ENTITIES.includes(entity)) return null;
  let conf = Number(o.confidence_score); if (!Number.isFinite(conf)) return null;
  conf = Math.max(1, Math.min(100, Math.round(conf)));
  const out = { decision, confidence_score: conf, entity_type: entity, detected_niche: (clip(o.detected_niche, 60) || "unknown").toLowerCase(),
    service_location: clip(o.service_location, 80), disqualification_reason: clip(o.disqualification_reason, 200), personalization_hook: clip(o.personalization_hook, 140) };
  // Keep the answer consistent with the rules even if the model slipped.
  if (entity === "COURSE_CREATOR" || entity === "PERSONAL_OR_SPAM") out.decision = "REJECT";
  else if (entity === "MARKETING_AGENCY") out.decision = allowAgencies ? "PASS" : "REJECT";
  if (out.decision === "PASS" && conf < 50) out.decision = "REJECT";
  if (out.decision === "REJECT") { out.personalization_hook = null; out.disqualification_reason ||= { MARKETING_AGENCY: "Marketing agency, not an operating business.", COURSE_CREATOR: "Sells courses or coaching.", PERSONAL_OR_SPAM: "Personal or spam account." }[entity] || "Does not look like a real operating business."; }
  else { out.disqualification_reason = null; if (out.personalization_hook) out.personalization_hook = out.personalization_hook.replace(/^["'\s]+|["'.!\s]+$/g, "").replace(/^(Your|The)\b/, (w) => w.toLowerCase()); }
  return out;
}

function createHaiku(cfg, db) {
  const enabled = () => !!cfg.anthropicKey;
  const used = () => { const r = db.get("SELECT input_tokens + output_tokens AS t FROM usage WHERE day = ?", today()); return r ? r.t : 0; };
  const record = (u) => db.run(`INSERT INTO usage(day, input_tokens, output_tokens, calls, cache_read_tokens, cache_write_tokens) VALUES(?, ?, ?, 1, ?, ?)
    ON CONFLICT(day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens, calls = calls + 1,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
    today(), Number(u?.input_tokens) || 0, Number(u?.output_tokens) || 0, Number(u?.cache_read_input_tokens) || 0, Number(u?.cache_creation_input_tokens) || 0);

  /* cache: true marks the (static) system prompt for Anthropic's ephemeral prompt cache. */
  async function ask({ system, user, maxTokens = 400, cache = false, temperature }) {
    if (!enabled()) throw new Error("haiku_disabled");
    if (used() >= cfg.dailyTokenCap) throw new Error("haiku_budget");
    let lastErr = new Error("haiku_failed");
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const body = { model: cfg.haikuModel, max_tokens: maxTokens, messages: [{ role: "user", content: user }],   // user is a string, or an array of blocks when a screenshot is attached
          system: cache ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system };
        if (temperature !== undefined) body.temperature = temperature;
        const res = await fetch(`${cfg.anthropicBase}/v1/messages`, {
          method: "POST", signal: ctrl.signal,
          headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body)
        });
        if (res.status === 429 || res.status >= 500) { lastErr = new Error("haiku_http_" + res.status); await sleep(600 * 2 ** attempt); continue; }
        if (!res.ok) throw new Error("haiku_http_" + res.status);
        const data = await res.json();
        record(data.usage);
        return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      } catch (e) { lastErr = e.name === "AbortError" ? new Error("haiku_timeout") : e; if (!/haiku_http_(429|5)/.test(lastErr.message) && lastErr.message !== "haiku_timeout") throw lastErr; await sleep(600 * 2 ** attempt); }
      finally { clearTimeout(timer); }
    }
    throw lastErr;
  }
  async function askJson(args) {
    const obj = extractJson(await ask(args));
    if (!obj) throw new Error("haiku_bad_json");
    return obj;
  }

  /* The bouncer. Strict JSON at temperature 0, with one repair retry. Never throws on a malformed answer:
     it returns { ok: false, error } so the worker can park the lead for a person instead of crashing. */
  async function classify({ campaign, lead }) {
    const allowAgencies = !!campaign.allowAgencies;
    const user = `<campaign>\nallow_agencies: ${allowAgencies}\ntarget: ${campaign.target || "any real operating business that sells services"}\noffer: ${campaign.offer || ""}\n</campaign>\n<lead>\n${lead}\n</lead>`;
    let prior = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let text;
      try {
        text = await ask({ system: BOUNCER_SYSTEM, cache: true, temperature: 0, maxTokens: 350,
          user: attempt === 0 ? user : `${user}\n\nYour previous reply was not valid JSON in the required schema:\n${prior.slice(0, 1200)}\nReply again with ONLY the JSON object, exactly those seven keys.` });
      } catch (e) { return { ok: false, error: e.message }; }
      const parsed = normalizeDecision(extractJson(text), { allowAgencies });
      if (parsed) return { ok: true, decision: parsed, retried: attempt > 0 };
      prior = text;
    }
    return { ok: false, error: "haiku_bad_json" };
  }

  const status = () => {
    const u = db.get("SELECT calls, input_tokens AS i, cache_read_tokens AS r, cache_write_tokens AS w FROM usage WHERE day = ?", today()) || { calls: 0, i: 0, r: 0, w: 0 };
    const allIn = u.i + u.r + u.w;
    return { configured: enabled(), model: cfg.haikuModel, usedToday: used(), dailyCap: cfg.dailyTokenCap, calls: u.calls,
      cacheReadTokens: u.r, cacheWriteTokens: u.w, cacheHitRate: allIn ? Math.round((u.r / allIn) * 100) : 0 };
  };
  return { enabled, ask, askJson, classify, status };
}
module.exports = { createHaiku, extractJson, normalizeDecision, ENTITIES, DECISIONS };
