# QualiTrail

QualiTrail helps HVAC technicians turn scattered certificates, training and work records into an **evidence passport**, match that evidence against a job's requirements, and print a **qualification packet**. It never decides that someone is qualified: it shows what the documents say, what is missing, and what a person still needs to review.

All demo people, employers, documents and the demo job are **fictional** and labelled as such.

## What it does

1. **Capture** a record by PDF upload or typed text. Gemini extracts structured fields; the worker reviews and corrects them before anything is saved.
2. **Store** the confirmed record in Postgres, with the original PDF kept in a private bucket.
3. **Remember** it: the record is indexed into Supermemory so related records can be found later.
4. **Match** the worker's evidence against a job's requirements. Retrieval (Supermemory) finds candidates; a deterministic evaluator decides the assessment.
5. **Explain** each connection from stored facts (type, issuer, date, what the record states) and show unmet criteria once, at requirement level.
6. **Report**: a saved, versioned match run is rendered as a print-friendly packet with the technician's own summary, issuers, verification labels, gaps and a disclaimer.

### What the labels mean

- **Assessment** (evidence found / needs review / no sufficient evidence) says whether relevant documentation was found. Missing documentation is not missing skill.
- **Verification** says whether a person independently confirmed a record. A document the worker supplied is labelled *supplied*, not *confirmed*. AI output can never set a record to confirmed (enforced in the database).
- An issuer name on a record is what the record states. It is not proof of authenticity, and different issuer names do not make records independent.
- The technician summary is the worker's own words and is labelled as not verified.

## Stack

Next.js 16 (App Router), React 19, Supabase (Postgres, Auth, private Storage), Supermemory, Google Gemini, Zod, Vitest.

## Pages and API

Pages: `/passport`, `/evidence`, `/opportunities`, `/reports`, `/supervisors` (technician), `/supervisor` and `/supervisor/reviews/[id]` (reviewer), `/sign-in`, `/sign-up`, `/onboarding`; public: `/signoff`, `/signoff/privacy`, `/invite/supervisor`.

API (all require a signed-in user): `GET /api/evidence`, `GET /api/evidence/[id]` (60-second signed link to the original), `POST /api/evidence/extract`, `POST /api/evidence/confirm`, `POST /api/evidence/[id]/reindex`, `GET /api/opportunities`, `POST /api/matches/run`, `GET /api/matches/latest`, `GET /api/matches/[id]`, `PATCH /api/evidence/[id]`, `POST /api/jobs`, `GET /api/attestations`, `GET /api/me`, `POST /api/onboarding`, the sign-off, supervisor and review routes listed in [the release notes](docs/release-accounts-signoff-review.md). Public: `POST /api/auth/signup`, `GET /auth/confirm`, the customer `/api/signoff/*` routes (token header), `POST /api/webhooks/resend` (signature-verified).

## Setup

```bash
npm ci
cp .env.example .env.local     # then fill in real values in .env.local only
npm run dev                    # http://localhost:3000
```

`NEXT_PUBLIC_DATA_MODE=fixtures` shows labelled sample data with no services. `live` uses Supabase, Supermemory and Gemini.

### Environment variables (names only)

See `.env.example`. Provider keys (`SUPABASE_SECRET_KEY`, `GEMINI_API_KEY`, `SUPERMEMORY_API_KEY`) are server-only and must never be prefixed `NEXT_PUBLIC_`. Never commit `.env.local`. `GEMINI_MODEL` and `GEMINI_FALLBACK_MODELS` override the built-in model order and, if set, take precedence over it; leave them unset unless you mean to override.

### Gemini model order

By default extraction tries `gemini-3.5-flash-lite`, then `gemini-3.5-flash`, then `gemini-3.1-flash-lite`. Each model is attempted once with a 15-second deadline, at most three attempts. Timeouts and temporary unavailability move to the next model; invalid credentials, invalid input and malformed output do not. If every model fails, the worker is offered manual entry. Model availability depends on the account, so check actual provider behavior and not only a model listing.

### Database

Eight SQL files in `supabase/migrations/`, applied in filename order:

