# Maison Setter server 3.2 — what changed

Four features plus the PostgreSQL move. Nothing about the runner was touched, and no old
behaviour was removed — every preset, safety rule and workflow works exactly as before.

## 1. PostgreSQL (the database move)
- Set `DATABASE_URL` (a `postgres://` address) and the server uses PostgreSQL. No variable, no change — it keeps using the SQLite file like before, so local dev and the test suite still work with zero setup.
- The whole schema was rebuilt for PostgreSQL: 64-bit columns for all timestamps (SQLite integers were 64-bit, PostgreSQL's 32-bit integers would overflow on epoch milliseconds), the same tables, columns and indexes as before.
- The app's queries keep their SQLite dialect; a small translator on the way to PostgreSQL rewrites the few dialect differences (`?` placeholders, `IFNULL`, `INSERT OR IGNORE`, `IS ?`). A worker thread owns the connections so the app keeps its simple synchronous style.
- **One-time data migration** so your leads, accounts, tasks and history survive the switch:
      node scripts/migrate-sqlite-to-postgres.js data/magnetengine.db "$DATABASE_URL"
  Run it once while the server is stopped, then point Railway at the Postgres database and redeploy.
- The full test suite (214 checks) passes on both PostgreSQL and SQLite.

## 2. AI Lab — test the bot without touching anything real
- New "AI Lab" page in the dashboard. Two testers:
  - **Draft tester** — the exact prompts production uses for openers and replies, pointed at a made-up or pasted profile and conversation. Shows the draft, the intent, whether it handed off to a human, and how long it took.
  - **Supervisor drill** — the same hard rules, the same model prompt and the same watch/supervised/autopilot thresholds as a real send. Shows verdict (allow/edit/hold/block), risk, reason and the final text.
- Nothing is ever sent, saved as a task or written to a lead. Every drill is recorded in the AI supervisor log with a `lab` kind so you can audit what you tested.
- Endpoints: `POST /api/lab/draft`, `POST /api/lab/verdict`, `GET /api/lab/history`.

## 3. Senders Live — see what every browser is doing right now
- New "Senders live" page: one card per sender with a traffic light (moving / connected but quiet / offline), the current action in plain words ("Step 3/5 — typing — writing to @joes_roofing (thread)"), today's sent/limit, warm-up day, the last error, and the last few log lines from that browser.
- The extension (6.3+) posts a small status blob whenever something changes and at least every ~20s (`POST /ext/status`); the server keeps the latest per account in memory and pushes it to open dashboards over the existing event stream. Nothing new is stored in the database; a restart just resets the cards.
- Runner-driven accounts keep their own reporting: their cards show the runner's heartbeat data (last action, last check-in) — the runner itself is unchanged.

## 4. Warm-up: fully customizable, presets kept
- The three presets (Strict 21 / Standard 14 / Fast 7) are unchanged and remain the default per account age. An account can also be pinned to any preset explicitly.
- "Plan…" button on every account card opens a plan drawer: assign a preset, edit an existing custom plan or build a new one — phases table (each phase runs until the day you set, with sessions / DMs / follows per day), counting rules (require the browser to have run, warning holds the day), and the post-program sending ramp.
- A live preview colors the first 30 days of the plan. Guardrails refuse configs the presets would never do (DMs in the first 3 days, phase caps above 10 DMs or 4 follows, programs shorter than 7 days); the explicit "allow an aggressive plan" switch lifts them — the hard cap of 40 DMs/day can never be lifted.
- Storage: custom plans live in server settings (`warmup_plans`), each account stores its assignment in the new `accounts.warm_plan` column. Delete a plan and its accounts fall back to the preset for their age.

## 5. Two AI providers: Claude Haiku AND Gemini Flash Lite
- Settings → "AI model": pick Automatic (Haiku if its key exists, else Gemini), Claude Haiku, or Gemini Flash Lite. Both stay available; the choice applies to the bouncer, the supervisor, drafts, openers and vision.
- Gemini: set `GEMINI_API_KEY` on the server **or** paste the key in Settings (stored in the database, never echoed back). `GEMINI_MODEL` overrides the model id (default `gemini-3.5-flash-lite`).
- "Test Haiku" / "Test Gemini" buttons ping each provider and report latency or the exact error.
- Safety unchanged: the AI can only make things safer, and if the active model fails, messages hold for a human instead of going out unchecked.

## Env vars added
| Variable | Meaning | Default |
| --- | --- | --- |
| `DATABASE_URL` | postgres:// address — wins over DB_PATH | (none = SQLite) |
| `GEMINI_API_KEY` | Google API key (or set it in Settings) | (none) |
| `GEMINI_MODEL` | Gemini model id | `gemini-3.5-flash-lite` |
| `AI_PROVIDER` | force `haiku` or `gemini` | automatic |

## Tests
- `npm run test:server` — 146 checks (pass on SQLite and on PostgreSQL via `TEST_DB_PATH=postgres://...`)
- `npm run test:ui` — 68 browser checks (both backends)
- The pre-existing `e2e-runner` failures exist in the untouched original code as well (the runner was only ever tested against simulators) and are unrelated to these changes.
