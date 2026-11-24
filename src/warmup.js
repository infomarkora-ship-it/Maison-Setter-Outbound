/* Warm-up program: an Instantly-style day-by-day plan for every sender account.
   Instead of "wait N days and hope", each account walks a fixed number of program days.
   A program day is only counted as completed when that calendar day was CLEAN:
   the browser actually ran (activity exists) and Instagram showed no warning.
     - warning that day      -> the day is HELD: it does not count, the account repeats it
     - browser never ran     -> the day is MISSED: it does not count either (laptop closed = program paused)
     - clean and active      -> the day counts, the account advances
   So a skipped day delays the program instead of skipping ahead, and a warning holds it.
   Phases: browse only -> touches -> first DMs -> ramp. The daily cap rises with every phase. */
const { now, DAY, HOUR, MIN } = require("./util");
const tzlib = require("./tz");

/* Program length by account age: a brand-new Instagram account needs three weeks,
   a months-old account two, an established one a fast week. */
const PROGRAM_DAYS = { new: 21, young: 14, established: 7 };
const WARN_KINDS = "('action_blocked','checkpoint','quarantine')";

/* What day N of the program asks for. */
function dayPlan(day) {
  if (day <= 3) return { phase: "browse", label: "Browsing only", sessions: 2, dms: 0, follows: 0,
    plan: "Feed, explore and inbox visits. No messages yet." };
  if (day <= 7) return { phase: "touch", label: "Look around + touches", sessions: 3, dms: 0, follows: 1,
    plan: "Story views and post likes, one follow a day. Still no cold messages." };
  if (day <= 11) return { phase: "first", label: "First DMs", sessions: 4, dms: 3, follows: 1,
    plan: "Cold DMs unlock: up to 3 a day, every one warmed up with a story view or like first." };
  return { phase: "ramp", label: "Ramp up", sessions: 4, dms: Math.min(6, 3 + (day - 11)), follows: 2,
    plan: `Volume rises: up to ${Math.min(6, 3 + (day - 11))} first messages a day.` };
}

