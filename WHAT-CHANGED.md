# Maison Setter server 3.3 — what changed

The AI part in every section. Each section of the operation now has a "describe what you want" AI
path next to its form, the whole thing runs on one company brain built by an 8-question interview,
the setter is trained on a real appointment-setting playbook, and the supervisor was rethought from
"how dangerous is this" to "is sending this a good idea". The extension is unchanged: it only ever
executes what the server decides.

## 1. The AI builder: describe it, the AI fills the real fields
- New module `src/builder.js` + endpoints: `POST /api/ai/build` (fills form fields),
  `POST /api/ai/chat` (the chat panel), `POST /api/ai/interview` (onboarding), `POST /api/ai/brain` (approval).
- **Campaign editor**: a "Build with AI" card describes the basics (offer, target, tone), the opener
  scripts or the whole follow-up sequence from a plain-words paragraph. It fills the real form fields
  with a written explanation of why; nothing saves until "Save changes", so the AI recommends and you pick.
- **Warm-up plans**: the plan drawer has "Build a plan with AI". Describe the niche, the account age and
  how aggressive you want it, and the AI writes the full day-by-day plan (phases, sessions, DMs/day,
  follows/day). AI plans must pass the existing guardrails (`validatePlan`), with one automatic repair
  retry that feeds the validation error back to the model. Aggressive plans still require the explicit override.
- **AI builder page** (new, Workspace menu): a chat with the strategist brain. It reads the campaign,
  the company brain and the knowledge layers, proposes a concrete patch (basics, scripts, follow-ups,
  warm-up plan, onboarding sections), shows it as JSON, and one "Apply to campaign" button runs it
  through the same validated endpoints the forms use. Nothing is applied without your click.
- Every AI-built string goes through `noEmDash()`: em and en dashes are killed at the source, and
  `cleanText` strips any that slip through on every outgoing message. The rule is absolute.

## 2. The personalization layer: the 8-question interview and the company brain
- Onboarding gained an AI interview slide (still the first stop; the manual slides stay for people who
  would rather type). A fixed set of 8 questions, one at a time, phrased with the context of the answers
  so far: company, offer and price, differentiators, proof, ideal customer (paste yours or let the AI
  draft one), tone and never-say words, pricing policy, booking process.
- After the 8th answer the AI synthesizes the **company brain** (structured profile: company, market,
  offer, pricing approach, differentiators, proof, tone, do-not-say, booking process), a **draft ICP**
  (all ten fields the manual slide has) and a setter-style briefing. You edit the ICP on the approve
  screen and click "Approve and use": the brain + ICP are saved, and the campaign row's offer, target
  and tone sync from them.
- The brain rides in every prompt from then on: openers, replies, the supervisor's review, the builders
  and the chat panel. Onboarding state is stored in the existing `onboarding` row (`interview`, `brain`
  and `icp` sections), and Business profile shows the brain as its own section.

## 3. Outreach personalization: AI-drafted openers are now the default path
- Previously the opener was a base template with one hook dropped in. Now every passed lead also gets an
  AI opener queued automatically (`makeOpener`), written per lead from the company brain, the knowledge
  layers and the profile (bio, category, recent captions), with the new `OPENER_RULES`: one specific true
  thing, varied message skeletons, no invented facts. The template stays as the instant fallback and
  your edits are never overwritten (`opener_edited` still wins).

## 4. The appointment setter is trained (the built-in playbook)
- New `src/playbook.js`: a full setter playbook injected verbatim into every reply prompt. It covers
  acting human (a casual, confident "no" when asked if this is a bot, then straight back to the
  conversation), pro-setter message discipline (one question per message, mirroring, no corporate
  lines), the close (two-option time close, booking link fallback, confirm the slot), the objection
  ladders (too expensive, need to think about it, send me info, not right now, talk to my partner,
  already have someone, no time, legitimacy, ghosting re-engagement), when to walk away, and the facts
  rule (never invent prices, promises or results; pivot to the call).
- The setter now receives the whole knowledge stack on every decision: playbook + company brain +
  global knowledge + campaign knowledge (including the new script field on the knowledge slide).
  Before this change the knowledge collected in onboarding never reached the reply drafter at all.
- New intent `disengage`: time-wasters and one-word loops get walked away from politely
  (stage cold, no follow-ups, nothing wasted) instead of sitting in a human's queue.
- Handoffs shrink to the genuine cases: anger or legal, explicit "get me a human", phone number
  requests, stop requests, and factual questions the knowledge base cannot answer. Price questions,
  bot questions and negotiation are answered from the knowledge base, not escalated.

## 5. The supervisor was rethought: "is sending this a good idea?"
- The system prompt is rewritten from "conservative gatekeeper, everything money/bot/phone gets held"
  to a context judge: does this fit the conversation, does it read like a person, does it invent
  anything? Bot-question answers and price talk backed by the knowledge are explicitly correct now.
- Holds only for unverifiable facts and the genuine handoffs; blocks only for stop signals, anger,
  legal, deception and abuse. The knowledge layers ride along in the review prompt, so the reviewer
  checks claims against what the business actually wrote.
- Autonomy thresholds loosened: supervised holds at risk 75+ (was 60), autopilot at risk 90+ (was 85).
  Watch mode is unchanged. The AI Lab drill labels and the campaign editor mode text match.
- The bouncer / Apify pre-filter is untouched: marginal profiles are still auto-rejected before any
  meaningful cost, and leads only wait for a person when the pre-filter or the bouncer genuinely
  cannot decide.

## 6. Knowledge & script page (new, Workspace menu)
- The global company knowledge: overview, FAQs, pricing guidance, objection notes, policies, proof,
  script, extra notes (`GET/PUT /api/kb`, stored in settings). The page explains the three layers:
  built-in playbook (always on) → global knowledge (this page) → per-campaign knowledge and script
  (onboarding). Overlaps resolve in favor of the campaign layer.

## 7. Version you can see (added after release)
- The login screen and the sidebar now show the actual server build ("Server build: v3.3.0"), read live from the server's `/api/session` - so you always know which version is really deployed, before signing in.
- Static script tags carry a `?v=3.3.0` cache-buster on top of the existing `no-cache` header, so no proxy between you and Railway can ever serve an old dashboard.
- The Campaigns page carries a one-line tip pointing at the "Build with AI" card inside the campaign form.

## Files
- New: `src/playbook.js`, `src/brain.js`, `src/builder.js`, `public/views4.js`.
- Changed: `src/leads.js` (prompts, disengage, opener queue, noEmDash), `src/supervisor.js` (prompt,
  thresholds, knowledge in review), `src/api.js` (6 new endpoints, warmup clientId), `src/server.js`
  (brain + builder wiring), `src/growth.js` (interview/brain onboarding sections), `src/util.js`
  (noEmDash), `public/app.js`, `public/views2.js`, `public/views3.js`, `public/index.html`,
  `public/style.css`, `package.json`.
- Untouched: everything the extension talks to (`/ext/*`), the runner, warm-up presets, scoring, CRM.

---

# Maison Setter server 3.2 — what changed

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
