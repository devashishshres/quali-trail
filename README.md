# QualiTrail

QualiTrail helps HVAC technicians turn scattered certificates, training and work records into an **evidence
passport**, match that evidence against a job's requirements, and print a **qualification packet**.

It never decides that someone is qualified. It shows what the documents say, what is missing, and what a person
still needs to check for themselves.

All demo people, employers, documents and listings are **fictional** and labelled as such in the files themselves.

Check out the application here: https://www.proofisinthepiping.work

---

## Contents

1. [What it does](#what-it-does) · 2. [What the labels mean](#what-the-labels-mean) · 3. [Feature map](#feature-map)
4. [Quick start](#quick-start) · 5. [Configuration](#configuration) · 6. [Pages and API](#pages-and-api)
7. [Database](#database) · 8. [Demo data](#demo-data) · 9. [Testing](#testing)
10. [Deployment](#deployment) · 11. [Limits and known gaps](#limits-and-known-gaps)

---

## What it does

| # | Step | How |
|---|---|---|
| 1 | **Capture** | Upload a PDF or type the details. Gemini extracts structured fields; the worker reviews and corrects them before anything is saved |
| 2 | **Store** | Confirmed records go to Postgres; the original PDF stays in a private bucket |
| 3 | **Remember** | The record is indexed into Supermemory so related records can be found later |
| 4 | **Match** | Supermemory *retrieves* candidates; a deterministic evaluator *decides* the assessment. Retrieval similarity alone can never produce a direct match |
| 5 | **Explain** | Each connection is explained from stored facts — type, issuer, date, what the record states. Unmet criteria are shown once, at requirement level |
| 6 | **Guide** | Deterministic next steps per requirement. No model call, no course search, no prediction |
| 7 | **Report** | A saved, versioned match run renders as a print-friendly packet with the technician's own summary, issuers, verification labels, gaps and a disclaimer |

## What the labels mean

This is the heart of the product. The distinctions are enforced in code and in the database, not just in wording.

- **Assessment** — *evidence found* / *needs review* / *no sufficient evidence* / *can't assess automatically*.
  It says whether relevant **documentation** was found. Missing documentation is not missing skill.
- **Verification** — whether a *person* independently confirmed a record. A document the worker supplied is
  labelled **supplied**, never **confirmed**. AI output can never set a record to confirmed; the database blocks it.
- **Issuer** — what the record states. Not proof of authenticity. Different issuer names do not make two records
  independent of each other.
- **Technician summary** — the worker's own words, labelled as not verified.
- **Supervisor review and customer acknowledgment are not verification.** Nothing becomes *independently
  confirmed* through the app.

---

## Feature map

Everything below the line is behind a flag and **off by default**. A route whose flag is off answers `404`, as if
it did not exist.

| Feature | Flag | State |
|---|---|---|
| Evidence capture, passport, matching, reports | — | Core, always on |
| Accounts and onboarding | `SIGNUP_MODE` (`closed` default) | Shipped |
| Password reset | — | Shipped (`/forgot-password`, `/reset-password`) |
| Customer sign-off | `SIGNOFF_ENABLED` | Shipped, off |
| Supervisor review | `SUPERVISOR_REVIEW_ENABLED` | Shipped, off |
| Email delivery | `EMAIL_MODE` (`off` / `mock` / `resend`) | Shipped, off |
| **Job import** | `OPPORTUNITY_IMPORT_ENABLED` | Shipped, off — see [docs/JOB_IMPORT.txt](docs/JOB_IMPORT.txt) |
| **AI-assisted explanation** | `AI_EXPLANATIONS_ENABLED` | Shipped, off — same doc |

### Job import

Paste a listing URL or its text. TinyFish retrieves the page (QualiTrail's own server never requests the URL),
Gemini proposes requirement lines **verbatim only** — a line is dropped unless it appears word-for-word in the
listing — and the technician reviews the draft before anything becomes a job.

Assessment is **not** done by the model. `lib/server/opportunities/requirement-rules.ts` builds rules
deterministically from the employer's original wording, against a deliberately small catalog: EPA 608 (unscoped,
Universal, Type I/II/III), NATE, OSHA 10/30, heat-pump installation / startup / commissioning, commissioning,
brazing. Anything the catalog does not fully cover becomes **"Can't assess automatically"** (`cannot_assess`),
which is a stated limit, not a judgement about the person.

Priority is read from the listing's own wording and section headings, never guessed. Both the listing's priority
and the technician's override are kept and shown.

**URL safety:** http(s) only, no credentials, ports 80/443, and every A/AAAA record must be public (including
mapped/NAT64/6to4/Teredo). The returned `final_url` is re-checked, and the result is discarded if it fails.

### AI-assisted explanation

A separate, additive layer over a saved match run. It explains `cannot_assess` lines and **never** changes an
assessment, a verification status or any count.

- Eligibility conditions (duration, driving, physical, work authorization, background, education, schedule,
  negation) are **never sent to the model** — fixed clarification text only.
- Per record the model sees only: type, title, month, issuer, skills, work performed, equipment, verification
  label. Never the summary, credential numbers, original files, signatures, sign-off or review data, customer
  details, or the worker's name. Emails, phone numbers and addresses are redacted first.
- Records are referenced opaquely (`E1`, `E2`). Any reference not supplied for that line is rejected and counted.
- Text that claims a match, qualification, eligibility or verification is rejected, and the whole AI item is
  withheld with deterministic content shown instead.
- Record descriptions are **quoted from the record's own wording**, never AI-written.

---

## Quick start

```bash
npm ci
cp .env.example .env.local     # fill in real values in .env.local only — never commit it
npm run dev                    # http://localhost:3000
```

`NEXT_PUBLIC_DATA_MODE=fixtures` shows labelled sample data with no external services.
`live` uses Supabase, Supermemory and Gemini.

---

## Configuration

See `.env.example` for the full list with comments. Names only below — never values.

| Group | Variables |
|---|---|
| Data | `NEXT_PUBLIC_DATA_MODE` |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS` |
| Supermemory | `SUPERMEMORY_API_KEY`, `SUPERMEMORY_NAMESPACE_PREFIX` |
| Accounts | `SIGNUP_MODE`, `SIGNUP_ALLOWLIST`, `SIGNOFF_PEPPER` |
| Email | `EMAIL_MODE`, `APP_BASE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET` |
| Features | `SIGNOFF_ENABLED`, `SUPERVISOR_REVIEW_ENABLED` |
| Job import | `OPPORTUNITY_IMPORT_ENABLED`, `TINYFISH_API_KEY`, `TINYFISH_MODE`, `IMPORT_DAILY_LIMIT` |
| Explanations | `AI_EXPLANATIONS_ENABLED`, `AI_EXPLANATIONS_MODE`, `AI_EXPLANATIONS_DAILY_LIMIT` |

**Rules that matter:**

- Provider keys are **server-only**. Never prefix one with `NEXT_PUBLIC_`; `lib/server/config.ts` fails the config
  check if you do.
- `SIGNOFF_PEPPER` is required even with every feature off — sign-up, password reset and onboarding use it for
  rate limiting. At least 32 characters. Each environment keeps its own; changing it invalidates open invitations.
- `TINYFISH_MODE=stub`, `AI_EXPLANATIONS_MODE=stub` and `EMAIL_MODE=mock` are refused unless the setup is
  **isolated local**: not hosted, with *both* `APP_BASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` on loopback.
- `TINYFISH_API_KEY` is required whenever job import is enabled in `live` mode — **including the paste path**,
  because the gate checks configuration on every import route.

### Gemini model order

Extraction tries `gemini-3.5-flash-lite`, then `gemini-3.5-flash`, then `gemini-3.1-flash-lite`
(`lib/server/extraction/model-fallback.ts`). At most **3 attempts**; each gets at least 15 s, and up to 30 s when
the caller's budget allows. Timeouts and temporary unavailability move to the next model; invalid credentials,
invalid input and malformed output do not. If every model fails, the worker is offered manual entry.

`GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` override that order and take precedence. Leave them unset unless you
mean to override. Model availability depends on the account — check real provider behaviour, not just a listing.

---

## Pages and API

**Technician:** `/passport`, `/evidence`, `/opportunities`, `/opportunities/import/[id]`, `/reports`, `/supervisors`
**Reviewer:** `/supervisor`, `/supervisor/reviews/[id]`
**Auth:** `/sign-in`, `/sign-up`, `/onboarding`, `/forgot-password`, `/reset-password`
**Public:** `/signoff`, `/signoff/privacy`, `/invite/supervisor`

All API routes require a signed-in user unless marked public.

| Area | Routes |
|---|---|
| Evidence | `GET /api/evidence` · `GET`/`PATCH /api/evidence/[id]` (60 s signed link to the original) · `POST /api/evidence/extract` · `POST /api/evidence/confirm` · `POST /api/evidence/[id]/reindex` |
| Jobs and matching | `GET /api/opportunities` · `POST /api/jobs` · `POST /api/matches/run` · `GET /api/matches/latest` · `GET /api/matches/[id]` |
| **Job import** | `POST /api/imports` · `GET`/`PUT /api/imports/[id]` · `POST /api/imports/[id]/draft` · `POST /api/imports/[id]/confirm` |
| **Explanations** | `POST /api/matches/[id]/explanations` |
| Account | `GET /api/me` · `POST /api/onboarding` · `GET /api/attestations` |
| Sign-off (technician) | `/api/signoff/config`, `/requests`, `/requests/[id]/resend`, `/requests/[id]/revoke`, `/snapshot`, `/outbox` |
| Supervisors (technician) | `GET`/`POST /api/supervisors` · `/api/supervisors/[id]/remind` · `/revoke` · `/api/reviews` · `/api/reviews/[id]/remind` · `/revoke` |
| Supervisor (reviewer) | `/api/supervisor/dashboard` · `/invite/peek` · `/invite/answer` · `/reviews/[id]` · `/reviews/[id]/document` · `/reviews/[id]/respond` |
| Public | `POST /api/auth/signup` · `POST /api/auth/recover` · `POST /api/auth/reset-password` · `GET /auth/confirm` · customer `/api/signoff/{gate,code,verify,respond,opt-out}` (token header) · `POST /api/webhooks/resend` (signature-verified) |

Contracts live in [docs/api-contracts.md](docs/api-contracts.md).

---

## Database

Ten SQL files in `supabase/migrations/`, applied in filename order.

| File | Purpose |
|---|---|
| `20261114170000_init.sql` | Tables, RLS, verification guard, staleness triggers |
| `20261114170100_storage.sql` | Private `evidence` bucket and policies |
| `20261114180000_match_run_functions.sql` | Atomic match-run start/finalize/fail (service role only) |
| `20261114210000_evidence_integrity.sql` | Draft protections, provenance-aware versioning |
| `20261115120000_worker_summary.sql` | Optional `workers.summary` (additive, nullable) |
| `20261116100000_customer_signoff.sql` | Customer sign-off tables and service-role functions |
| `20261117090000_email_delivery.sql` | Delivery records and webhook de-duplication (no addresses or bodies) |
| `20261117100000_accounts_supervisor_review.sql` | Employment arrangement, supervisor profiles, relationships, reviews |
| `20261118100000_job_import.sql` | `opportunity_imports`, 8 RPCs, `cannot_assess`, requirement priority columns |
| `20261119100000_match_run_explanations.sql` | `match_run_explanations` and 3 RPCs |

Both of the last two are **additive**. The app reads opportunities and requirements with `select *`, so it works
before or after they are applied.

> **Do not trust this file for what is applied where.** Applied state differs per environment and drifts.
> Check it with `supabase migration list`, or a read-only query against the target.

**Rollback while unused:** `scripts/sql/rollback-job-import-if-empty.sql` and
`scripts/sql/rollback-explanations-if-empty.sql`. Both refuse to run if any related data exists.

### Migration history

If migrations were applied through the Supabase SQL editor, the CLI's history is empty even though the schema
exists. Before any `supabase db push`:

1. `supabase link`, then compare `supabase migration list` with the table above.
2. For each file already applied: `supabase migration repair --status applied <version>` (the filename's numeric prefix).
3. Only then push new migrations.

**Never replay `init.sql` against a populated project.**

---

## Demo data

Seed scripts use the service-role key and write to whatever project `.env.local` points at.
**Run them only against a development project.**

```bash
npm run seed:pdfs      # regenerate Alex Morgan's fictional PDFs (no network)
npm run seed:demo      # the original fictional worker, Alex Morgan (fixed ids)
npm run seed:index     # index that worker's records into Supermemory
```

### A separate rehearsal worker

Gets its own account, ids, memory namespace **and its own documents**. Alex's rows and PDFs are never touched.

```bash
DEMO_WORKER_SLUG=rehearsal-2 DEMO_WORKER_NAME="Sam Okafor" \
  DEMO_USER_EMAIL=sam.okafor@demo.qualitrail.dev npm run seed:demo
DEMO_WORKER_SLUG=rehearsal-2 DEMO_WORKER_NAME="Sam Okafor" npm run seed:index
```

`seed:demo` generates that worker's PDFs first and checks that every page and stored field names the right person
with that worker's own certificate numbers — it stops before writing anything if not. It then uploads the two
historical originals, hashing the real file bytes, and prints the exact path of the checklist to upload live:

```
supabase/seed/files/<slug>/                                      historical originals
supabase/seed/upload/<slug>/demo-commissioning-checklist.pdf     UPLOAD THIS ONE during the demo
```

Upload only from the worker's own `upload/<slug>/` folder. The top-level file is Alex Morgan's and names him.
Use a fresh slug, name and email for every rehearsal — nothing needs deleting. Slugs are lowercase letters,
digits and hyphens.

> ⚠️ **Reserved workers.** `rehearsal-1` (Jordan Rivera) was seeded before per-worker documents existed: its
> originals name Alex Morgan and reuse his certificate numbers, and it already shows 3 of 4. Do not use it for
> judging. `rehearsal-2` (Sam Okafor) is reserved at the 2-of-4 baseline. Use `rehearsal-3` or later.

### Runbook: 2 of 4, then 3 of 4

1. Sign in as the rehearsal worker. Passport shows four historical records and the technician summary.
2. Opportunities → **Run matching**. Expect EPA 608 and manufacturer training *evidence found*,
   installation/startup *needs review*, commissioning *no sufficient evidence* — **2 of 4**.
3. My Evidence → upload the checklist from that worker's own folder, review the extracted fields, confirm, and
   wait for "Searchable in memory".
4. **Run matching again.** Commissioning becomes *evidence found* — **3 of 4** — and a "what changed" box appears.
5. Reports → **Print or save as PDF**.

Uploading the same file twice for one worker is detected as a duplicate, which is why each rehearsal needs a
fresh worker.

### Manual testing

`manual-tests/` holds fictional evidence PDFs, job listings and typed-experience fixtures, plus a step-by-step
guide covering every feature including job import and explanations. See `manual-tests/README.md`.

---

## Testing

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Database tests need a **disposable** PostgreSQL server — they drop and recreate their own databases.
**Never point them at shared data.** Without `TEST_DATABASE_ADMIN_URL` they are skipped, not failed.

```bash
docker run -d --name qualitrail-test-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:16
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test
docker rm -f qualitrail-test-pg
```

For the Supabase CLI stack use port 54322 instead. Integration tests needing Supabase APIs run only against the
local stack (`TEST_SUPABASE_URL`, `TEST_SUPABASE_PUBLISHABLE_KEY`, `TEST_SUPABASE_SECRET_KEY` from
`npx supabase status`; they refuse non-local URLs) and are otherwise skipped.

### Local browser journeys (isolated local Supabase)

```bash
npx supabase start     # Docker: Postgres, Auth, Storage, Mailpit. Applies all migrations.

# Build and start the app on :3100 with LOCAL values only (no provider keys):
#   NEXT_PUBLIC_DATA_MODE=live + the three Supabase values from `npx supabase status`
#   SIGNOFF_ENABLED=true SUPERVISOR_REVIEW_ENABLED=true EMAIL_MODE=mock APP_BASE_URL=http://localhost:3100
#   SIGNOFF_PEPPER=<random 40+ chars> SIGNUP_MODE=allowlist SIGNUP_ALLOWLIST=@test.qualitrail.dev

E2E_APP_DIR=<app dir> E2E_SERVER_LOG=<server log> node scripts/e2e-local.mjs   # refuses non-local Supabase

# Features off, release tables absent:
#   npx supabase db reset --local --version 20261115120000, restart with both flags false and EMAIL_MODE=off,
#   node scripts/e2e-degraded.mjs, then `npx supabase db reset --local` to restore.

# Job import (stub listings, no providers): OPPORTUNITY_IMPORT_ENABLED=true TINYFISH_MODE=stub
#   GEMINI_API_KEY=<placeholder>, then: npx tsx scripts/e2e-import.mts
#   Flag-off checks:                     npx tsx scripts/e2e-import.mts flag-off
#   Explanations (AI_EXPLANATIONS_ENABLED=true AI_EXPLANATIONS_MODE=stub): npx tsx scripts/e2e-import.mts explain

npx supabase stop
```

`supabase/config.toml` is for the local stack only. **Never run `supabase config push`** — it would overwrite
hosted Auth settings with localhost values.

---

## Deployment

Deployed on Vercel. `vercel.json` disables deployments for `feature/*` branches, so only `main` ships.

Before and after each release:

- Set server-only variables in the host's settings, not in Git. `NEXT_PUBLIC_DATA_MODE=live`.
- Check the hosted environment for `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` — if present they override the defaults.
- Supabase Auth: site URL and redirect URLs must point at the hosted domain.
- Extraction can take ~45 s (three attempts). `maxDuration = 120` is set on `/api/imports`,
  `/api/imports/[id]/draft` and `/api/matches/[id]/explanations`; other routes use the platform default.
- Confirm which migrations the hosted project actually has before enabling a flag that needs one.
- Rotate any key ever pasted into chat or shared outside the host's settings.
- Run the acceptance journey and keep recorded evidence before claiming it works.

---

## Limits and known gaps

**By design**

- Matching rules cover the seeded heat-pump requirements plus a small explicit catalog for imported postings.
  Most real listings will show several "Can't assess automatically" lines.
- Supervisor review and customer acknowledgment are deliberately **not** verification. There is no issuer workflow.
- Nothing can be deleted. Only work records and checklists that are self-reported or document-supplied can be
  edited; certifications, training and independently-confirmed records cannot.
- Sign-up is invite-only by default.

**Not done yet**

- Job import and explanations have **not been exercised against live TinyFish or live Gemini drafting** at the
  time of writing — see §Limitations in [docs/JOB_IMPORT.txt](docs/JOB_IMPORT.txt) and reconcile it against the
  handoff notes before trusting either in production.
- No organization or employer accounts.
- Listing refresh / supersede (`supersedes_id`) is not implemented. No scheduled purge of expired drafts.
- The 90-day retention purge is written but pg_cron scheduling is proposed, not enabled. It removes customer
  contact data, comments, codes and sessions, and **keeps the typed signature** with the decision and snapshot,
  because the signature *is* the acknowledgment.
- Long provider outages degrade to manual capture and honest "unavailable" states, but outage behaviour has not
  been exhaustively failure-injected.
