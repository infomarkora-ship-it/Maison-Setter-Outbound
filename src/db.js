const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'America/New_York',
  offer TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT 'friendly, short, casual', booking_link TEXT NOT NULL DEFAULT '',
  opener_template TEXT NOT NULL DEFAULT '', followups TEXT NOT NULL DEFAULT '[]',
  auto_reply INTEGER NOT NULL DEFAULT 0, auto_approve_pass INTEGER NOT NULL DEFAULT 0, auto_reject_no INTEGER NOT NULL DEFAULT 1,
  daily_cap INTEGER NOT NULL DEFAULT 20, send_start INTEGER NOT NULL DEFAULT 9, send_end INTEGER NOT NULL DEFAULT 20,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('sender','finder')), label TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id), ig_username TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  ig_age TEXT NOT NULL DEFAULT 'young', state TEXT NOT NULL DEFAULT 'active', reason TEXT NOT NULL DEFAULT '',
  cooldown_until INTEGER NOT NULL DEFAULT 0, warm_started_at INTEGER NOT NULL, profiles_per_day INTEGER NOT NULL DEFAULT 40,
  daily_cap_override INTEGER, last_seen_at INTEGER, last_version TEXT, last_mode TEXT, logged_in_as TEXT,
  replaced_by INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_acc ON events(account_id, at);
CREATE TABLE IF NOT EXISTS lead_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id), name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', include TEXT NOT NULL DEFAULT '[]', include_mode TEXT NOT NULL DEFAULT 'any',
  exclude TEXT NOT NULL DEFAULT '[]', account_types TEXT NOT NULL DEFAULT '[]', min_followers INTEGER NOT NULL DEFAULT 0,
  max_followers INTEGER NOT NULL DEFAULT 0, active_within_days INTEGER NOT NULL DEFAULT 0, regions TEXT NOT NULL DEFAULT '[]',
  require_contact INTEGER NOT NULL DEFAULT 0, public_only INTEGER NOT NULL DEFAULT 1, borderline TEXT NOT NULL DEFAULT 'haiku',
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_type_id INTEGER REFERENCES lead_types(id), kind TEXT NOT NULL, ref TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'peers', enabled INTEGER NOT NULL DEFAULT 1,
  pause_reason TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'server', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_type_id INTEGER REFERENCES lead_types(id),
  lead_type_name TEXT NOT NULL DEFAULT '', lead_type_desc TEXT NOT NULL DEFAULT '', lead_regions TEXT NOT NULL DEFAULT '[]', source_id INTEGER REFERENCES sources(id), finder_account_id INTEGER, sender_account_id INTEGER,
  username TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  followers INTEGER, following INTEGER, posts INTEGER, is_business INTEGER, external_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', last_post_at INTEGER, captions TEXT NOT NULL DEFAULT '[]',
  surfaced_by TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT 'pass', needs_haiku INTEGER NOT NULL DEFAULT 0,
  rules_score INTEGER NOT NULL DEFAULT 0, reasons TEXT NOT NULL DEFAULT '[]',
  haiku_status TEXT NOT NULL DEFAULT 'none', haiku_fit TEXT NOT NULL DEFAULT '', haiku_score INTEGER, haiku_reason TEXT NOT NULL DEFAULT '',
  review TEXT NOT NULL DEFAULT 'pending', review_reason TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'new',
  opener TEXT NOT NULL DEFAULT '', opener_edited INTEGER NOT NULL DEFAULT 0, contact TEXT NOT NULL DEFAULT '{}',
  enrich_status TEXT NOT NULL DEFAULT 'none', thread_ig TEXT NOT NULL DEFAULT '', follow_step INTEGER NOT NULL DEFAULT 0,
  next_follow_at INTEGER, last_activity_at INTEGER, last_inbound_ts INTEGER NOT NULL DEFAULT 0,
  no_followup INTEGER NOT NULL DEFAULT 0, needs_human INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
  reviewed_at INTEGER, booked_at INTEGER,
  found_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS leads_uq ON leads(IFNULL(client_id, 0), username);
