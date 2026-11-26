/* Maison Setter command center — views part 4: Knowledge & script (the global company knowledge layer)
   and the AI builder (a chat that builds campaign pieces and applies them with one button). */
(() => {
"use strict";
const { h, ico, api, toast, badge, empty, field, campaignOptions, clientName, S, VIEWS, guard } = window.MS;
const $ = (s, r = (r && r) || document) => (r || document).querySelector(s);
const MS = window.MS;

/* ---------------------------------------------------------------- Knowledge & script */
/* Layer 2 of the knowledge stack: one global company knowledge base. The built-in appointment-setting
   playbook (layer 1) is always on underneath it, and each campaign's own knowledge (layer 3) sits on top. */
async function viewKnowledge(rootEl) {
  const box = h("div"); rootEl.append(box);
  const r = await api("GET", "/api/kb");
  const FIELDS = [
    ["overview", "Company overview", "What the company is, who it serves. The one-paragraph brief every AI reads before it writes a word."],
    ["faqs", "FAQs", "The questions leads actually ask, with the answers. Plain text, one question and answer after another."],
    ["pricing", "Pricing guidance", "What may be said about price, and what waits for the call. The AI never invents numbers: whatever is allowed to be said goes here."],
    ["objections", "Objection handling notes", "Your company's angles on the classic objections. The built-in playbook already handles the classics; this layer adds what only you know."],
    ["policies", "Policies", "Refunds, warranties, service areas, scheduling rules, anything binding."],
    ["proof", "Proof and results", "Real numbers, case studies, reviews, notable clients. Only what is true: this gets quoted in conversations."],
    ["script", "Script", "Your script, or the rough shape of what you want said. Rough notes are fine; the AI turns them into messages."],
    ["extra", "Extra notes", "Anything else the AI should know when it talks to leads."]
  ];
  const tas = {};
  const form = h("div", { class: "stack" });
  for (const [k, label, hint] of FIELDS) { const ta = h("textarea", { id: "kb" + k, rows: k === "script" || k === "faqs" ? 7 : 4 }); ta.value = r.global[k] || ""; tas[k] = ta; form.append(field("kb" + k, label, ta, hint)); }
  const msg = h("p", { class: "msg", role: "alert" }), save = h("button", { class: "btn primary", type: "button" }, ico("check"), "Save knowledge");
  save.onclick = guard(save, async () => {
    try { await api("PUT", "/api/kb", { kb: Object.fromEntries(Object.entries(tas).map(([k, ta]) => [k, ta.value])) });
      msg.className = "msg good"; msg.textContent = "Saved. Every conversation and every builder reads this now."; toast("Knowledge saved.", "good");
    } catch (e) { msg.className = "msg err"; msg.textContent = e.message; }
  });
  box.replaceChildren(
    h("div", { class: "page-head" }, h("div", null, h("h2", { text: "Knowledge & script" }),
      h("p", { text: "The global company knowledge. Paste docs, FAQs, pricing policy, proof, and a script or loose notes about what you want said. The AI uses it in every conversation and never invents facts." })),
      badge("Layer 2 of 3", "info", true)),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "How the layers stack" })),
      h("ol", { class: "small", style: "padding-left:1.2rem;display:grid;gap:.3rem" },
        h("li", null, h("b", { text: "1. Built-in playbook (always on)." }), " A pro appointment setter's rules: objection handling, two-option closes, acting human, when to walk away. Ships with the app."),
        h("li", null, h("b", { text: "2. This page (global)." }), " Your company's facts, pricing, proof and script. Every campaign reads it."),
        h("li", null, h("b", { text: "3. Per campaign (onboarding)." }), " The campaign's own knowledge, case studies and script sit on top with the most detail.")),
      h("p", { class: "hint", text: "Per-campaign detail lives in Onboarding, slide 'Business context & knowledge'. Whatever is filled there wins when it overlaps." })),
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Global knowledge" })), form, h("div", { class: "row" }, save), msg));
  return {};
}
VIEWS.knowledge = viewKnowledge;

/* ---------------------------------------------------------------- AI builder (chat) */
/* Talk it out; when the chat settles on something concrete, the AI returns a proposed patch and one
   button applies it through the same endpoints the forms use. Nothing is applied without a click. */
