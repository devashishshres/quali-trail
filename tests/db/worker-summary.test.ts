/**
 * The additive worker-summary migration, applied on top of an already-populated database.
 * Needs a DISPOSABLE PostgreSQL server. It drops and recreates its own database
 * `qualitrail_summary_test`. Never point it at shared or production data.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx vitest run tests/db
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_summary_test";
const ROOT = join(__dirname, "..", "..");
const SUMMARY_MIGRATION = "20261115120000_worker_summary.sql";

let db: Client;
const WORKER = randomUUID();
const AUTH = randomUUID();

describe.skipIf(!ADMIN_URL)("worker summary migration (database)", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin.query(`create database ${DB_NAME}`);
    await admin.end();
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${DB_NAME}`;
    db = new Client({ connectionString: u.toString() });
    await db.connect();

    await db.query(readFileSync(join(ROOT, "tests/db/supabase-stubs.sql"), "utf8"));
    const files = readdirSync(join(ROOT, "supabase/migrations")).sort();
    expect(files).toContain(SUMMARY_MIGRATION);
    // Everything BEFORE the summary migration, then populate, then migrate: existing data must survive.
    for (const f of files.filter((f) => f < SUMMARY_MIGRATION)) await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
    await db.query("insert into auth.users (id) values ($1)", [AUTH]);
    await db.query("insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,'Existing Worker','HVAC',true)", [WORKER, AUTH]);
    for (const f of files.filter((f) => f >= SUMMARY_MIGRATION)) await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
  });

  afterAll(async () => {
    await db?.end();
  });

  it("leaves existing workers readable, with a null summary", async () => {
    const r = (await db.query("select name, summary from public.workers where id=$1", [WORKER])).rows[0];
    expect(r).toEqual({ name: "Existing Worker", summary: null });
  });

  it("can be applied twice without error", async () => {
    await expect(db.query(readFileSync(join(ROOT, "supabase/migrations", SUMMARY_MIGRATION), "utf8"))).resolves.toBeDefined();
  });

  it("stores a normal summary and rejects an empty or oversized one", async () => {
    await db.query("update public.workers set summary=$2 where id=$1", [WORKER, "Fictional demo technician."]);
    expect((await db.query("select summary from public.workers where id=$1", [WORKER])).rows[0].summary).toBe("Fictional demo technician.");
    await expect(db.query("update public.workers set summary='' where id=$1", [WORKER])).rejects.toThrow();
    await expect(db.query("update public.workers set summary=$2 where id=$1", [WORKER, "x".repeat(1001)])).rejects.toThrow();
  });

  it("lets a signed-in worker read but not change the summary (no UPDATE policy)", async () => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [AUTH]);
      expect((await db.query("select summary from public.workers where id=$1", [WORKER])).rows[0].summary).toBe("Fictional demo technician.");
      const upd = await db.query("update public.workers set summary='Forged' where id=$1", [WORKER]);
      expect(upd.rowCount).toBe(0);
    } finally {
      await db.query("rollback");
    }
    expect((await db.query("select summary from public.workers where id=$1", [WORKER])).rows[0].summary).toBe("Fictional demo technician.");
  });

  it("gives anonymous visitors no access to workers at all", async () => {
    const q = await db.query("select has_column_privilege('anon','public.workers','summary','SELECT') as ok");
    expect(q.rows[0].ok).toBe(false);
  });
});