CREATE INDEX IF NOT EXISTS leads_client ON leads(client_id, review, stage);
CREATE INDEX IF NOT EXISTS leads_found ON leads(found_at);
CREATE TABLE IF NOT EXISTS claims (username TEXT PRIMARY KEY, client_id INTEGER NOT NULL, claimed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL, direction TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL,
  UNIQUE (lead_id, direction, ts, text));
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, client_id INTEGER, lead_id INTEGER, type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  not_before INTEGER NOT NULL DEFAULT 0, inbound_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, result_code TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, done_at INTEGER);
CREATE INDEX IF NOT EXISTS tasks_acc ON tasks(account_id, status, not_before);
CREATE INDEX IF NOT EXISTS tasks_lead ON tasks(lead_id, status);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_id INTEGER, lead_id INTEGER, level TEXT NOT NULL DEFAULT 'info', kind TEXT NOT NULL DEFAULT '', text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
/* Every command the AI supervisor looked at, and what it decided. status: final | held | approved | denied */
CREATE TABLE IF NOT EXISTS supervisor_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_id INTEGER, task_id INTEGER, lead_id INTEGER,
  kind TEXT NOT NULL, verdict TEXT NOT NULL, risk INTEGER, reason TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT 'rules', before_text TEXT NOT NULL DEFAULT '',
  after_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'final');
CREATE INDEX IF NOT EXISTS supervisor_at ON supervisor_log(at);
/* Accounts each sender has followed, so it never follows the same one twice and stays under its daily follow cap */
CREATE TABLE IF NOT EXISTS follows (account_id INTEGER NOT NULL, username TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (account_id, username));
`;

/* Columns added after v1. Each is added only if it is missing, so an existing Railway database upgrades in place. */
const ADDS = [
  ["clients", "target", "TEXT NOT NULL DEFAULT ''"],
  ["clients", "exclude_words", "TEXT NOT NULL DEFAULT '[]'"],
  ["clients", "allow_agencies", "INTEGER NOT NULL DEFAULT 0"],
  ["clients", "agency_opener_template", "TEXT NOT NULL DEFAULT ''"],
  ["clients", "pre_dm_touch", "INTEGER NOT NULL DEFAULT 1"],
  ["clients", "min_followers", "INTEGER NOT NULL DEFAULT 150"],
  ["clients", "max_followers", "INTEGER NOT NULL DEFAULT 100000"],
  ["clients", "active_within_days", "INTEGER NOT NULL DEFAULT 30"],
  ["clients", "allow_creator_labels", "INTEGER NOT NULL DEFAULT 0"],
  ["clients", "require_contact", "INTEGER NOT NULL DEFAULT 1"],
  ["accounts", "driver", "TEXT NOT NULL DEFAULT 'extension'"],
  ["accounts", "dolphin_profile_id", "TEXT NOT NULL DEFAULT ''"],
  ["accounts", "proxy_ip", "TEXT NOT NULL DEFAULT ''"],
  ["clients", "supervision", "TEXT NOT NULL DEFAULT 'supervised'"],
  ["clients", "follow_pool", "TEXT NOT NULL DEFAULT '[]'"],
  ["tasks", "sup_ok", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "needs_reset", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "quarantined_at", "INTEGER"],
  ["accounts", "last_action", "TEXT NOT NULL DEFAULT ''"],
  ["accounts", "last_action_at", "INTEGER"],
  ["leads", "source_type", "TEXT NOT NULL DEFAULT 'ig_organic'"],
  ["leads", "page_name", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "ad_copy", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "ad_landing_url", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "ad_start_date", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "entity_classification", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "entity_type", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "confidence", "INTEGER"],
  ["leads", "detected_niche", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "service_location", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "disqualification_reason", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "personalization_hook", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "has_booking_infra", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "has_website", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "quality_points", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "priority_boost", "INTEGER NOT NULL DEFAULT 0"],
  ["leads", "is_private", "INTEGER"],
  ["leads", "instagram_user_id", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "profile_data", "INTEGER NOT NULL DEFAULT 1"],
  ["leads", "gate", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "import_batch", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "links", "TEXT NOT NULL DEFAULT '[]'"],
  ["usage", "cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["usage", "cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"],
  /* Maison Setter growth command center */
  ["clients", "monthly_cost", "REAL NOT NULL DEFAULT 0"],
  ["leads", "pipeline", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "intent", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "score", "INTEGER"],
  ["leads", "score_detail", "TEXT NOT NULL DEFAULT '[]'"],
  ["leads", "opportunity_value", "REAL NOT NULL DEFAULT 0"],
  ["leads", "next_action", "TEXT NOT NULL DEFAULT ''"],
  ["leads", "scored_at", "INTEGER"],
  ["leads", "last_reply_at", "INTEGER"],
  ["leads", "reply_intent", "TEXT NOT NULL DEFAULT ''"],
  /* Warm-up program: how many program days are complete, how far the day-checker has walked, holds and missed days */
  ["accounts", "warm_done", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "warm_cursor", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "warm_holds", "INTEGER NOT NULL DEFAULT 0"],
  ["accounts", "warm_missed", "INTEGER NOT NULL DEFAULT 0"]
];

/* Tables for the growth command center. Each is created only if missing, so an existing database upgrades in place. */
const NEW_TABLES = `
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_id INTEGER REFERENCES leads(id),
  title TEXT NOT NULL DEFAULT '', scheduled_at INTEGER, duration_min INTEGER NOT NULL DEFAULT 30, tz TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'call', status TEXT NOT NULL DEFAULT 'booked', source TEXT NOT NULL DEFAULT 'outreach',
  notes TEXT NOT NULL DEFAULT '', value REAL NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS appts_client ON appointments(client_id, scheduled_at);
