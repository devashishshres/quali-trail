/**
 * Database integrity + security tests. Runs the REAL migrations on a
 * throwaway PostgreSQL database (with Supabase stubs) and checks the
 * rules the product depends on.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx vitest run tests/db
 *
 * Skipped automatically when TEST_DATABASE_ADMIN_URL is not set.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_EVIDENCE, DEMO_WORKER } from "../../supabase/seed/demo-data";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_test";
const ROOT = join(__dirname, "..", "..");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ALEX_AUTH = randomUUID();
const OTHER_AUTH = randomUUID();
const OTHER_WORKER = randomUUID();
const OTHER_EVIDENCE = randomUUID();
const OPPORTUNITY = randomUUID();
const REQUIREMENT = randomUUID();

let db: Client;

/** Run `fn` inside a transaction as an authenticated Supabase user, then roll back. */
async function asUser<T>(authUserId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${authUserId ? "authenticated" : "anon"}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [authUserId ?? ""]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}


/**
 * Run `fn` as the trusted server (service_role), inside a transaction rolled back after.
 * Evidence system columns and match tables are server-written only: signed-in
 * clients are deliberately denied (see migration 20261114180000).
 */
async function asServer<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("set local role service_role");
    return await fn();
  } finally {
    await db.query("rollback");
  }
}

