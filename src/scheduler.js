/* Scheduler: hands the extension its next task, spreads warm-up sessions through the day,
   books follow-ups, and applies the result the extension reports. */
const { now, DAY, HOUR, MIN, j, fill, str, num, rand, HttpError } = require("./util");
const tzlib = require("./tz");

const OUTBOUND = ["dm", "followup"];
const TOUCH_MIN = 10, TOUCH_MAX = 30;     // minutes between the warm-touch and the cold opener
const TERMINAL_CODES = ["existing_thread", "private_cant_message", "cant_message", "invalid_profile", "lead_replied", "unconfirmed"];

function createScheduler(ctx) {
  const { db, accounts, leads, bus } = ctx;
  const clientOf = (id) => (id ? db.get("SELECT * FROM clients WHERE id = ?", id) : null);

  function variantFor(account) {
    const w = accounts.warm(account);
    if (accounts.health(account).level !== "healthy") return "careful";
    if (w.stage === "active") return "settled";
    return w.day <= 3 ? "gentle" : "steady";
  }

  /* Warm-up sessions are booked lazily, a few per day at random times inside the sending hours. */
  function ensureDailyWarm(account) {
    const rules = accounts.rulesFor(account), t = now(), start = tzlib.startOfDay(t, rules.tz), end = start + DAY;
    const have = db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type = 'warm' AND not_before >= ? AND not_before < ?", account.id, start, end).n;
    const w = accounts.warm(account);
    const target = w.stage === "warming" ? (w.day <= 2 ? 2 : w.day <= 5 ? 3 : 4) : 2;
    if (have >= target) return;
    const winStart = start + (rules.send_start + 0.4) * HOUR, winEnd = start + (rules.send_end - 0.5) * HOUR;
    const from = Math.max(t + 2 * MIN, winStart);
    if (from >= winEnd) return;
    const n = target - have, slot = (winEnd - from) / n;
    for (let i = 0; i < n; i++) {
      const nb = Math.floor(from + slot * i + Math.random() * slot * 0.7);
      db.run("INSERT INTO tasks(account_id, client_id, type, status, not_before, created_at) VALUES(?,?,?,?,?,?)", account.id, account.client_id, "warm", "pending", nb, t);
    }
  }

  /* Who this account may follow in this warm-up session: a few from the campaign's follow pool, never the same one twice,
     and never above the daily cap (lower while the account is still warming up). */
  const FOLLOW_CAP = () => Math.max(0, Math.min(8, Math.round(Number(db.setting("follow_cap", 3)))));
  function followsFor(account) {
    const client = accounts.clientFor(account), pool = j(client?.follow_pool, []);
    if (!pool.length) return [];
    const w = accounts.warm(account), cap = w.stage === "warming" ? Math.min(FOLLOW_CAP(), w.day <= 3 ? 0 : 1) : FOLLOW_CAP();
    const today = db.get("SELECT COUNT(*) AS n FROM follows WHERE account_id = ? AND at >= ?", account.id, now() - DAY).n, left = Math.min(2, cap - today);
    if (left <= 0) return [];
    const done = new Set(db.all("SELECT username FROM follows WHERE account_id = ?", account.id).map((r) => r.username)), mine = new Set(db.all("SELECT ig_username FROM accounts").map((r) => r.ig_username));
    return pool.filter((u) => !done.has(u) && !mine.has(u)).sort(() => Math.random() - 0.5).slice(0, left);
  }

  function nextTask(account, exclude = [], via = "ext") {
    // Role separation: only a sender is ever given work. (Finding leads no longer runs through an account at all.)
    if (account.kind !== "sender") return { task: null, reason: "not a sender account" };
    // One driver per account: either the Chrome extension or the runner, never both.
    if ((account.driver === "runner" ? "runner" : "ext") !== via) return { task: null, reason: "this account is driven by the other driver" };
    const st = accounts.effectiveState(account);
    if (st.state !== "active") return { task: null };
    const rules = accounts.rulesFor(account), t = now(), hr = tzlib.localHour(t, rules.tz);
    if (hr < rules.send_start || hr >= rules.send_end) return { task: null, reason: "outside sending window" };
    ensureDailyWarm(account);
    const w = accounts.warm(account), ex = new Set(exclude.map(Number));
    const rows = db.all(`SELECT * FROM tasks WHERE status = 'pending' AND not_before <= ? AND (account_id = ? OR (account_id IS NULL AND client_id IS ?))
      ORDER BY CASE type WHEN 'reply' THEN 0 WHEN 'followup' THEN 1 WHEN 'dm' THEN 2 ELSE 3 END, not_before, id LIMIT 60`, t, account.id, account.client_id);
    let paced = false, sent = null, lastOut = null;
    for (const task of rows) {
      if (ex.has(task.id)) continue;
      if (task.type !== "warm" && w.stage !== "active") continue;
      let lead = null;
      if (task.lead_id) {
        lead = leads.get(task.lead_id);
        if (!lead || lead.review !== "approved" || ["do_not_contact", "cold", "customer", "booked"].includes(lead.stage) && task.type !== "reply") { db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE id = ?", t, task.id); continue; }
        if (["do_not_contact"].includes(lead.stage)) { db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE id = ?", t, task.id); continue; }
      }
      if (OUTBOUND.includes(task.type)) {
        if (sent === null) sent = accounts.sentToday(account);
        if (sent >= accounts.capToday(account)) { paced = true; continue; }
        if (lastOut === null) lastOut = db.get("SELECT MAX(done_at) AS t FROM tasks WHERE account_id = ? AND type IN ('dm','followup') AND status = 'done'", account.id).t || 0;
        if (t - lastOut < 3 * MIN) { paced = true; continue; }
        // Pre-DM micro-engagement: before a cold opener goes out, the same account views the story or likes a post,
        // then the opener waits 10 to 30 minutes. The opener is pinned to this account so no other sender can message the lead.
        if (task.type === "dm" && clientOf(task.client_id)?.pre_dm_touch) {
          const tch = db.get("SELECT id, status FROM tasks WHERE lead_id = ? AND type = 'touch' ORDER BY id DESC LIMIT 1", task.lead_id);
          if (!tch) {
            const inflight = db.get(`SELECT COUNT(*) AS n FROM tasks d WHERE d.account_id = ? AND d.type = 'dm' AND d.status = 'pending' AND EXISTS (SELECT 1 FROM tasks x WHERE x.lead_id = d.lead_id AND x.type = 'touch')`, account.id).n;
            if (sent + inflight >= accounts.capToday(account)) { paced = true; continue; }
            const id = db.tx(() => {
              db.run("UPDATE tasks SET account_id = ?, not_before = ? WHERE id = ?", account.id, t + rand(TOUCH_MIN, TOUCH_MAX + 1) * MIN, task.id);
              return db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, status, not_before, created_at) VALUES(?,?,?,?,?,?,?)", account.id, task.client_id, task.lead_id, "touch", "pending", t, t).id;
            });
            const row = db.get("SELECT * FROM tasks WHERE id = ?", id);
            return { task: { id: row.id, type: "touch", username: lead.username, text: "", threadIg: "", payload: {} } };
          }
          if (tch.status === "pending") continue;                       // the touch comes first
        }
      }
      if (task.type === "reply" && !task.text) continue;
      if (!task.account_id) db.run("UPDATE tasks SET account_id = ? WHERE id = ? AND account_id IS NULL", account.id, task.id);
      return { task: { id: task.id, type: task.type, username: lead ? lead.username : undefined, text: task.text, threadIg: lead ? lead.thread_ig : "",
        inboundAt: task.inbound_at || undefined, payload: task.type === "warm" ? { variant: variantFor(account), follows: via === "runner" ? followsFor(account) : [] } : {} }, threadIg: lead ? lead.thread_ig : undefined };
    }
    return { task: null, ...(paced ? { reason: "pacing" } : {}) };
  }

  /* After a warm-touch (whatever came of it), the opener goes out 10 to 30 minutes later. */
  function touchFinished(task, t) {
    db.run("UPDATE tasks SET not_before = ? WHERE lead_id = ? AND type = 'dm' AND status = 'pending'", t + rand(TOUCH_MIN, TOUCH_MAX + 1) * MIN, task.lead_id);
  }
  function result(account, b) {
    if (account.kind !== "sender") throw new HttpError(403, "Only sender accounts report results.");
    const task = db.get("SELECT * FROM tasks WHERE id = ?", num(b.id));
    if (!task) throw new HttpError(404, "Unknown task.");
    if (task.account_id && task.account_id !== account.id) throw new HttpError(403, "That task belongs to another account.");
    if (["done", "skipped", "failed"].includes(task.status)) return { ok: true, ignored: true };
    const code = str(b.code, 40), t = now();
    if (task.type === "warm" && Array.isArray(b.followed)) for (const u of b.followed.slice(0, 5)) { const name = String(u || "").toLowerCase().replace(/^@/, ""); if (/^[a-z0-9._]{1,30}$/.test(name)) db.run("INSERT OR IGNORE INTO follows(account_id, username, at) VALUES(?,?,?)", account.id, name, t); }
    if (task.type === "touch" && !["blocked", "checkpoint", "login_required"].includes(code)) {
      db.run("UPDATE tasks SET status = ?, result_code = ?, done_at = ?, account_id = ? WHERE id = ?", b.ok ? "done" : "failed", b.ok ? "sent" : code || "skipped", t, account.id, task.id);
      touchFinished(task, t);
      const l = leads.get(task.lead_id);
      if (l) accounts.note(account, b.ok ? "info" : "info", b.ok ? `${account.label} warmed up @${l.username} (${str(b.detail, 40) || "touch"}).` : `${account.label} could not warm up @${l.username} (${code || "skipped"}). The opener still goes out later.`, "touch");
      bus?.publish({ t: "task", accountId: account.id });
      return { ok: true };
    }
    if (b.ok) {
      db.run("UPDATE tasks SET status = 'done', result_code = 'sent', done_at = ?, account_id = ? WHERE id = ?", t, account.id, task.id);
      if (task.lead_id && ["dm", "followup", "reply"].includes(task.type)) {
        leads.afterSent({ ...task, text: task.text }, account);
        const l = leads.get(task.lead_id);
        accounts.note(account, "good", `${account.label} sent ${{ dm: "a first message", followup: "a follow-up", reply: "a reply" }[task.type]} to @${l ? l.username : "someone"}.`, "sent");
      }
      db.run("UPDATE accounts SET last_action = ?, last_action_at = ? WHERE id = ?", task.type, t, account.id);
      bus?.publish({ t: "task", accountId: account.id }); bus?.publish({ t: "account", id: account.id });
      return { ok: true };
    }
    if (TERMINAL_CODES.includes(code)) {
      db.run("UPDATE tasks SET status = 'failed', result_code = ?, done_at = ? WHERE id = ?", code, t, task.id);
      if (task.lead_id) leads.afterFailed(task, code);
    } else if (code === "blocked" || code === "checkpoint") {
      db.run("UPDATE tasks SET not_before = ? WHERE id = ?", t + 12 * HOUR, task.id);
    } else if (code === "login_required") {
      db.run("UPDATE tasks SET not_before = ? WHERE id = ?", t + 30 * MIN, task.id);
    } else if (b.safeToRetry && task.tries < 3) {
      db.run("UPDATE tasks SET tries = tries + 1, not_before = ? WHERE id = ?", t + 15 * MIN * (task.tries + 1), task.id);
    } else {
      db.run("UPDATE tasks SET status = 'failed', result_code = ?, done_at = ? WHERE id = ?", code || "error", t, task.id);
      if (task.lead_id && task.type !== "warm" && task.type !== "touch") { const l = leads.get(task.lead_id); if (l) leads.touch(l.id, { needs_human: 1, notes: (l.notes ? l.notes + "\n" : "") + `Sending failed (${code || "error"}). Check by hand.` }); }
    }
    bus?.publish({ t: "task", accountId: account.id });
    return { ok: true };
  }

  /* Runs every minute: follow-ups that are due, stale tasks, optional auto-pause of weak sources. */
  function maintain() {
    const t = now();
    const due = db.all(`SELECT l.*, c.followups AS seq_json FROM leads l JOIN clients c ON c.id = l.client_id
      WHERE l.review = 'approved' AND l.stage = 'contacted' AND l.no_followup = 0 AND l.next_follow_at IS NOT NULL AND l.next_follow_at <= ? LIMIT 200`, t);
    for (const l of due) {
      const seq = j(l.seq_json, []);
      if (l.follow_step >= seq.length) { leads.touch(l.id, { stage: "cold", next_follow_at: null }); continue; }
      if (!l.thread_ig) continue;                       // wait until the inbox sync has seen the conversation
      if (db.get("SELECT 1 AS x FROM tasks WHERE lead_id = ? AND type = 'followup' AND status IN ('pending','draft')", l.id)) continue;
      const client = db.get("SELECT * FROM clients WHERE id = ?", l.client_id);
      const text = leads.cleanText(fill(seq[l.follow_step].text || "Hey {first_name}, just checking in!", leads.vars(l, client)), client, true);
      db.run("INSERT INTO tasks(account_id, client_id, lead_id, type, text, status, not_before, created_at) VALUES(?,?,?,?,?,?,?,?)",
        l.sender_account_id, l.client_id, l.id, "followup", text, "pending", l.next_follow_at, t);
    }
    db.run(`UPDATE tasks SET status = 'skipped', done_at = ? WHERE type = 'dm' AND status = 'pending' AND lead_id IN (SELECT id FROM leads WHERE review != 'approved' OR stage != 'new')`, t);
    db.run("DELETE FROM tasks WHERE type = 'warm' AND status IN ('done','skipped') AND done_at < ?", t - 14 * DAY);
    db.run("DELETE FROM events WHERE at < ?", t - 90 * DAY);
    db.run("DELETE FROM activity WHERE at < ?", t - 14 * DAY);
    // a warm-touch that never ran (browser closed) must not hold its opener back for ever
    db.run("UPDATE tasks SET status = 'skipped', done_at = ? WHERE type = 'touch' AND status = 'pending' AND created_at < ?", t, t - 60 * MIN);
  }
  return { nextTask, result, maintain, ensureDailyWarm, variantFor, TOUCH_MIN, TOUCH_MAX };
}
module.exports = { createScheduler };