async function viewBuilder(rootEl) {
  const box = h("div"); rootEl.append(box);
  if (!S.clients.length) return box.append(empty("Create a campaign first", "The AI builder works on one campaign at a time.", h("a", { class: "btn primary", href: "#/campaigns", text: "Create a campaign" })));
  let clientId = S.clientId ? Number(S.clientId) : S.clients[0].id;
  const sel = h("select", { id: "bClient", "aria-label": "Campaign" }, campaignOptions(clientId, false));
  sel.onchange = () => { clientId = Number(sel.value); messages = []; log.replaceChildren(); pill.textContent = "Building: " + clientName(clientId); };
  const pill = h("span", { class: "muted small", text: "Building: " + clientName(clientId) });
  const log = h("div", { class: "chatlog stack" });
  const ta = h("textarea", { id: "bInput", rows: 2, placeholder: "Describe what you want. Example: rewrite my follow-ups for a roofing campaign in Tampa, 4 touches, super polite, escalate urgency by the end." });
  const send = h("button", { class: "btn primary", type: "button" }, ico("chat"), "Send");
  const CHIPS = [
    ["Basics", "Rewrite my campaign basics: "],
    ["Opener scripts", "Build me opener scripts that: "],
    ["Follow-up sequence", "Build my follow-up sequence: "],
    ["Warm-up plan", "Design a warm-up plan for: "],
    ["ICP", "Refine my ideal customer profile: "]
  ];
  const chips = h("div", { class: "row wrap" }, CHIPS.map(([label, pre]) => { const b = h("button", { class: "btn sm", type: "button", text: label }); b.onclick = () => { ta.value = pre; ta.focus(); }; return b; }));
  let messages = [];
  const addMsg = (role, text, extra) => {
    const el = h("div", { class: role === "user" ? "chat-me" : "chat-ai" }, h("b", { class: "small muted", text: role === "user" ? "You" : "AI" }), h("p", { text }), extra || null);
    log.append(el); el.scrollIntoView?.({ block: "nearest" }); return el;
  };
  const applyCard = (updates, note) => {
    const pre = h("pre", { class: "code", tabindex: "0", text: JSON.stringify(updates, null, 2) });
    const btn = h("button", { class: "btn good", type: "button" }, ico("check"), "Apply to campaign");
    btn.onclick = guard(btn, async () => {
      const patch = {};
      for (const k of ["offer", "target", "tone", "openerTemplate", "agencyOpenerTemplate"]) if (updates[k] !== undefined) patch[k] = updates[k];
      if (Array.isArray(updates.followups)) patch.followups = updates.followups;
      if (Object.keys(patch).length) await api("PATCH", `/api/clients/${clientId}`, patch);
      if (updates.warmupPlan) await api("POST", "/api/warmup/plans", { plan: updates.warmupPlan });
      if (updates.onboarding && typeof updates.onboarding === "object") await api("PUT", "/api/onboarding", { clientId, ...updates.onboarding });
      btn.replaceChildren(ico("check"), "Applied"); btn.disabled = true;
      toast("Applied to the campaign. Review it on the campaign or onboarding pages.", "good");
    });
    return h("div", { class: "stack", style: "margin:.5rem 0 0" }, h("p", { class: "small muted", text: "Proposed changes (nothing applied until you click):" }), pre, note ? h("p", { class: "small muted", text: note }) : null, btn);
  };
  const sendMsg = guard(send, async () => {
    const text = ta.value.trim(); if (!text) return;
    ta.value = ""; messages.push({ role: "user", text }); addMsg("user", text);
    const thinking = addMsg("ai", "Thinking…");
    try {
      const r = await api("POST", "/api/ai/chat", { clientId, messages });
      messages.push({ role: "assistant", text: r.reply });
      const extra = r.updates ? applyCard(r.updates, r.note) : null;
      thinking.replaceChildren(h("b", { class: "small muted", text: "AI" }), h("p", { text: r.reply }), extra || null);
    } catch (e) {
      thinking.replaceChildren(h("b", { class: "small muted", text: "AI" }), h("p", { class: "small", style: "color:var(--bad)", text: e.message }));
    }
  });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
  box.replaceChildren(
    h("div", { class: "page-head" }, h("div", null, h("h2", { text: "AI builder" }),
      h("p", { text: "Chat with the strategist brain. It reads the company brain and the knowledge layers, proposes concrete changes, and you apply them with one button. Every section also has a fill-the-form AI button: campaigns, openers, follow-ups and warm-up plans." })),
      h("div", { class: "actions" }, sel)),
    h("p", { class: "small muted", style: "margin:.2rem 0 .8rem", text: "" }, pill),
    chips,
    h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "The chat" })), log),
    h("div", { class: "row", style: "margin-top:.8rem" }, ta, send));
  return {};
}
VIEWS.builder = viewBuilder;
})();