CREATE INDEX IF NOT EXISTS appts_lead ON appointments(lead_id);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_id INTEGER REFERENCES leads(id),
  value REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', won_reason TEXT NOT NULL DEFAULT '', lost_reason TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, won_at INTEGER, lost_at INTEGER);
CREATE INDEX IF NOT EXISTS opps_client ON opportunities(client_id, status);
CREATE INDEX IF NOT EXISTS opps_lead ON opportunities(lead_id);
CREATE TABLE IF NOT EXISTS lead_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id), lead_id INTEGER REFERENCES leads(id),
  title TEXT NOT NULL, due_at INTEGER, priority TEXT NOT NULL DEFAULT 'medium', done INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ltasks_lead ON lead_tasks(lead_id, done);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium', client_id INTEGER, lead_id INTEGER, appointment_id INTEGER,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open',
  snooze_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, priority);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_key ON alerts(kind, IFNULL(lead_id, 0), IFNULL(client_id, 0)) WHERE status IN ('open','in_progress');
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  client_id INTEGER, lead_id INTEGER, read INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notif_read ON notifications(read, created_at);
CREATE TABLE IF NOT EXISTS onboarding (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER UNIQUE REFERENCES clients(id), step INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}', completed INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`;
/* Indexes on the new columns. The first one is the workspace-wide lock: one business can never be two leads in a workspace,
   so two sender accounts cannot both message it. (client_id, username) is already unique from v1. */
const INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS leads_uid ON leads(IFNULL(client_id, 0), instagram_user_id) WHERE instagram_user_id != ''",
  "CREATE INDEX IF NOT EXISTS leads_class ON leads(client_id, entity_classification, review)",
  "CREATE INDEX IF NOT EXISTS leads_batch ON leads(import_batch)"
];
function migrate(raw) {
  const have = {};
  for (const [t, c, ddl] of ADDS) {
    have[t] ||= new Set(raw.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
    if (!have[t].has(c)) { raw.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); have[t].add(c); if (t === "leads" && c === "gate") raw.exec("UPDATE leads SET gate = 'legacy'"); }   // leads from before the upgrade were never filtered: mark them done, not "processing"
  }
  const skipped = [];
  for (const sql of INDEXES) { try { raw.exec(sql); } catch (e) { skipped.push(e.message); } }   // old data with duplicates: keep running, the app also checks in code
  // Finding now happens outside this app (Apify imports), so old finder accounts are switched off, not deleted.
  raw.exec("UPDATE accounts SET state = 'killed', reason = 'Finding now happens through imports, so finder accounts are no longer used.' WHERE kind = 'finder' AND state != 'killed'");
  return skipped;
}

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA);
  for (const stmt of NEW_TABLES.split(";")) { const s = stmt.trim(); if (s) { try { raw.exec(s); } catch { /* old data with a conflicting shape keeps running; code checks too */ } } }
  migrate(raw);
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const norm = (p) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  const db = {
    raw,
    get: (sql, ...p) => st(sql).get(...norm(p)),
    all: (sql, ...p) => st(sql).all(...norm(p)),
    run: (sql, ...p) => { const r = st(sql).run(...norm(p)); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; },
    tx(fn) { raw.exec("BEGIN"); try { const r = fn(); raw.exec("COMMIT"); return r; } catch (e) { raw.exec("ROLLBACK"); throw e; } },
    setting(key, def = null) { const r = db.get("SELECT value FROM settings WHERE key = ?", key); if (!r) return def; try { return JSON.parse(r.value); } catch { return def; } },
    setSetting(key, value) { db.run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value)); },
    close() { raw.close(); }
  };
  return db;
}
module.exports = { openDb };