function createWarmup(ctx) {
  const { db, accounts } = ctx;

  const rules = (a) => accounts.rulesFor(a);
  const healthFactor = (a) => ({ healthy: 1, caution: 0.5, risky: 0 }[accounts.health(a).level] ?? 1);

  /* What happened on one calendar day: did the browser run, and did Instagram complain? */
  function dayRecord(a, from, to) {
    const active = db.get(`SELECT
      (SELECT COUNT(*) FROM tasks WHERE account_id = ? AND done_at IS NOT NULL AND done_at >= ? AND done_at < ?) +
      (SELECT COUNT(*) FROM activity WHERE account_id = ? AND at >= ? AND at < ?) +
      (SELECT COUNT(*) FROM events WHERE account_id = ? AND at >= ? AND at < ?) AS n`,
      a.id, from, to, a.id, from, to, a.id, from, to).n;
    const warn = db.get(`SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND kind IN ${WARN_KINDS} AND at >= ? AND at < ?`, a.id, from, to).n;
    if (warn > 0) return { status: "held", active, warn };
    if (active === 0) return { status: "missed", active, warn };
    return { status: "done", active, warn };
  }

  /* Advance the counters over every finished calendar day. Cheap: walks only the days it has not seen yet. */
  function settle(a) {
    if (!a || !a.warm_started_at) return a;
    const tz = rules(a).tz, t = now();
    const start = tzlib.startOfDay(a.warm_started_at, tz);
    const elapsed = Math.floor((tzlib.startOfDay(t, tz) - start) / DAY);   // full calendar days completed
    const cursor = a.warm_cursor || 0;
    if (elapsed <= cursor) return a;
    let done = a.warm_done || 0, holds = a.warm_holds || 0, missed = a.warm_missed || 0;
    for (let d = cursor; d < elapsed; d++) {   // d = 0-indexed day since start; cursor counts evaluated days
      const rec = dayRecord(a, start + d * DAY, start + (d + 1) * DAY);
      if (rec.status === "done") done++;
      else if (rec.status === "held") { holds++; accounts.note(a, "warn",
        `Warm-up day held: Instagram showed a warning that day, so the account repeats it (${done} clean days so far).`, "warmup"); }
      else missed++;
    }
    db.run("UPDATE accounts SET warm_done = ?, warm_cursor = ?, warm_holds = ?, warm_missed = ? WHERE id = ?", done, elapsed, holds, missed, a.id);
    const fresh = db.get("SELECT * FROM accounts WHERE id = ?", a.id);
    const total = PROGRAM_DAYS[a.ig_age] || 14;
    if (done >= total && (a.warm_done || 0) < done) accounts.note(a, "good", `${a.label} finished its ${total}-day warm-up program and is cleared for its sending ramp.`, "warmup");
    return fresh;
  }

  /* The object the extension popup and the dashboard show. */
  function program(a) {
    a = settle(db.get("SELECT * FROM accounts WHERE id = ?", a.id)) || a;
    const total = PROGRAM_DAYS[a.ig_age] || 14;
    const done = a.warm_done || 0, active = done >= total;
    const day = Math.min(done + 1, total);
    const plan = dayPlan(active ? total : day);
    const tz = rules(a).tz, today = tzlib.startOfDay(now(), tz);
    const sessionsDone = db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type = 'warm' AND status = 'done' AND done_at >= ?", a.id, today).n;
    const dmsSent = db.get("SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND type IN ('dm','followup') AND status = 'done' AND result_code = 'sent' AND done_at >= ?", a.id, today).n;
    const st = accounts.effectiveState(a);
    const factor = st.state === "active" ? healthFactor(a) : 0;
    let dmsAllowed;
    if (!active) dmsAllowed = Math.floor(plan.dms * factor);
    else {                                     // program finished: the post-program ramp
      const activeDays = Math.max(0, Math.floor((now() - (a.warm_started_at + total * DAY)) / DAY));
      const base = Math.min(a.daily_cap_override ?? 20, 40);
      const ramp = activeDays < 3 ? 6 : activeDays < 7 ? 10 : activeDays < 14 ? 15 : 40;
      dmsAllowed = Math.floor(Math.min(base, ramp) * factor);
    }
    /* Calendar grid: the last 60 calendar days since the program started, colored by what happened. */
    const cursor = a.warm_cursor || 0, history = [];
    const firstShown = Math.max(0, cursor - 59);
    const startDay = today - cursor * DAY;
    for (let d = firstShown; d <= cursor; d++) {
      const rec = dayRecord(a, startDay + d * DAY, startDay + (d + 1) * DAY);
      const isToday = d === cursor;
      history.push({ day: d + 1, at: startDay + d * DAY, status: isToday ? (rec.warn ? "held" : "today") : rec.status });
    }
    const remaining = Math.max(0, total - done);
    const unlocked = [];
    if (day > 3 || active) unlocked.push("Browsing routines");
    if (day > 7 || active) unlocked.push("Story views, likes, follows");
    if (day > 11 || active) unlocked.push("Cold DMs");
    if (active) unlocked.push("Post-program sending ramp");
    return {
      total, done, day, active, phase: plan.phase, phaseLabel: active ? "Program finished" : plan.label,
      sessionsDone, sessionsRequired: active ? 2 : plan.sessions, dmsSent, dmsAllowed,
      warnings: a.warm_holds || 0, missedDays: a.warm_missed || 0,
      plan: active ? "Normal sending. The ramp raises the daily cap over the next two weeks." : plan.plan,
      unlocked, nextUnlock: active ? null : (day <= 3 ? { atDay: 4, what: "Story views, likes and follows" }
        : day <= 7 ? { atDay: 8, what: "First cold DMs (3/day)" } : day <= 11 ? { atDay: 12, what: "Higher daily volume" } : null),
      finishAt: now() + remaining * DAY, history, health: accounts.health(a).level
    };
  }

  return { PROGRAM_DAYS, dayPlan, program, settle };
}
module.exports = { createWarmup, PROGRAM_DAYS, dayPlan };
