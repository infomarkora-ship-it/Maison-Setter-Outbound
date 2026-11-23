/* End-to-end tests: real HTTP server, in-memory database, fake Anthropic API, fake website. */
const http = require("node:http");
const { createApp } = require("../src/server");
const { fetchPage, isPrivateIp, outboundLinks } = require("../src/enrich");
const rules = require("../src/rules");

let bad = 0, total = 0;
const eq = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); };
const yes = (name, v) => eq(name, !!v, true);
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); });
const MIN = 60_000, DAYMS = 86_400_000;

(async () => {
  /* ---- fakes ---- */
  const claudeCalls = [], seen = {};
  const claude = await listen((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const b = JSON.parse(raw), user = b.messages[0].content, sys = Array.isArray(b.system) ? b.system.map((x) => x.text).join("") : String(b.system);
      claudeCalls.push({ key: req.headers["x-api-key"], model: b.model, sysIsBlocks: Array.isArray(b.system), cache: Array.isArray(b.system) && b.system[0].cache_control, temperature: b.temperature, user, sys });
      let text;
      if (/bouncer for an Instagram outreach team/.test(sys)) {
        const u = (/username: @(\S+)/.exec(user) || [])[1] || "", allow = /allow_agencies: true/.test(user);
        seen[u] = (seen[u] || 0) + 1;
        const J = (o) => JSON.stringify({ disqualification_reason: null, personalization_hook: null, service_location: null, ...o });
        if (u === "retry_roofer") text = seen[u] === 1 ? "I think this one looks fine to me!" : J({ decision: "PASS", confidence_score: 88, entity_type: "REAL_SERVICE_BUSINESS", detected_niche: "roofing", personalization_hook: "your roof repairs" });
        else if (u === "junk_json") text = "no json here, sorry";
        else if (/Attention Concrete/.test(user)) text = J({ decision: allow ? "PASS" : "REJECT", confidence_score: 95, entity_type: "MARKETING_AGENCY", detected_niche: "lead generation for contractors", disqualification_reason: allow ? null : "Sells lead generation to contractors.", personalization_hook: allow ? "your lead generation work for concrete contractors" : null });
        else if (/course_guy/.test(u)) text = "```json\n" + J({ decision: "REJECT", confidence_score: 91, entity_type: "COURSE_CREATOR", detected_niche: "coaching", disqualification_reason: "Sells coaching." }) + "\n```";
        else if (/plumb/.test(u)) text = J({ decision: "PASS", confidence_score: 74, entity_type: "REAL_SERVICE_BUSINESS", detected_niche: "plumbing", service_location: "Dallas, TX", personalization_hook: "Your emergency plumbing work in Dallas." });
        else text = J({ decision: "PASS", confidence_score: 96, entity_type: "REAL_SERVICE_BUSINESS", detected_niche: "roofing", service_location: "Austin, TX", personalization_hook: "your stamped concrete patio work in Austin" });
      } else if (/first Instagram DM/.test(sys)) text = JSON.stringify({ opener: "Loved your recent roof post! https://spam.example/x" });
      else if (/draft the next Instagram DM reply/.test(sys)) {
        const last = ([...user.matchAll(/THEM: ([^\n]*)/g)].pop() || [])[1] || "";
        if (/bot|real person/i.test(last)) text = JSON.stringify({ intent: "question", reply: "Yes, a real person here.", handoff: true });
        else if (/stop/i.test(last)) text = JSON.stringify({ intent: "stop", reply: "", handoff: false });
        else if (/how much/i.test(last)) text = JSON.stringify({ intent: "question", reply: "It depends on the job. Want a quick call? https://book.example/call or https://evil.example/phish", handoff: false });
        else text = JSON.stringify({ intent: "interested", reply: "Great! Want to grab a time?", handoff: false });
      } else text = "{}";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 40, output_tokens: 30, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } }));
    });
  });
  const site = await listen((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>Joe's Roofing</title><a href="mailto:joe@joesroofing.com">mail</a> Call (512) 555-0134`); });
  const sitePort = site.address().port;

  const app = createApp({ dbPath: ":memory:", adminPassword: "hunter2-pass", anthropicKey: "test-key", anthropicBase: `http://127.0.0.1:${claude.address().port}`, allowPrivateFetch: true, logger: { error() {} } });
  const port = await app.listen(0), U = `http://127.0.0.1:${port}`;
  const { db, ctx } = app;
  let cookie = "";
  const call = async (method, path, { body, token, headers = {} } = {}) => {
    const h = { ...(body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}), ...headers };
    if (cookie) h.cookie = cookie; if (token) h.authorization = "Bearer " + token;
    const r = await fetch(U + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const api = (m, p, b) => call(m, p, { body: b }), ext = (m, p, token, b) => call(m, p, { token, body: b });
  db.setSetting("default_window", { start: 0, end: 24 });

  /* ---- A. auth ---- */
  eq("A dashboard needs sign-in", (await api("GET", "/api/clients")).status, 401);
  eq("A the live stream needs sign-in", (await fetch(U + "/api/stream")).status, 401);
  eq("A a wrong password", (await api("POST", "/api/login", { password: "nope" })).status, 401);
  const login = await api("POST", "/api/login", { password: "hunter2-pass" });
  eq("A a right password", login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  yes("A cookie is HttpOnly + SameSite", /HttpOnly/.test(login.headers.get("set-cookie")) && /SameSite=Strict/.test(login.headers.get("set-cookie")));
  eq("A form posts are refused (CSRF)", (await fetch(U + "/api/clients", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" })).status, 415);
  eq("A extension without a token", (await ext("GET", "/ext/config")).status, 401);
  eq("A extension with a bad token", (await ext("GET", "/ext/config", "acc_nope")).status, 401);
  eq("A import hook without the key", (await call("POST", "/hooks/import", { body: [] })).status, 401);
  yes("A security headers", (await fetch(U + "/health")).headers.get("content-security-policy").includes("default-src 'self'"));

  /* ---- B. setup ---- */
  const c1 = (await api("POST", "/api/clients", { name: "Acme Roofing", offer: "Free roof inspections and fair quotes.", target: "Local roofers and contractors", bookingLink: "https://book.example/call", sendStart: 0, sendEnd: 24, tz: "America/Toronto", excludeWords: "franchise\nfree guide" })).body;
  const c2 = (await api("POST", "/api/clients", { name: "Pipes Co", offer: "Plumbing repair", sendStart: 0, sendEnd: 24 })).body;
  eq("B campaign defaults: agencies off, touch on, strict contact gate", [c1.allowAgencies, c1.preDmTouch, c1.requireContact, c1.minFollowers, c1.maxFollowers, c1.activeWithinDays], [false, true, true, 150, 100000, 30]);
  eq("B exclude words stored", c1.excludeWords, ["franchise", "free guide"]);
  eq("B bad time zone refused", (await api("POST", "/api/clients", { name: "x", tz: "Mars/Base" })).status, 400);
  eq("B bad booking link refused", (await api("PATCH", `/api/clients/${c1.id}`, { bookingLink: "javascript:alert(1)" })).status, 400);
  eq("B finder accounts no longer exist", (await api("POST", "/api/accounts", { kind: "finder", igUsername: "old_finder" })).status, 400);
  const s1 = (await api("POST", "/api/accounts", { label: "Acme sender 1", igUsername: "acme_one", clientId: c1.id, igAge: "established" })).body;
  const s2 = (await api("POST", "/api/accounts", { label: "Acme sender 2", igUsername: "acme_two", clientId: c1.id, igAge: "established" })).body;
  eq("B sender needs a campaign", (await api("POST", "/api/accounts", { igUsername: "nobody" })).status, 400);
  eq("B the same account cannot be added twice", (await api("POST", "/api/accounts", { igUsername: "acme_one", clientId: c1.id })).status, 409);
  const decode = (code) => JSON.parse(Buffer.from(code.slice(4), "base64url").toString());
  const T1 = decode(s1.pairingCode).t, T2 = decode(s2.pairingCode).t;
  eq("B pairing code format", [s1.pairingCode.startsWith("me1."), decode(s1.pairingCode).m, decode(s1.pairingCode).s], [true, "sender", U]);
  db.run("UPDATE accounts SET warm_started_at = ?", Date.now() - 30 * DAYMS);
  eq("B account summary has role, badge and counters", (({ role, badge, sentToday, capToday }) => ({ role, badge, sentToday, capToday }))((await api("GET", "/api/accounts")).body.accounts[0]), { role: "sender", badge: "active", sentToday: 0, capToday: 20 });

  /* ---- C. pre-filter on import ---- */
  const now = Date.now(), iso = (d) => new Date(now - d * DAYMS).toISOString();
  const prof = (o) => ({ username: "x", fullName: "Joe Smith", biography: "Licensed & insured roofing in Austin, TX. Free estimate (512) 555-0134", followersCount: 900, followsCount: 100, postsCount: 40, private: false,
    businessCategoryName: "Roofing Service", externalUrl: `http://127.0.0.1:${sitePort}/`, latestPosts: [{ caption: "New roof today", timestamp: iso(2) }], ...o });
  const records = [
    prof({ username: "Joes_Roofing" }),
    prof({ username: "private_biz", private: true }),
    prof({ username: "coach_guy", businessCategoryName: "Coach" }),
    prof({ username: "tiny_biz", followersCount: 40 }),
    prof({ username: "huge_biz", followersCount: 900000 }),
    prof({ username: "stale_biz", latestPosts: [{ caption: "old", timestamp: iso(90) }] }),
    prof({ username: "zero_posts", postsCount: 0, latestPosts: [] }),
    prof({ username: "skool_link", externalUrl: "https://www.skool.com/abc" }),
    prof({ username: "bait_bio", biography: "DM me the word GROW and I will send it" }),
    prof({ username: "no_contact", biography: "Roofing", externalUrl: "", businessCategoryName: "Roofing Service" }),
    prof({ username: "franchise_one", biography: "Franchise roofing owner (512) 555-0134" }),
    prof({ username: "course_guy", biography: "Roofing mentor (512) 555-0134", businessCategoryName: "Local Business" }),
    prof({ username: "retry_roofer" }), prof({ username: "junk_json" }),
    prof({ username: "plumb_dallas", biography: "Plumbing Dallas, TX (214) 555-0100", businessCategoryName: "Contractor" }),
    { ig_username: "bait_agency", page_name: "Pro Crew Growth", ad_copy: "Attention Concrete Contractors! We fill your calendar.", ad_landing_url: "https://go.proagency.com/x", niche: "concrete" },
    { not: "a record" }, prof({ username: "acme_one" })
  ];
  const imp = (await api("POST", "/api/leads/import", { clientId: c1.id, records: [...records, prof({ username: "joes_roofing" })] })).body;
  eq("C import counts", [imp.received, imp.queued, imp.duplicates, imp.invalid, imp.skipped], [19, 16, 1, 1, 1]);
  await app.jobs.drain();
  const L = (u) => { const r = db.get("SELECT id FROM leads WHERE username = ? AND client_id = ?", u, c1.id); return r && ctx.leads.leadOut(ctx.leads.get(r.id)); };
  const why = (u) => [L(u).review, L(u).entityClassification, L(u).gate, L(u).disqualificationReason];
  eq("C private account filtered", why("private_biz"), ["rejected", "REJECT", "rejected", "Private account"]);
  eq("C creator label filtered", why("coach_guy")[3], "Creator or guru category: Coach");
  eq("C under 150 followers filtered", why("tiny_biz")[3], "Under 150 followers");
  eq("C over 100,000 followers filtered", why("huge_biz")[3], "Over 100,000 followers");
  eq("C no post in 30 days filtered", why("stale_biz")[3], "No post in the last 30 days");
  eq("C zero posts filtered", why("zero_posts")[3], "Zero posts");
  eq("C course platform link filtered", why("skool_link")[3], "Links to a course platform: skool.com");
  yes("C engagement bait filtered", /Marketer or engagement-bait/.test(why("bait_bio")[3]));
  eq("C no link, phone or email filtered", why("no_contact")[3], "No bio link, phone number or email");
  eq("C the campaign's own rule-out words work", why("franchise_one")[3], "Excluded word: franchise");
  eq("C none of those reached Haiku", claudeCalls.filter((c) => /private_biz|coach_guy|tiny_biz|huge_biz|stale_biz|zero_posts|skool_link|bait_bio|no_contact|franchise_one/.test(c.user)).length, 0);
  eq("C our own account is skipped, duplicates are dropped", [db.get("SELECT COUNT(*) AS n FROM leads WHERE username = 'acme_one'").n, db.get("SELECT COUNT(*) AS n FROM leads WHERE username = 'joes_roofing'").n], [0, 1]);
  const joe = L("joes_roofing");
  eq("C a good lead keeps its quality points, boost and contact", [joe.priorityBoost, joe.qualityPoints >= 60, joe.contact.phones.length > 0, joe.enrichStatus], [1, true, true, "done"]);

  /* ---- D. the bouncer ---- */
  yes("D Haiku was called with a cached system block, temperature 0 and the Haiku model", claudeCalls.length >= 5 && claudeCalls.every((c) => c.sysIsBlocks && c.cache && c.cache.type === "ephemeral" && c.temperature === 0 && c.model === "claude-haiku-5-5" && c.key === "test-key"));
  yes("D the cached prompt is identical on every call", new Set(claudeCalls.map((c) => c.sys)).size === 1);
  yes("D untrusted text is fenced and the prompt says to ignore it", claudeCalls[0].user.includes("<lead>") && claudeCalls[0].sys.includes("untrusted"));
  eq("D a real business passes with the exact schema fields", [joe.review, joe.entityClassification, joe.entityType, joe.confidence, joe.detectedNiche, joe.serviceLocation, joe.disqualificationReason], ["pending", "REAL_BUSINESS", "REAL_SERVICE_BUSINESS", 96, "roofing", "Austin, TX", ""]);
  eq("D the hook is stored lowercase-ready", joe.personalizationHook, "your stamped concrete patio work in Austin");
  eq("D opener is built from the hook with no second API call", [joe.opener, claudeCalls.filter((c) => /first Instagram DM/.test(c.sys)).length], ["Hey there! Came across your page and love your stamped concrete patio work in Austin. Are you open to new customers right now?", 0]);
  eq("D a malformed answer is retried once and then accepted", [L("retry_roofer").entityClassification, seen.retry_roofer], ["REAL_BUSINESS", 2]);
  eq("D an answer that never parses parks the lead for a person and does not crash", [L("junk_json").review, L("junk_json").haiku.status, L("junk_json").entityClassification, seen.junk_json], ["pending", "failed", "", 2]);
  eq("D fenced JSON is read; a course seller is rejected", why("course_guy").slice(0, 2), ["rejected", "REJECT"]);
  eq("D the agency ad is rejected by default and typed as an agency", [L("bait_agency").review, L("bait_agency").entityType, L("bait_agency").sourceType, L("bait_agency").entityClassification], ["rejected", "MARKETING_AGENCY", "meta_ad_library", "REJECT"]);
  eq("D ad records keep their ad metadata", [L("bait_agency").pageName, L("bait_agency").adLandingUrl, L("bait_agency").profileData], ["Pro Crew Growth", "https://go.proagency.com/x", false]);
  eq("D a low-confidence pass is still a pass, stripped of trailing punctuation", [L("plumb_dallas").personalizationHook, L("plumb_dallas").confidence], ["your emergency plumbing work in Dallas", 74]);
  const st = (await api("GET", "/api/quality?days=7")).body;
  yes("D quality breakdown adds up", st.imported === 16 && st.real >= 3 && st.spam >= 10 && st.gateRejected === 10 && st.reasons.length > 0 && st.reasons[0].count >= 1);
  eq("D usage counts cache reads so you can check the savings", app.ctx.haiku.status().cacheReadTokens > 0, true);

  /* ---- E. agencies toggle ---- */
  await api("PATCH", `/api/clients/${c1.id}`, { allowAgencies: true });
  await api("POST", `/api/leads/${L("bait_agency").id}/requalify`, {}); await app.jobs.drain();
  eq("E with agencies allowed the same ad goes to the agency bucket", [L("bait_agency").review, L("bait_agency").entityClassification], ["pending", "AGENCY"]);
  eq("E the agency lead has its own opener script", L("bait_agency").opener, "Hey there! Came across your lead generation work for concrete contractors. Would you be open to swapping notes on how you bring in new clients?");
  eq("E the agency bucket is listed separately", (await api("GET", `/api/leads?bucket=agency&clientId=${c1.id}`)).body.leads.map((l) => l.username), ["bait_agency"]);
  await api("PATCH", `/api/clients/${c1.id}`, { allowAgencies: false });

  /* ---- F. review, import-ads, hook ---- */
  const pend = (await api("GET", `/api/leads?review=pending&clientId=${c1.id}`)).body.leads.map((l) => l.username);
  eq("F pending list: boosted and most confident first", pend[0], "joes_roofing");
  const ads = (await api("POST", "/api/leads/import-ads", { clientId: c1.id, records: [{ ig_username: "ad_roofer", page_name: "Ad Roofer LLC", ad_copy: "Roof leaking? Free inspection in Austin. Call (512) 555-0111", ad_landing_url: "https://adroofer.com/book", niche: "roofing" }, { ig_username: "ad_roofer" }] })).body;
  await app.jobs.drain();
  eq("F import-ads forces the Ad Library source and de-duplicates by username", [ads.queued, ads.duplicates, L("ad_roofer").sourceType, L("ad_roofer").adStartDate, L("ad_roofer").entityClassification], [1, 1, "meta_ad_library", "", "REAL_BUSINESS"]);
  const key = (await api("GET", "/api/settings")).body.importKey;
  eq("F the hook takes records with the key", (await call("POST", `/hooks/import?campaignId=${c2.id}`, { headers: { "x-import-key": key }, body: [prof({ username: "hooked_plumber", biography: "Plumbing (214) 555-0100" })] })).body.queued, 1);
  await app.jobs.drain();
  eq("F hooked lead landed in the right campaign", db.get("SELECT client_id FROM leads WHERE username = 'hooked_plumber'").client_id, c2.id);
  eq("F a wrong key is refused", (await call("POST", "/hooks/import", { headers: { "x-import-key": "nope" }, body: [] })).status, 401);

  /* ---- G. approve, warm-touch, sending, role and lock ---- */
  const ap = (await api("POST", `/api/leads/${joe.id}/approve`, {})).body.lead;
  eq("G approved", [ap.review, ap.stage, ap.clientId], ["approved", "new", c1.id]);
  eq("G a second client cannot take a claimed business", (await ext("POST", "/hooks/none", null, {})).status === 404 && db.get("SELECT client_id FROM claims WHERE username = 'joes_roofing'").client_id, c1.id);
  const dm0 = db.get("SELECT * FROM tasks WHERE lead_id = ? AND type = 'dm'", joe.id);
  eq("G the opener task is not pinned yet", dm0.account_id, null);
  const first = (await ext("GET", "/ext/tasks/next", T1)).body;
  eq("G the first thing handed out is a warm-touch, not the opener", [first.task.type, first.task.username], ["touch", "joes_roofing"]);
  const dm1 = db.get("SELECT * FROM tasks WHERE id = ?", dm0.id);
  const gap = (dm1.not_before - Date.now()) / MIN;
  eq("G the opener is pinned to that sender and held 10 to 30 minutes", [dm1.account_id, gap > 9.5 && gap <= 30.5], [s1.account.id, true]);
  eq("G the other sender is never handed the same business", (await ext("GET", "/ext/tasks/next", T2)).body.task, null);
  eq("G the touch result is accepted", (await ext("POST", "/ext/tasks/result", T1, { id: first.task.id, ok: true, code: "sent", detail: "liked a post" })).body.ok, true);
  const dm2 = db.get("SELECT * FROM tasks WHERE id = ?", dm0.id), gap2 = (dm2.not_before - Date.now()) / MIN;
  yes("G after the touch the opener waits another 10 to 30 minutes", gap2 > 9.5 && gap2 <= 30.5);
  eq("G the opener is not handed out early", (await ext("GET", "/ext/tasks/next", T1)).body.task, null);
  db.run("UPDATE tasks SET not_before = 0 WHERE id = ?", dm0.id);
  const sendT = (await ext("GET", "/ext/tasks/next", T1)).body;
  eq("G then the opener goes out", [sendT.task.type, sendT.task.text === ap.opener], ["dm", true]);
  eq("G the ownership check passes for the owner and fails for the other sender", [(await ext("GET", `/ext/config?task=${dm0.id}`, T1)).body.taskOk, (await ext("GET", `/ext/config?task=${dm0.id}`, T2)).body.taskOk], [true, false]);
  eq("G the other sender cannot report it", (await ext("POST", "/ext/tasks/result", T2, { id: dm0.id, ok: true, code: "sent" })).status, 403);
  eq("G sent", (await ext("POST", "/ext/tasks/result", T1, { id: dm0.id, ok: true, code: "sent" })).body.ok, true);
  eq("G sent counter and lead stage", [(await ext("GET", "/ext/config", T1)).body.sentToday, L("joes_roofing").stage, L("joes_roofing").senderAccountId], [1, "contacted", s1.account.id]);
  eq("G a touch never counts as a sent message", db.get("SELECT COUNT(*) AS n FROM tasks WHERE type = 'touch' AND result_code = 'sent'").n, 1);
  db.run("UPDATE accounts SET kind = 'finder' WHERE id = ?", s2.account.id);
  eq("G an account marked as a finder is never given work and cannot report", [(await ext("GET", "/ext/tasks/next", T2)).body.task, (await ext("POST", "/ext/tasks/result", T2, { id: 1, ok: true })).status], [null, 403]);
  db.run("UPDATE accounts SET kind = 'sender' WHERE id = ?", s2.account.id);
  eq("G the unique index also locks by Instagram id", (() => { try { db.run("INSERT INTO leads(client_id, username, instagram_user_id, found_at, created_at, updated_at) VALUES(?,?,?,?,?,?)", c1.id, "dupe_a", "777", 1, 1, 1); db.run("INSERT INTO leads(client_id, username, instagram_user_id, found_at, created_at, updated_at) VALUES(?,?,?,?,?,?)", c1.id, "dupe_b", "777", 1, 1, 1); return "allowed"; } catch (e) { return /UNIQUE/.test(e.message) ? "blocked" : e.message; } })(), "blocked");

  /* ---- H. quarantine, reassignment, live endpoints ---- */
  await api("POST", `/api/leads/${L("retry_roofer").id}/approve`, {}); await api("POST", `/api/leads/${L("plumb_dallas").id}/approve`, {});
  db.run("UPDATE tasks SET done_at = ? WHERE type = 'dm' AND status = 'done'", Date.now() - 20 * MIN);
  const touchA = (await ext("GET", "/ext/tasks/next", T1)).body;
  eq("H sender 1 starts on the next lead with a touch", touchA.task.type, "touch");
  const pinned = db.get("SELECT account_id, lead_id FROM tasks WHERE type = 'dm' AND status = 'pending' AND account_id = ?", s1.account.id);
  yes("H its opener is pinned to sender 1", pinned && pinned.account_id === s1.account.id);
  const q = (await ext("POST", "/ext/quarantine", T1, { trigger: "automation_warning", url: "https://www.instagram.com/direct/inbox/" })).body;
  eq("H the extension's alert quarantines the account for 48 hours", [q.ok, q.quarantined, q.until > Date.now() + 47 * 60 * MIN && q.until < Date.now() + 49 * 60 * MIN], [true, true, true]);
  eq("H its queued opener moved to the healthy sender", [q.moved, db.get("SELECT account_id FROM tasks WHERE lead_id = ? AND type = 'dm'", pinned.lead_id).account_id, db.get("SELECT sender_account_id FROM leads WHERE id = ?", pinned.lead_id).sender_account_id], [1, s2.account.id, s2.account.id]);
  eq("H a repeated alert does nothing twice", (await ext("POST", "/ext/quarantine", T1, { trigger: "rate_limit" })).body.already, true);
  const sa = (await api("GET", "/api/accounts")).body.accounts.find((a) => a.id === s1.account.id);
  eq("H dashboard shows it as quarantined", [sa.badge, sa.state, sa.needsReset], ["quarantined", "quarantined", false]);
  eq("H a quarantined account is handed nothing", (await ext("GET", "/ext/tasks/next", T1)).body.task, null);
  eq("H the other sender takes over, with its own touch first", (await ext("GET", "/ext/tasks/next", T2)).body.task.type, "touch");
  db.run("UPDATE accounts SET cooldown_until = ? WHERE id = ?", Date.now() - 1000, s1.account.id);
  eq("H a rate-limit quarantine lifts by itself after 48 hours", (await ext("GET", "/ext/config", T1)).body.state, "active");
  await ext("POST", "/ext/quarantine", T1, { trigger: "checkpoint" });
  db.run("UPDATE accounts SET cooldown_until = ? WHERE id = ?", Date.now() - 1000, s1.account.id);
  eq("H a security check stays quarantined until a person releases it", (await ext("GET", "/ext/config", T1)).body.state, "quarantined");
  eq("H release from the dashboard", [(await api("POST", `/api/accounts/${s1.account.id}/release`)).body.account.badge, (await ext("GET", "/ext/config", T1)).body.state], ["active", "active"]);
  const qd = (await api("POST", `/api/accounts/${s2.account.id}/quarantine`, { reason: "testing" })).body;
  eq("H the dashboard endpoint quarantines too", [qd.account.badge, qd.account.reason.includes("48 hours")], ["quarantined", true]);
  await api("POST", `/api/accounts/${s2.account.id}/release`);
  await ext("POST", "/ext/event", T1, { kind: "action_blocked" });
  eq("H the old event path quarantines as well", (await ext("GET", "/ext/config", T1)).body.state, "quarantined");
  await api("POST", `/api/accounts/${s1.account.id}/release`);
  eq("H bad event refused", (await ext("POST", "/ext/event", T1, { kind: "nope" })).status, 400);
  await ext("POST", "/ext/log", T1, { lines: [{ text: "Warm-up done", level: "good" }] });
  yes("H extension log lines show up in the activity feed", (await api("GET", "/api/activity")).body.activity.some((a) => /Warm-up done/.test(a.text) && a.account === "Acme sender 1"));

  /* pulse: answers at once if the revision moved, waits otherwise, wakes on a dashboard action */
  const p0 = (await ext("GET", "/ext/pulse?rev=-1&wait=1000", T1)).body;
  eq("H pulse answers immediately when the extension is behind", p0.changed, true);
  const t0 = Date.now(); const idle = (await ext("GET", `/ext/pulse?rev=${p0.rev}&wait=300`, T1)).body;
  eq("H pulse waits when nothing changed", [idle.changed, Date.now() - t0 >= 250], [false, true]);
  const waiting = ext("GET", `/ext/pulse?rev=${idle.rev}&wait=8000`, T1); const t1 = Date.now();
  setTimeout(() => api("PATCH", `/api/accounts/${s1.account.id}`, { action: "pause" }), 150);
  const woke = (await waiting).body;
  eq("H a pause from the dashboard wakes the extension within a second", [woke.changed, woke.state, Date.now() - t1 < 2000], [true, "paused", true]);
  await api("PATCH", `/api/accounts/${s1.account.id}`, { action: "resume" });

  /* live dashboard stream */
  const sres = await fetch(U + "/api/stream", { headers: { cookie } });
  eq("H the dashboard stream opens as server-sent events", [sres.status, sres.headers.get("content-type").startsWith("text/event-stream")], [200, true]);
  const reader = sres.body.getReader(); let got = "";
  const readSome = async (ms) => { const end = Date.now() + ms; while (Date.now() < end && !/"t":"lead"/.test(got)) { const r = await Promise.race([reader.read(), new Promise((x) => setTimeout(() => x(null), 200))]); if (r && r.value) got += Buffer.from(r.value).toString(); } };
  await api("POST", `/api/leads/${L("junk_json").id}/reject`, { reason: "Not a fit" }); await readSome(2000);
  yes("H lead changes are pushed to open dashboards", /"t":"hello"/.test(got) && /"t":"lead"/.test(got));
  await reader.cancel();

  /* ---- I. follow-ups, inbox, replies (unchanged behaviour) ---- */
  db.run("UPDATE leads SET next_follow_at = ? WHERE id = ?", Date.now() - 1000, joe.id);
  app.maintain();
  eq("I no follow-up until the conversation has been seen in the inbox", db.get("SELECT COUNT(*) AS n FROM tasks WHERE type = 'followup'").n, 0);
  const TH = (msgs) => [{ igThreadId: "T-100", username: "Joes_Roofing", messages: msgs }];
  eq("I inbox sync with only our own message", (await ext("POST", "/ext/inbox/sync", T1, { threads: TH([{ from: "me", text: ap.opener, ts: Math.floor(Date.now() / 1000) - 600 }]) })).body, { newInbound: 0 });
  app.maintain();
  const fu = db.get("SELECT * FROM tasks WHERE type = 'followup'");
  yes("I follow-up booked with the template filled in", fu && fu.text.startsWith("Hey there,"));
  db.run("UPDATE messages SET ts = ts - 900 WHERE direction = 'out'");
  const nowS = Math.floor(Date.now() / 1000) - 5;
  const incoming = async (text, ts) => (await ext("POST", "/ext/inbox/sync", T1, { threads: TH([{ from: "me", text: ap.opener, ts: nowS - 600 }, { from: "them", text, ts }]) })).body;
  eq("I a reply is counted once", await incoming("how much is it?", nowS - 30), { newInbound: 1 });
  await app.jobs.drain();
  const dr = db.get("SELECT * FROM tasks WHERE type = 'reply' ORDER BY id DESC");
  eq("I draft waits for approval by default", [dr.status, L("joes_roofing").stage, L("joes_roofing").needsHuman], ["draft", "replied", true]);
  yes("I the booking link is kept, other links are stripped", dr.text.includes("https://book.example/call") && !dr.text.includes("evil.example"));
  eq("I approve with an edit", (await api("POST", `/api/tasks/${dr.id}/approve`, { text: "Depends on the roof! Can I call you tomorrow?" })).status, 200);
  await incoming("please stop messaging me", nowS - 5); await app.jobs.drain();
  eq("I asking to stop ends contact", [L("joes_roofing").stage, db.get("SELECT COUNT(*) AS n FROM tasks WHERE lead_id = ? AND status IN ('pending','draft')", joe.id).n], ["do_not_contact", 0]);

  /* ---- J. overview and settings ---- */
  const ov = (await api("GET", "/api/overview")).body;
  yes("J overview has digest, quality, accounts, alerts, activity", ov.digest && ov.quality && ov.accounts.length === 2 && Array.isArray(ov.alerts) && ov.activity.length > 0 && ov.haiku.configured);
  eq("J exclusive claims can be switched off", (await api("PUT", "/api/settings", { exclusiveClaims: false })).status, 200);
  const rep = (await call("GET", `/api/report?clientId=${c1.id}&days=7`)).body;
  yes("J report is readable text", typeof rep === "string" && rep.includes("Acme Roofing") && rep.includes("Real businesses"));
  const rot = (await api("POST", `/api/accounts/${s1.account.id}/rotate`)).body;
  eq("J rotating a token locks out the old one", [(await ext("GET", "/ext/config", T1)).status, (await ext("GET", "/ext/config", decode(rot.pairingCode).t)).status], [401, 200]);
  eq("J a campaign with data cannot be deleted", (await api("DELETE", `/api/clients/${c1.id}`)).status, 409);

  /* ---- J2. runner, supervisor and follows (no browser needed) ---- */
  const rt = (await api("GET", "/api/runner")).body;
  eq("the runner page has a token and shows it offline", [rt.token.startsWith("runner_"), rt.online, rt.accounts], [true, false, []]);
  eq("the runner API refuses a missing or wrong token", [(await call("GET", "/runner/accounts")).status, (await call("GET", "/runner/accounts", { headers: { authorization: "Bearer nope" } })).status], [401, 401]);
  const RH = { authorization: "Bearer " + rt.token };
  eq("the runner can list accounts, none are switched to it yet", (await call("GET", "/runner/accounts", { headers: RH })).body.accounts, []);
  eq("an account that still uses the extension can't be driven through the runner", (await call("GET", `/runner/a/${s1.account.id}/config`, { headers: RH })).status, 409);
  eq("switching to the runner needs a Dolphin profile first, and the ID is checked", [(await api("PATCH", `/api/accounts/${s1.account.id}`, { driver: "runner" })).status, (await api("PATCH", `/api/accounts/${s1.account.id}`, { driver: "runner", dolphinProfileId: "bad id!" })).status], [400, 400]);
  eq("a profile ID switches it", (await api("PATCH", `/api/accounts/${s1.account.id}`, { driver: "runner", dolphinProfileId: "prof_1" })).body.driver, "runner");
  eq("now the runner can drive it, and the extension is given nothing", [(await call("GET", `/runner/a/${s1.account.id}/config`, { headers: RH })).status, (await ext("GET", "/ext/tasks/next", decode(rot.pairingCode).t)).body.task], [200, null]);
  eq("a runner account's token still works for the extension's config but its work goes through the runner", (await call("GET", `/runner/a/${s1.account.id}/tasks/next`, { headers: RH })).status, 200);
  await api("PATCH", `/api/clients/${c1.id}`, { followPool: "Niche_One\n@niche_two\nniche_three" });
  eq("the follow pool is stored lowercase without @", db.get("SELECT follow_pool FROM clients WHERE id = ?", c1.id).follow_pool, '["niche_one","niche_two","niche_three"]');
  eq("an invalid follow-pool name is refused", (await api("PATCH", `/api/clients/${c1.id}`, { followPool: "not valid!" })).status, 400);
  db.run("UPDATE accounts SET warm_started_at = ?, state = 'active', cooldown_until = 0, needs_reset = 0 WHERE id = ?", Date.now() - 40 * DAYMS, s1.account.id); db.run("UPDATE tasks SET status = 'skipped' WHERE account_id = ?", s1.account.id);
  const warmTask = () => { db.run("INSERT INTO tasks(account_id, client_id, type, status, not_before, created_at) VALUES(?,?,?,?,?,?)", s1.account.id, c1.id, "warm", "pending", 0, Date.now()); return ctx.scheduler.nextTask(db.get("SELECT * FROM accounts WHERE id = ?", s1.account.id), [], "runner").task; };
  const wt = warmTask();
  yes("a warm-up task offers at most 2 accounts from the pool", wt && wt.type === "warm" && wt.payload.follows.length >= 1 && wt.payload.follows.length <= 2 && wt.payload.follows.every((u) => ["niche_one", "niche_two", "niche_three"].includes(u)));
  for (const u of ["niche_one", "niche_two", "niche_three"]) db.run("INSERT OR IGNORE INTO follows(account_id, username, at) VALUES(?,?,?)", s1.account.id, u, Date.now());
  db.run("UPDATE tasks SET status = 'pending', not_before = 0 WHERE id = ?", wt.id);
  eq("once the daily cap is reached, or the pool is used up, no more follows are offered", ctx.scheduler.nextTask(db.get("SELECT * FROM accounts WHERE id = ?", s1.account.id), [], "runner").task.payload.follows, []);
  /* the supervisor's fail-safes, with no AI answer available (the fake API gives it nothing usable) */
  const sl = ctx.leads.get(db.get("SELECT id FROM leads WHERE username = 'plumb_dallas'").id), acct1 = db.get("SELECT * FROM accounts WHERE id = ?", s1.account.id);
  const mkTask = (type, text, leadId, extra = "") => db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, status, text, not_before, created_at) VALUES(?,?,?,?,?,?,?,?)", s1.account.id, c1.id, leadId, type, "pending", text, 0, Date.now()).id;
  db.run("UPDATE leads SET stage = 'do_not_contact' WHERE id = ?", sl.id);
  const v1 = await ctx.supervisor.review(acct1, mkTask("followup", "Just bumping this!", sl.id));
  eq("it blocks anything for a lead who asked not to be contacted, by rule, without asking the AI", [v1.verdict, /asked not to be contacted/.test(v1.reason)], ["block", true]);
  db.run("UPDATE leads SET stage = 'contacted' WHERE id = ?", sl.id);
  const t2 = mkTask("followup", "Hey! Quick question, are you open to new customers?", sl.id), v2 = await ctx.supervisor.review(acct1, t2);
  eq("if the AI can't be reached it holds the message for a person instead of sending it", [v2.verdict, db.get("SELECT status FROM tasks WHERE id = ?", t2).status, db.get("SELECT status FROM supervisor_log WHERE id = ?", v2.logId).status], ["hold", "held", "held"]);
  eq("a held command is not handed to the runner", (await call("GET", `/runner/a/${s1.account.id}/tasks/next`, { headers: RH })).body.task === null || (await call("GET", `/runner/a/${s1.account.id}/tasks/next`, { headers: RH })).body.task.id !== t2, true);
  eq("you can edit and approve it in the dashboard", [(await api("POST", `/api/supervisor/${v2.logId}/approve`, { text: "Hey! Are you taking on new customers right now?" })).status, db.get("SELECT status, sup_ok, text FROM tasks WHERE id = ?", t2)], [200, { status: "pending", sup_ok: 1, text: "Hey! Are you taking on new customers right now?" }]);
  const v3 = await ctx.supervisor.review(acct1, t2);
  eq("an approved command passes straight through, logged as yours", [v3.verdict, db.get("SELECT by FROM supervisor_log WHERE id = ?", v3.logId).by], ["allow", "human"]);
  const t4 = mkTask("dm", "x", sl.id); db.run("UPDATE tasks SET account_id = ? WHERE id = ?", s2 ? s2.account.id : 999, t4);
  eq("a command that belongs to another account is refused", (await ctx.supervisor.review(acct1, t4)).verdict, "block");
  eq("the supervisor list and stats are served to the dashboard", [(await api("GET", "/api/supervisor")).body.items.length >= 3, (await api("GET", "/api/supervisor")).body.stats.blocked >= 1], [true, true]);
  eq("runner endpoints validate the vision question", (await call("POST", `/runner/a/${s1.account.id}/vision/nope`, { headers: RH, body: {} })).status, 404);
  eq("and vision answers 'not available' cleanly when the picture is missing", (await call("POST", `/runner/a/${s1.account.id}/vision/classify`, { headers: RH, body: {} })).body.ok, false);

  /* ---- K. link handling units ---- */
  const links = rules.classifyLinks(outboundLinks('<a href="https://stan.store/joe">a</a><a href="https://calendly.com/joe">b</a>', "https://linktr.ee/joe"));
  eq("K link-in-bio contents are classified", [links.guru, links.booking], [["stan.store"], ["calendly.com"]]);
  eq("K Instagram's link wrapper is undone", rules.hostOf("https://l.instagram.com/?u=" + encodeURIComponent("https://calendly.com/x")), "calendly.com");

  /* ---- L. SSRF guard ---- */
  for (const u of ["http://127.0.0.1/", `http://127.0.0.1:${sitePort}/`, "http://localhost/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.1/", "http://example.com:8080/", "file:///etc/passwd", "ftp://example.com/"]) {
    let err = ""; try { await fetchPage(u, { allowPrivate: false, timeoutMs: 1500 }); } catch (e) { err = e.message; }
    yes("L blocked " + u, /blocked_address|blocked_port|bad_protocol/.test(err));
  }
  yes("L private ranges recognised", ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"].every(isPrivateIp) && !isPrivateIp("8.8.8.8"));

  /* ---- M. dashboard files ---- */
  const idx = await fetch(U + "/");
  eq("M dashboard page is served", [idx.status, (idx.headers.get("content-type") || "").startsWith("text/html")], [200, true]);
  eq("M no path traversal", (await fetch(U + "/..%2f..%2fetc/passwd")).status, 404);
  eq("M health check", (await fetch(U + "/health")).status, 200);

  await app.close(); claude.close(); site.close();
  console.log(`\n${total - bad} of ${total} passed${bad ? `, ${bad} FAILED` : ""}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
