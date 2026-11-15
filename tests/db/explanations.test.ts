/**
 * match_run_explanations migration: claim/save/fail semantics, ownership, daily limit, browser-role denial,
 * cascade, and that checked results are never touched. Needs a DISPOSABLE PostgreSQL server.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres npx vitest run tests/db/explanations.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const ROOT = join(__dirname, "..", "..");
const DB = "qt_explanations_test";
let db: Client;
let urlFor = "";

const W = randomUUID();
const OTHER = randomUUID();
const OPP = randomUUID();
const ITEMS = JSON.stringify([{ requirementId: randomUUID(), kind: "no_related", asks: null, related: [], unclear: [], nextStep: "x", breakdown: null, clarification: null, stale: false }]);

async function svc<T = Record<string, unknown>>(sql: string, args: unknown[]): Promise<T> {
  await db.query("set role service_role");
  try {
    return (await db.query(sql, args)).rows[0] as T;
  } finally {
    await db.query("reset role");
  }
}
const claim = async (run: string, worker = W, limit = 20) => (await svc<{ r: string }>("select public.explanation_claim($1,$2,$3) as r", [worker, run, limit])).r;
const save = async (run: string, worker = W) => (await svc<{ r: boolean }>("select public.explanation_save($1,$2,'ok','m',1,$3::jsonb) as r", [worker, run, ITEMS])).r;
const fail = (run: string, worker = W) => svc("select public.explanation_fail($1,$2,'model_failed')", [worker, run]);
async function newRun(status = "completed", worker = W, opp = OPP): Promise<string> {
  return (await db.query("insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status) values ($1,$2,0,$3) returning id", [worker, opp, status])).rows[0].id;
}

describe.skipIf(!ADMIN_URL)("AI-assisted explanations (database)", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB} with (force)`);
    await admin.query(`create database ${DB}`);
    await admin.end();
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${DB}`;
    urlFor = u.toString();
    db = new Client({ connectionString: urlFor });
    await db.connect();
    await db.query(readFileSync(join(ROOT, "tests/db/supabase-stubs.sql"), "utf8"));
    for (const f of readdirSync(join(ROOT, "supabase/migrations")).sort()) await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
    const [a, b] = [randomUUID(), randomUUID()];
    await db.query("insert into auth.users (id) values ($1), ($2)", [a, b]);
    await db.query("insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,'Fictional A','HVAC',true), ($3,$4,'Fictional B','HVAC',true)", [W, a, OTHER, b]);
    await db.query("insert into public.opportunities (id, worker_id, title, employer) values ($1,$2,'Job','Fictional')", [OPP, W]);
  });
  afterAll(async () => db?.end());

  it("claim → save → existing; a second claim makes no new row", async () => {
    const run = await newRun();
    expect(await claim(run)).toBe("claimed");
    expect(await claim(run)).toBe("busy");
    expect(await save(run)).toBe(true);
    expect(await claim(run)).toBe("existing");
    expect((await db.query("select count(*)::int n from public.match_run_explanations where match_run_id = $1", [run])).rows[0].n).toBe(1);
  });

  it("only a COMPLETED run of the SAME worker can be claimed; foreign saves do nothing", async () => {
    expect(await claim(await newRun("stale"))).toBe("not_found");
    const run = await newRun();
    expect(await claim(run, OTHER)).toBe("not_found");
    expect(await claim(run)).toBe("claimed");
    expect(await save(run, OTHER)).toBe(false);
  });

  it("a failed generation may be retried, at most three attempts in all", async () => {
    const run = await newRun();
    for (let i = 0; i < 3; i++) {
      expect(await claim(run)).toBe("claimed");
      await fail(run);
    }
    expect(await claim(run)).toBe("exhausted");
  });

  it("an abandoned claim (older than 3 minutes) can be taken over", async () => {
    const run = await newRun();
    expect(await claim(run)).toBe("claimed");
    await db.query("update public.match_run_explanations set updated_at = now() - interval '4 minutes' where match_run_id = $1", [run]);
    expect(await claim(run)).toBe("claimed");
  });

  it("daily limit per worker", async () => {
    expect(await claim(await newRun(), W, 0)).toBe("limited");
  });

  it("checked results are untouched and deleting a run removes its explanation", async () => {
    const run = await newRun();
    const before = (await db.query("select count(*)::int n from public.requirement_results")).rows[0].n;
    expect(await claim(run)).toBe("claimed");
    expect(await save(run)).toBe(true);
    expect((await db.query("select count(*)::int n from public.requirement_results")).rows[0].n).toBe(before);
    await db.query("delete from public.match_runs where id = $1", [run]);
    expect((await db.query("select count(*)::int n from public.match_run_explanations where match_run_id = $1", [run])).rows[0].n).toBe(0);
  });

  it("browser roles can neither read the table nor call the functions", async () => {
    for (const role of ["authenticated", "anon"]) {
      await db.query("begin");
      try {
        await db.query(`set local role ${role}`);
        await expect(db.query("select * from public.match_run_explanations")).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.query("rollback");
      }
      await db.query("begin");
      try {
        await db.query(`set local role ${role}`);
        await expect(db.query("select public.explanation_claim($1,$2,20)", [W, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.query("rollback");
      }
    }
  });

  it("a completed row must carry items; the rollback refuses while rows exist", async () => {
    await expect(db.query("insert into public.match_run_explanations (match_run_id, worker_id, status) values ($1,$2,'completed')", [await newRun(), W])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query(readFileSync(join(ROOT, "scripts/sql/rollback-explanations-if-empty.sql"), "utf8"))).rejects.toThrow(/refusing rollback/);
    await db.query("rollback").catch(() => {});
    expect((await db.query("select to_regclass('public.match_run_explanations') is not null as t")).rows[0].t).toBe(true);
  });

  it("the rollback removes everything when no explanation exists", async () => {
    await db.query("delete from public.match_run_explanations");
    await db.query(readFileSync(join(ROOT, "scripts/sql/rollback-explanations-if-empty.sql"), "utf8"));
    expect((await db.query("select to_regclass('public.match_run_explanations') is null as gone")).rows[0].gone).toBe(true);
    expect((await db.query("select to_regprocedure('public.explanation_claim(uuid,uuid,integer)') is null as gone")).rows[0].gone).toBe(true);
  });
});