| File | Purpose |
|---|---|
| `20261114170000_init.sql` | Tables, row-level security, verification guard, staleness triggers |
| `20261114170100_storage.sql` | Private `evidence` bucket and policies |
| `20261114180000_match_run_functions.sql` | Atomic match-run start/finalize/fail (service role only), privilege hardening |
| `20261114210000_evidence_integrity.sql` | Draft protections, provenance-aware versioning, staleness on leaving indexed |
| `20261115120000_worker_summary.sql` | Optional `workers.summary` (additive, nullable) |
| `20261116100000_customer_signoff.sql` | Customer sign-off tables and service-role functions. **Not applied to any shared project yet.** |
| `20261117090000_email_delivery.sql` | Email delivery records and webhook de-duplication (no addresses or bodies). **Not applied yet.** |
| `20261117100000_accounts_supervisor_review.sql` | Employment arrangement, supervisor profiles, relationships and reviews. **Not applied yet.** |

The summary migration is optional for the app to run: if the column is absent the summary simply does not show, and sign-in and matching are unaffected. Apply it before seeding a synthetic worker, which writes a summary.

### Migration history guidance

If migrations were applied through the Supabase SQL editor, the CLI's migration history is empty even though the schema exists. Before any `supabase db push`:

1. Link the project (`supabase link`) and compare `supabase migration list` with the files above.
2. For each file already applied, mark it applied with `supabase migration repair --status applied <version>`, where `<version>` is the filename's numeric prefix.
3. Only then push new migrations.

Never replay `init.sql` against a populated project. Check what is installed with a read-only query before deciding.

### Demo data

Seed scripts use the service-role key and write to whatever project `.env.local` points at. Run them only against a development project.

```bash
npm run seed:pdfs      # regenerate Alex Morgan's fictional PDFs (no network); see below for other workers
npm run seed:demo      # original fictional worker, Alex Morgan (fixed ids)
npm run seed:index     # index that worker's records into Supermemory
```

A **new, separate fictional worker** for rehearsals gets its own account, ids, memory namespace **and its own documents**. Alex's rows and original PDFs are never touched.

```bash
DEMO_WORKER_SLUG=rehearsal-2 DEMO_WORKER_NAME="Sam Okafor" \
DEMO_USER_EMAIL=sam.okafor@demo.qualitrail.dev npm run seed:demo
DEMO_WORKER_SLUG=rehearsal-2 DEMO_WORKER_NAME="Sam Okafor" npm run seed:index
```

`seed:demo` first generates that worker's PDFs and checks that every page and every stored field names the right person and carries that worker's own certificate numbers (it stops before writing anything if not). It then uploads the worker's two historical originals, hashing the actual file bytes, and prints the exact path of the checklist to upload live:

```
supabase/seed/files/<slug>/                 historical originals (training certificate, EPA 608 card)
supabase/seed/upload/<slug>/demo-commissioning-checklist.pdf    UPLOAD THIS ONE during the demonstration
```

Upload only the checklist from the worker's own `upload/<slug>/` folder. The top-level `supabase/seed/upload/demo-commissioning-checklist.pdf` is Alex Morgan's and names him. To (re)generate documents without seeding: `DEMO_WORKER_SLUG=... DEMO_WORKER_NAME="..." npm run seed:pdfs`. The per-worker folders are generated, git-ignored files.

Use a new slug, name and email for every rehearsal; nothing needs deleting or resetting. Slugs are lowercase letters, digits and hyphens.

**Rehearsal workers already in the development project.** `rehearsal-1` (Jordan Rivera) was seeded before per-worker documents existed: its stored originals and checklist name Alex Morgan and reuse Alex's certificate numbers, and it already shows 3 of 4. Do not use it for judging or for a 2-of-4 start. Use `rehearsal-2` or a later slug.

### Demo runbook: 2 of 4, then 3 of 4

1. Sign in as the rehearsal worker. Passport shows four historical records and the technician summary.
2. Opportunities, **Run matching**. Expect EPA 608 and manufacturer training *evidence found*, installation/startup *needs review*, commissioning checklist *no sufficient evidence* (2 of 4).
3. My Evidence, upload the checklist from that worker's own folder, `supabase/seed/upload/<slug>/demo-commissioning-checklist.pdf` (the exact path is printed by `seed:demo`), review the extracted fields, confirm, wait for "Searchable in memory".
4. **Run matching again.** Commissioning becomes *evidence found* (3 of 4) and a "what changed" box appears.
5. Reports, **Print or save as PDF**.

Uploading the same file twice for one worker is detected as a duplicate, which is why each rehearsal uses a fresh worker.

## Tests

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Database tests need a **disposable** PostgreSQL server; they drop and recreate their own databases. Never point them at shared data.

