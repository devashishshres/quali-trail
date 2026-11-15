/**
 * Match-run lifecycle, authoritative writes and concurrency.
 * Needs a DISPOSABLE PostgreSQL server. It drops and recreates its own
 * database `qualitrail_match_test`. Never point it at shared or production data.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx vitest run tests/db
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_EVIDENCE, DEMO_OPPORTUNITY, DEMO_REQUIREMENTS, DEMO_WORKER } from "../../supabase/seed/demo-data";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_match_test";
const ROOT = join(__dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ALEX_AUTH = randomUUID();
const OTHER_AUTH = randomUUID();
const OTHER_WORKER = randomUUID();
const OTHER_EVIDENCE = randomUUID();
const OTHER_OPP = randomUUID();
const OTHER_REQ = randomUUID();
const R = DEMO_REQUIREMENTS.map((r) => r.id);
const E = DEMO_EVIDENCE.map((e) => e.id);

let url: string;
let db: Client;
const clients: Client[] = [];

async function newClient(): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
}

/** Call a service-role-only function the way the Next.js server does. */
async function asService<T>(c: Client, fn: () => Promise<T>): Promise<T> {
  await c.query("set role service_role");
  try {
    return await fn();
  } finally {
    await c.query("reset role");
  }
}

const start = (c: Client, worker: string = DEMO_WORKER.id, opp: string = DEMO_OPPORTUNITY.id) =>
  asService(c, async () => (await c.query("select * from public.start_match_run($1,$2)", [worker, opp])).rows[0]);

const results = (assessment = "no_sufficient_evidence") =>
  JSON.stringify(R.map((id) => ({ requirement_id: id, assessment, explanation: "x", uncertainties: ["u"], missing_documentation: [] })));
const matches = (items: object[] = []) => JSON.stringify(items);

const finalize = (c: Client, runId: string, res = results(), mat = matches(), worker: string = DEMO_WORKER.id) =>
  asService(c, async () =>
    (await c.query("select public.finalize_match_run($1,$2,$3::jsonb,$4::jsonb,null) as s", [worker, runId, res, mat])).rows[0].s as string,
  );

const status = async (id: string) => (await db.query("select status from public.match_runs where id=$1", [id])).rows[0].status as string;

async function addEvidence(c: Client, title: string) {
  await c.query(
    `insert into public.evidence (worker_id, type, title, source_kind, file_hash) values ($1,'checklist',$2,'seed',$3)`,
    [DEMO_WORKER.id, title, sha(title + Math.random())],
  );
}