/** Expect a query to fail with a specific Postgres error code. */
async function expectPgError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe.skipIf(!ADMIN_URL)("database schema", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB_NAME}`);
    await admin.query(`create database ${DB_NAME}`);
    await admin.end();

    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB_NAME}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();

    await db.query(readFileSync(join(ROOT, "tests/db/supabase-stubs.sql"), "utf8"));
    const migrationsDir = join(ROOT, "supabase/migrations");
    for (const file of readdirSync(migrationsDir).sort()) {
      await db.query(readFileSync(join(migrationsDir, file), "utf8"));
    }

    // Seed (as superuser, like the service-role seed script).
    await db.query("insert into auth.users (id) values ($1), ($2)", [ALEX_AUTH, OTHER_AUTH]);
    await db.query(
      "insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,$3,$4,true), ($5,$6,'Other Worker','HVAC',true)",
      [DEMO_WORKER.id, ALEX_AUTH, DEMO_WORKER.name, DEMO_WORKER.trade, OTHER_WORKER, OTHER_AUTH],
    );
    for (const e of DEMO_EVIDENCE) {
      await db.query(
        `insert into public.evidence (id, worker_id, type, title, source_date, issuer, structured_data,
           source_kind, file_hash, verification_status, is_synthetic)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
        [e.id, DEMO_WORKER.id, e.type, e.title, e.date, e.issuer, e.structuredData, e.sourceKind,
         sha(`seed:${e.id}`), e.verificationStatus],
      );
    }
    await db.query(
      `insert into public.evidence (id, worker_id, type, title, source_kind, file_hash)
       values ($1,$2,'training','Other worker training','seed',$3)`,
      [OTHER_EVIDENCE, OTHER_WORKER, sha("other")],
    );
    await db.query(
      "insert into public.opportunities (id, worker_id, title, employer) values ($1,$2,'Job','Demo HVAC Company')",
      [OPPORTUNITY, DEMO_WORKER.id],
    );
    await db.query(
      `insert into public.requirements (id, opportunity_id, position, original_text, criteria_json, source)
       values ($1,$2,0,'EPA 608','{}','test')`,
      [REQUIREMENT, OPPORTUNITY],
    );
  });

  afterAll(async () => {
    await db?.end();
  });

  it("migrations and seed applied: Alex has 4 evidence records", async () => {
    const { rows } = await db.query("select count(*)::int as n from public.evidence where worker_id = $1", [
      DEMO_WORKER.id,
    ]);
    expect(rows[0].n).toBe(4);
  });

  it("RLS: a worker sees only their own evidence", async () => {
    const alex = await asUser(ALEX_AUTH, () => db.query("select worker_id from public.evidence"));
    expect(alex.rows).toHaveLength(4);
    expect(new Set(alex.rows.map((r) => r.worker_id))).toEqual(new Set([DEMO_WORKER.id]));

    const other = await asUser(OTHER_AUTH, () => db.query("select id from public.evidence"));
    expect(other.rows.map((r) => r.id)).toEqual([OTHER_EVIDENCE]);
  });

  it("RLS: a worker cannot insert evidence for someone else", async () => {
    await asUser(OTHER_AUTH, () =>
      expectPgError(
        db.query(
          "insert into public.evidence (worker_id, type, title, source_kind, file_hash) values ($1,'other','x','manual_text',$2)",
          [DEMO_WORKER.id, sha("x")],
        ),
        "42501",
      ),
    );
  });

  it("RLS: anonymous users cannot read anything", async () => {
    await asUser(null, () => expectPgError(db.query("select * from public.evidence"), "42501"));
  });

  it("duplicate content for the same worker is rejected", async () => {
    await asServer(() =>
      expectPgError(
        db.query(
          "insert into public.evidence (worker_id, type, title, source_kind, file_hash) values ($1,'other','dup','manual_text',$2)",
          [DEMO_WORKER.id, sha(`seed:${DEMO_EVIDENCE[0].id}`)],
        ),
        "23505",
      ),
    );
  });

  it("independently_confirmed cannot be set without a human verification event", async () => {
    const id = DEMO_EVIDENCE[2].id; // EPA 608
    await asServer(() =>
      expectPgError(
        db.query("update public.evidence set verification_status = 'independently_confirmed' where id = $1", [id]),
        "23514",
      ),
    );
    await asServer(() =>
      expectPgError(
        db.query(
          `insert into public.evidence (worker_id, type, title, source_kind, file_hash, verification_status)
           values ($1,'certification','fake','manual_text',$2,'independently_confirmed')`,
          [DEMO_WORKER.id, sha("fake")],
        ),
        "23514",
      ),
    );
  });

  it("a worker cannot write verification events (only the server can)", async () => {
    await asUser(ALEX_AUTH, () =>
      expectPgError(
        db.query(
          "insert into public.verification_events (evidence_id, reviewer_id, decision) values ($1,$2,'confirmed')",
          [DEMO_EVIDENCE[2].id, ALEX_AUTH],
        ),
        "42501",
      ),
    );
  });

  it("after a confirmed verification event, the status can be set", async () => {
    await db.query("begin");
    try {
      const id = DEMO_EVIDENCE[2].id;
      await db.query(
        "insert into public.verification_events (evidence_id, reviewer_id, decision) values ($1,$2,'confirmed')",
        [id, OTHER_AUTH],
      );
      const { rows } = await db.query(
        "update public.evidence set verification_status = 'independently_confirmed' where id = $1 returning verification_status",
        [id],
      );
      expect(rows[0].verification_status).toBe("independently_confirmed");
    } finally {
      await db.query("rollback");
    }
  });

  it("editing evidence bumps version, resets indexing and marks completed match runs stale", async () => {
    await asServer(async () => {
      const id = DEMO_EVIDENCE[0].id;
      await db.query("update public.evidence set index_status = 'indexed' where id = $1", [id]);

      const before = await db.query("select evidence_revision from public.workers where id = $1", [DEMO_WORKER.id]);
      const run = await db.query(
        `insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status)
         values ($1,$2,$3,'completed') returning id`,
        [DEMO_WORKER.id, OPPORTUNITY, before.rows[0].evidence_revision],
      );

      const updated = await db.query(
        "update public.evidence set title = 'Edited title' where id = $1 returning version, index_status",
        [id],
      );
      expect(updated.rows[0]).toEqual({ version: 2, index_status: "pending" });

      const after = await db.query("select evidence_revision from public.workers where id = $1", [DEMO_WORKER.id]);
      expect(Number(after.rows[0].evidence_revision)).toBeGreaterThan(Number(before.rows[0].evidence_revision));

      const status = await db.query("select status from public.match_runs where id = $1", [run.rows[0].id]);
      expect(status.rows[0].status).toBe("stale");
    });
  });

  it("changing only index status does not bump the evidence version", async () => {
    await asServer(async () => {
      const { rows } = await db.query(
        "update public.evidence set index_status = 'processing' where id = $1 returning version",
        [DEMO_EVIDENCE[1].id],
      );
      expect(rows[0].version).toBe(1);
    });
  });

  it("adding new evidence marks completed runs stale", async () => {
    await asServer(async () => {
      const run = await db.query(
        "insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status) values ($1,$2,0,'completed') returning id",
        [DEMO_WORKER.id, OPPORTUNITY],
      );
      await db.query(
        "insert into public.evidence (worker_id, type, title, source_kind, file_hash) values ($1,'checklist','Commissioning checklist','manual_text',$2)",
        [DEMO_WORKER.id, sha("checklist")],
      );
      const status = await db.query("select status from public.match_runs where id = $1", [run.rows[0].id]);
      expect(status.rows[0].status).toBe("stale");
    });
  });

  it("a match cannot link another worker's evidence", async () => {
    await db.query("begin");
    try {
      const run = await db.query(
        "insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status) values ($1,$2,0,'completed') returning id",
        [DEMO_WORKER.id, OPPORTUNITY],
      );
      await expectPgError(
        db.query(
          "insert into public.evidence_matches (match_run_id, worker_id, requirement_id, evidence_id, role) values ($1,$2,$3,$4,'direct')",
          [run.rows[0].id, DEMO_WORKER.id, REQUIREMENT, OTHER_EVIDENCE],
        ),
        "23503",
      );
    } finally {
      await db.query("rollback");
    }
  });

  it("the same evidence cannot count twice for one requirement in one run", async () => {
    await db.query("begin");
    try {
      const run = await db.query(
        "insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status) values ($1,$2,0,'completed') returning id",
        [DEMO_WORKER.id, OPPORTUNITY],
      );
      const insert = () =>
        db.query(
          "insert into public.evidence_matches (match_run_id, worker_id, requirement_id, evidence_id, role) values ($1,$2,$3,$4,'direct')",
          [run.rows[0].id, DEMO_WORKER.id, REQUIREMENT, DEMO_EVIDENCE[2].id],
        );
      await insert();
      await expectPgError(insert(), "23505");
    } finally {
      await db.query("rollback");
    }
  });

  it("storage: users can only upload into their own folder", async () => {
    await asUser(ALEX_AUTH, async () => {
      await db.query("insert into storage.objects (bucket_id, name) values ('evidence', $1)", [`${ALEX_AUTH}/a.pdf`]);
      await expectPgError(
        db.query("insert into storage.objects (bucket_id, name) values ('evidence', $1)", [`${OTHER_AUTH}/b.pdf`]),
        "42501",
      );
    });
  });

  it("storage bucket is private", async () => {
    const { rows } = await db.query("select public from storage.buckets where id = 'evidence'");
    expect(rows[0].public).toBe(false);
  });
});