```bash
docker run -d --name qualitrail-test-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:16
TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test
docker rm -f qualitrail-test-pg
```

Without `TEST_DATABASE_ADMIN_URL` the database tests are skipped, not failed. Integration tests that need Supabase APIs run only against the local stack (`TEST_SUPABASE_URL`, `TEST_SUPABASE_PUBLISHABLE_KEY`, `TEST_SUPABASE_SECRET_KEY` from `npx supabase status`; they refuse non-local URLs) and are otherwise skipped.

## Accounts, completed jobs, customer sign-off and supervisor review

All of it is off by default and behind flags; full design, authorization model, retention table, external setup and the hosted acceptance checklist are in [docs/release-accounts-signoff-review.md](docs/release-accounts-signoff-review.md). In short:

- **Accounts.** `SIGNUP_MODE` is `closed` (default: only invited supervisors can register), `allowlist` or `open`; email confirmation is required and the policy is enforced again at onboarding. One account can be a technician, a reviewer, or both. A role grants no access to anyone else's records.
- **Completed jobs** are ordinary work records (self-reported, or document supplied with a PDF), indexed and matched like any other.
- **Customer sign-off**: a link opens only a gate; details need a single-use code sent to the address the technician provided. Label: *"Customer acknowledged on <date>. A code sent to the email address the worker provided was entered. Neither the customer's identity nor the work is independently verified."* Simulated email is always labelled simulated.
- **Supervisor review**: accepted only by a confirmed account with the invited email, never the technician's own. Labels say exactly what was said: *"Supervisor confirmed observing these tasks: …"* or *"Supervisor reviewed supporting documentation"* (and that it did not observe the work or confirm authenticity). Not certification.
- None of this changes `verification_status` or a qualification assessment. Edits supersede open requests; completed ones show "Changed since…". Packets never show a customer address or typed signature.
- **Retention.** The 90-day purge removes customer contact data and comments, codes and sessions. It **keeps the typed signature** (personal information, kept because it is the acknowledgment) with the decision and snapshot. Scheduling via pg_cron is proposed, not enabled.

### Local browser journeys (isolated local Supabase)

```bash
npx supabase start                        # Docker; local Postgres, Auth, Storage, Mailpit. Applies all migrations.
# Build and start the app on :3100 with LOCAL values only (no provider keys), e.g. from a separate worktree with no .env.local:
#   NEXT_PUBLIC_DATA_MODE=live NEXT_PUBLIC_SUPABASE_URL/..._PUBLISHABLE_KEY/SUPABASE_SECRET_KEY from `npx supabase status`
#   SIGNOFF_ENABLED=true SUPERVISOR_REVIEW_ENABLED=true EMAIL_MODE=mock APP_BASE_URL=http://localhost:3100
#   SIGNOFF_PEPPER=<random 40+ chars> SIGNUP_MODE=allowlist SIGNUP_ALLOWLIST=@test.qualitrail.dev
E2E_APP_DIR=<app dir> E2E_SERVER_LOG=<server log> node scripts/e2e-local.mjs   # refuses non-local Supabase URLs
npx supabase stop
```

`supabase/config.toml` is for the local stack only and changes no hosted setting.

## Deployment checklist

Not deployed yet. Before hosting, and after approval of each action:

- Set server-only variables in the host's settings (not in Git) and `NEXT_PUBLIC_DATA_MODE=live`.
- Check the hosted environment for `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS`: if present they override the default order.
- Supabase Auth: set the site URL and redirect URLs to the hosted domain.
- Extraction can take up to about 45 seconds (three 15-second attempts), so confirm the host's function time limit. No `maxDuration` is configured yet.
- Rotate any keys that were ever pasted into chat or shared outside the host's settings.
- Run the hosted acceptance journey above and keep recorded evidence before claiming it works.

## Limits

- Matching rules are written for the seeded heat-pump requirements; arbitrary job postings are not supported yet.
- Work records and checklists can be edited; certifications, training and other types cannot yet, records that are independently confirmed cannot be edited, and nothing can be deleted.
- Supervisor review and customer acknowledgment are deliberately not verification: nothing becomes *independently confirmed* through the app, and there is no issuer workflow.
- Sign-up is invite-only by default (`SIGNUP_MODE`); there is no password-reset page yet. No organization or employer accounts.
- Long provider outages degrade to manual capture and honest "unavailable" states; outage behavior has not been exhaustively failure-injected.