describe.skipIf(!ADMIN_URL)("match runs (database)", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin.query(`create database ${DB_NAME}`);
    await admin.end();
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${DB_NAME}`;
    url = u.toString();
    db = await newClient();

    await db.query(readFileSync(join(ROOT, "tests/db/supabase-stubs.sql"), "utf8"));
    for (const f of readdirSync(join(ROOT, "supabase/migrations")).sort()) {
      await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
    }
    await db.query("insert into auth.users (id) values ($1), ($2)", [ALEX_AUTH, OTHER_AUTH]);
    await db.query(
      "insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,$3,$4,true), ($5,$6,'Other','HVAC',true)",
      [DEMO_WORKER.id, ALEX_AUTH, DEMO_WORKER.name, DEMO_WORKER.trade, OTHER_WORKER, OTHER_AUTH],
    );
    for (const e of DEMO_EVIDENCE) {
      await db.query(
        `insert into public.evidence (id, worker_id, type, title, source_date, issuer, structured_data, source_kind, file_hash, verification_status, is_synthetic)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
        [e.id, DEMO_WORKER.id, e.type, e.title, e.date, e.issuer, e.structuredData, e.sourceKind, sha(`seed:${e.id}`), e.verificationStatus],
      );
    }
    await db.query("insert into public.evidence (id, worker_id, type, title, source_kind, file_hash) values ($1,$2,'training','Other','seed',$3)", [OTHER_EVIDENCE, OTHER_WORKER, sha("o")]);
    await db.query("insert into public.opportunities (id, worker_id, title, employer) values ($1,$2,'Job','Demo'), ($3,$4,'Other job','Demo')", [DEMO_OPPORTUNITY.id, DEMO_WORKER.id, OTHER_OPP, OTHER_WORKER]);
    for (const r of DEMO_REQUIREMENTS) {
      await db.query("insert into public.requirements (id, opportunity_id, position, original_text, criteria_json, source) values ($1,$2,$3,$4,$5,'test')", [r.id, DEMO_OPPORTUNITY.id, r.position, r.originalText, r.criteria]);
    }
    await db.query("insert into public.requirements (id, opportunity_id, position, original_text, criteria_json, source) values ($1,$2,0,'Other req','{}','test')", [OTHER_REQ, OTHER_OPP]);
  });

  it("start captures the current evidence revision", async () => {
    const rev = (await db.query("select evidence_revision from public.workers where id=$1", [DEMO_WORKER.id])).rows[0].evidence_revision;
    const run = await start(db);
    expect(String(run.evidence_revision)).toBe(String(rev));
    expect(await status(run.id)).toBe("processing");
    await finalize(db, run.id);
  });

  it("finalize writes results and matches and completes the run", async () => {
    const run = await start(db);
    const m = matches([{ requirement_id: R[0], evidence_id: E[2], role: "direct", contribution: "c", relevance_explanation: "r", memory_similarity: 0.88 }]);
    expect(await finalize(db, run.id, results("evidence_found"), m)).toBe("completed");
    expect(await status(run.id)).toBe("completed");
    expect((await db.query("select count(*)::int n from public.requirement_results where match_run_id=$1", [run.id])).rows[0].n).toBe(4);
    expect((await db.query("select count(*)::int n from public.evidence_matches where match_run_id=$1", [run.id])).rows[0].n).toBe(1);
  });

  it("losing indexed status invalidates a completed run", async () => {
    await db.query("update public.evidence set index_status='indexed' where id=$1", [E[0]]);
    const run = await start(db);
    await finalize(db, run.id);
    await db.query("update public.evidence set index_status='failed' where id=$1", [E[0]]);
    expect(await status(run.id)).toBe("stale");
  });

  it("changing original-source provenance invalidates the saved report", async () => {
    const run = await start(db);
    await finalize(db, run.id);
    await db.query("update public.evidence set storage_path='fictional/new-original.pdf' where id=$1", [E[0]]);
    expect(await status(run.id)).toBe("stale");
  });

  it("a second concurrent run for the same job is refused while one is processing", async () => {
    const run = await start(db);
    await expect(start(await newClient())).rejects.toMatchObject({ code: "55P03" });
    await finalize(db, run.id);
  });

  it("an abandoned processing run is recovered as failed, allowing a new run", async () => {
    const run = await start(db);
    await db.query("update public.match_runs set created_at = now() - interval '10 minutes' where id=$1", [run.id]);
    const next = await start(db);
    expect(await status(run.id)).toBe("failed");
    await finalize(db, next.id);
  });

  it("cannot start a run for another worker's opportunity", async () => {
    await expect(start(db, DEMO_WORKER.id, OTHER_OPP)).rejects.toMatchObject({ code: "P0002" });
  });

  it("cannot finalize another worker's run", async () => {
    const run = await start(db);
    await expect(finalize(db, run.id, results(), matches(), OTHER_WORKER)).rejects.toMatchObject({ code: "P0002" });
    await finalize(db, run.id);
  });

  it("rejects results that do not cover exactly this opportunity's requirements", async () => {
    const run = await start(db);
    const partial = JSON.stringify([{ requirement_id: R[0], assessment: "evidence_found" }]);
    await expect(finalize(db, run.id, partial)).rejects.toMatchObject({ code: "23514" });
    const foreign = JSON.stringify([...JSON.parse(results()).slice(0, 3), { requirement_id: OTHER_REQ, assessment: "evidence_found" }]);
    await expect(finalize(db, run.id, foreign)).rejects.toMatchObject({ code: "23514" });
    expect(await status(run.id)).toBe("processing"); // nothing half-written
    expect((await db.query("select count(*)::int n from public.requirement_results where match_run_id=$1", [run.id])).rows[0].n).toBe(0);
    await finalize(db, run.id);
  });

  it("rejects a match pointing at another opportunity's requirement or another worker's evidence", async () => {
    const run = await start(db);
    const badReq = matches([{ requirement_id: OTHER_REQ, evidence_id: E[0], role: "direct" }]);
    await expect(finalize(db, run.id, results(), badReq)).rejects.toMatchObject({ code: "23514" });
    const foreignEv = matches([{ requirement_id: R[0], evidence_id: OTHER_EVIDENCE, role: "direct" }]);
    await expect(finalize(db, run.id, results(), foreignEv)).rejects.toMatchObject({ code: "23503" });
    expect((await db.query("select count(*)::int n from public.requirement_results where match_run_id=$1", [run.id])).rows[0].n).toBe(0);
    await finalize(db, run.id);
  });

  it("a finished run cannot be finalized twice", async () => {
    const run = await start(db);
    await finalize(db, run.id);
    await expect(finalize(db, run.id)).rejects.toMatchObject({ code: "23514" });
  });

  it("evidence changed BEFORE finalize: the run ends stale, with no results", async () => {
    const run = await start(db);
    await addEvidence(db, "added during processing");
    expect(await finalize(db, run.id, results("evidence_found"))).toBe("stale");
    expect(await status(run.id)).toBe("stale");
    expect((await db.query("select count(*)::int n from public.requirement_results where match_run_id=$1", [run.id])).rows[0].n).toBe(0);
  });

  it("evidence change committing WHILE finalize waits: the run ends stale", async () => {
    const run = await start(db);
    const writer = await newClient();
    await writer.query("begin");
    await addEvidence(writer, "uncommitted change"); // holds the worker row lock
    const finalizing = finalize(await newClient(), run.id, results("evidence_found")); // blocks on the lock
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("commit");
    expect(await finalizing).toBe("stale");
    expect(await status(run.id)).toBe("stale");
  });

  it("evidence change arriving WHILE finalize holds its lock: completed run is then marked stale", async () => {
    const run = await start(db);
    const fin = await newClient();
    await fin.query("set role service_role");
    await fin.query("begin");
    const s = (await fin.query("select public.finalize_match_run($1,$2,$3::jsonb,$4::jsonb,null) as s", [DEMO_WORKER.id, run.id, results("evidence_found"), matches()])).rows[0].s;
    expect(s).toBe("completed");
    const writing = addEvidence(await newClient(), "arrives mid-finalize"); // blocks until fin commits
    await new Promise((r) => setTimeout(r, 400));
    await fin.query("commit");
    await fin.query("reset role");
    await writing;
    expect(await status(run.id)).toBe("stale");
  });

  it("fail_match_run only affects a processing run of that worker", async () => {
    const run = await start(db);
    await asService(db, () => db.query("select public.fail_match_run($1,$2,'provider down',null)", [OTHER_WORKER, run.id]));
    expect(await status(run.id)).toBe("processing");
    await asService(db, () => db.query("select public.fail_match_run($1,$2,'provider down','memory unavailable')", [DEMO_WORKER.id, run.id]));
    const row = (await db.query("select status, error, memory_warning from public.match_runs where id=$1", [run.id])).rows[0];
    expect(row).toMatchObject({ status: "failed", error: "provider down", memory_warning: "memory unavailable" });
  });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.end().catch(() => {})));
});

