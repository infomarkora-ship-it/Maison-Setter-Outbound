/* Senders Live: what every sender's browser is doing RIGHT NOW.
   The Chrome extension posts a small status blob whenever something changes and at least every
   ~20 seconds (POST /ext/status). This module keeps the latest blob per account in memory and
   publishes it on the event bus, so an open dashboard updates the moment a status lands.
   Nothing here hits the database: the newest state is live data, and a restart simply resets the
   cards to "waiting for the next ping".
   Runner-driven accounts report through the heartbeats the runner already sends — their card is
   built from accounts.summary() data (last_action, last_seen_at), with no runner changes. */
function createLive() {
  const byId = new Map();                 // accountId -> status blob
  const logs = new Map();                 // accountId -> recent { at, text } lines (extension step log)
  let published = 0;

  function update(accountId, blob) {
    const id = Number(accountId);
    if (!Number.isFinite(id)) return;
    const prev = byId.get(id);
    const next = { ...blob, id, at: Date.now() };
    byId.set(id, next);
    if (blob.logLine) {
      const list = logs.get(id) || [];
      if (!list.length || list[0].text !== blob.logLine) list.unshift({ at: Date.now(), text: String(blob.logLine).slice(0, 200) });
      while (list.length > 6) list.pop();
      logs.set(id, list);
    }
    published++;
    return next;
  }
  const get = (id) => byId.get(Number(id)) || null;
  const logOf = (id) => logs.get(Number(id)) || [];
  const all = () => [...byId.values()];
  const stats = () => ({ accounts: byId.size, updates: published });
  /* A sender is "live" when its last status ping is under two minutes old. */
  const fresh = (id, ms = 120_000) => { const s = byId.get(Number(id)); return !!s && Date.now() - s.at < ms; };
  return { update, get, logOf, all, stats, fresh };
}
module.exports = { createLive };