describe.skipIf(!ADMIN_URL)("client privileges (database)", () => {
  async function asUser<T>(c: Client, fn: () => Promise<T>): Promise<T> {
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [ALEX_AUTH]);
      return await fn();
    } finally {
      await c.query("rollback");
    }
  }

  it("signed-in clients cannot forge the provenance of a draft", async () => {
    await asUser(db, () => expect(db.query(
      "insert into public.evidence_drafts (worker_id, source_kind, storage_path, file_hash) values ($1,'pdf_upload','forged.pdf',$2)",
      [DEMO_WORKER.id, sha("forged draft")],
    )).rejects.toMatchObject({ code: "42501" }));
  });

  it("signed-in clients cannot call the run functions", async () => {
    await asUser(db, async () => {
      await expect(db.query("select * from public.start_match_run($1,$2)", [DEMO_WORKER.id, DEMO_OPPORTUNITY.id])).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("signed-in clients cannot write match runs, results or matches directly", async () => {
    await asUser(db, () => expect(db.query("insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status) values ($1,$2,0,'completed')", [DEMO_WORKER.id, DEMO_OPPORTUNITY.id])).rejects.toMatchObject({ code: "42501" }));
    const { rows } = await db.query("select id from public.match_runs limit 1");
    await asUser(db, () => expect(db.query("update public.match_runs set status='completed' where id=$1", [rows[0].id])).rejects.toMatchObject({ code: "42501" }));
    await asUser(db, () => expect(db.query("insert into public.requirement_results (match_run_id, requirement_id, assessment) values ($1,$2,'evidence_found')", [rows[0].id, R[0]])).rejects.toMatchObject({ code: "42501" }));
  });

  it("signed-in clients cannot forge evidence system columns but can still read their evidence", async () => {
    await asUser(db, async () => {
      expect((await db.query("select id from public.evidence")).rows.length).toBeGreaterThanOrEqual(4);
    });
    // One statement per transaction: a Postgres error aborts the whole transaction.
    await asUser(db, () => expect(db.query("update public.evidence set index_status='indexed' where id=$1", [E[0]])).rejects.toMatchObject({ code: "42501" }));
    await asUser(db, () => expect(db.query("update public.evidence set verification_status='pending_review' where id=$1", [E[0]])).rejects.toMatchObject({ code: "42501" }));
    await asUser(db, () => expect(db.query("insert into public.evidence (worker_id, type, title, source_kind, file_hash) values ($1,'other','x','manual_text',$2)", [DEMO_WORKER.id, sha("fx")])).rejects.toMatchObject({ code: "42501" }));
  });
});
