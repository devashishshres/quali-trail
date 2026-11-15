/**
 * Job import migration: draft lifecycle, lease, atomic + idempotent confirmation, cannot_assess, rollback.
 * Needs a DISPOSABLE PostgreSQL server. Drops and recreates its own databases. Never point it at shared data.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx vitest run tests/db/job-import.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const ROOT = join(__dirname, "..", "..");
const clients: Client[] = [];
const urls = new Map<Client, string>();

async function freshDb(name: string): Promise<Client> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${name}`;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  clients.push(c);
  urls.set(c, u.toString());
  await c.query(readFileSync(join(ROOT, "tests/db/supabase-stubs.sql"), "utf8"));
  for (const f of readdirSync(join(ROOT, "supabase/migrations")).sort()) {
    await c.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
  }
  return c;
}

async function second(db: Client): Promise<Client> {
  const c = new Client({ connectionString: urls.get(db) });
  await c.connect();
  clients.push(c);
  return c;
}

async function svc<T>(c: Client, sql: string, args: unknown[]): Promise<T> {
  await c.query("set role service_role");
  try {
    return (await c.query(sql, args)).rows[0] as T;
  } finally {
    await c.query("reset role");
  }
}

const W = randomUUID();
const OTHER = randomUUID();
const URL1 = "https://jobs.example.com/listing/1";

describe.skipIf(!ADMIN_URL)("job import (database)", () => {
  let db: Client;

  const begin = (c: Client, url: string | null = URL1, kind = "listing_url", limit = 100, worker = W) =>
    svc<{ r: { ok: boolean; id?: string; reason?: string } }>(c, "select public.opportunity_import_begin($1,$2,$3,$4) r", [worker, kind, url, limit]).then((x) => x.r);
  const fetched = (c: Client, id: string, worker = W) =>
    svc<{ r: boolean }>(c, "select public.opportunity_import_fetched($1,$2,'Fictional HVAC Tech',$3,'Listing text (fictional)',false,'req-1',array[]::text[]) r", [worker, id, URL1]).then((x) => x.r);
  const lease = (c: Client, id: string, worker = W) => svc<{ r: boolean }>(c, "select public.opportunity_import_lease($1,$2) r", [worker, id]).then((x) => x.r);
  const drafted = (c: Client, id: string) => svc<{ r: number | null }>(c, `select public.opportunity_import_drafted($1,$2,'{"requirements":[]}'::jsonb,array[]::text[]) r`, [W, id]).then((x) => x.r);
  const reqs = JSON.stringify([
    { position: 0, original_text: "EPA 608 Universal certification", criteria_json: { acceptedTypes: ["certification"], keywords: ["EPA"], retrievalQuery: "EPA 608" }, mandatory: true, source: "Imported job posting", priority: "required", original_priority: "required", display_text: null, source_excerpt: "EPA 608 Universal certification", category: "certification" },
    { position: 1, original_text: "Valid driver's license", criteria_json: { acceptedTypes: ["other"], keywords: ["license"], retrievalQuery: "license" }, mandatory: true, source: "Imported job posting", priority: "required", original_priority: "required", display_text: "Driving licence", source_excerpt: null, category: "other" },
  ]);
  const opp = JSON.stringify({ title: "HVAC Technician (fictional)", employer: "Fictional Air Co", description: "", location: "Phoenix, AZ", warnings: ["w1"], removed_count: 1, edited_count: 1 });
  const confirm = (c: Client, id: string, version: number) =>
    svc<{ r: { ok: boolean; opportunityId?: string; repeated?: boolean; reason?: string } }>(c, "select public.opportunity_import_confirm($1,$2,$3,$4::jsonb,$5::jsonb) r", [W, id, version, opp, reqs]).then((x) => x.r);

  beforeAll(async () => {
    db = await freshDb("qualitrail_import_test");
    const a1 = randomUUID(), a2 = randomUUID();
    await db.query("insert into auth.users (id) values ($1), ($2)", [a1, a2]);
    await db.query("insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,'Import Test (fictional)','HVAC',true), ($3,$4,'Other (fictional)','HVAC',true)", [W, a1, OTHER, a2]);
  });

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
  });

  it("refuses a second concurrent fetch of the same URL, allows another URL", async () => {
    const a = await begin(db);
    expect(a.ok).toBe(true);
    expect(await begin(db)).toEqual({ ok: false, reason: "in_progress" });
    const b = await begin(db, "https://jobs.example.com/listing/2");
    expect(b.ok).toBe(true);
    await fetched(db, a.id!);
    await svc(db, "select public.opportunity_import_fail($1,$2,'fetch_timeout','x')", [W, b.id]);
  });

  it("recovers an abandoned fetch after 3 minutes", async () => {
    const a = await begin(db, "https://jobs.example.com/stuck");
    await db.query("update public.opportunity_imports set created_at = now() - interval '4 minutes' where id=$1", [a.id]);
    expect((await begin(db, "https://jobs.example.com/stuck")).ok).toBe(true);
    expect((await db.query("select status, error_code from public.opportunity_imports where id=$1", [a.id])).rows[0]).toEqual({ status: "failed", error_code: "abandoned" });
  });

  it("enforces the daily provider limit for URLs only", async () => {
    expect(await begin(db, "https://jobs.example.com/limit", "listing_url", 0)).toEqual({ ok: false, reason: "daily_limit" });
    expect((await begin(db, null, "pasted_text", 0)).ok).toBe(true);
  });

  it("a listing_url draft must carry its URL", async () => {
    await expect(begin(db, null, "listing_url")).rejects.toThrow();
  });

  it("exactly one concurrent caller gets the drafting lease; drafted drafts are never re-leased", async () => {
    const a = await begin(db, "https://jobs.example.com/lease");
    await fetched(db, a.id!);
    const c2 = await second(db);
    const got = await Promise.all([lease(db, a.id!), lease(c2, a.id!)]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(await drafted(db, a.id!)).toBe(1);
    expect(await lease(db, a.id!)).toBe(false);
    expect(await drafted(db, a.id!)).toBeNull(); // a late attempt cannot overwrite
  });

  it("a crashed lease can be retaken after it lapses; a live one cannot", async () => {
    const a = await begin(db, "https://jobs.example.com/crash");
    await fetched(db, a.id!);
    expect(await lease(db, a.id!)).toBe(true);
    expect(await lease(db, a.id!)).toBe(false);
    await db.query("update public.opportunity_imports set lease_until = now() - interval '1 second' where id=$1", [a.id]);
    expect(await lease(db, a.id!)).toBe(true);
  });

  it("a failed draft attempt can be retried; a failed fetch cannot be drafted", async () => {
    const a = await begin(db, "https://jobs.example.com/retry");
    await fetched(db, a.id!);
    await lease(db, a.id!);
    await svc(db, "select public.opportunity_import_fail($1,$2,'draft_model_busy','x')", [W, a.id]);
    expect(await lease(db, a.id!)).toBe(true);
    const b = await begin(db, "https://jobs.example.com/never-fetched");
    await svc(db, "select public.opportunity_import_fail($1,$2,'fetch_timeout','x')", [W, b.id]);
    expect(await lease(db, b.id!)).toBe(false);
  });

  it("another worker cannot touch the draft", async () => {
    const a = await begin(db, "https://jobs.example.com/owner");
    expect(await fetched(db, a.id!, OTHER)).toBe(false);
    await fetched(db, a.id!);
    expect(await lease(db, a.id!, OTHER)).toBe(false);
  });

  it("review saves are optimistic; confirm is atomic, idempotent and clears the listing text", async () => {
    const a = await begin(db, "https://jobs.example.com/confirm");
    await fetched(db, a.id!);
    await lease(db, a.id!);
    const v1 = await drafted(db, a.id!);
    const save = (v: number) => svc<{ r: number | null }>(db, `select public.opportunity_import_save_review($1,$2,$3,'{"requirements":[1]}'::jsonb) r`, [W, a.id, v]).then((x) => x.r);
    expect(await save(v1!)).toBe(2);
    expect(await save(v1!)).toBeNull();
    expect(await confirm(db, a.id!, 1)).toEqual({ ok: false, reason: "changed" });

    const c2 = await second(db);
    const [x, y] = await Promise.all([confirm(db, a.id!, 2), confirm(c2, a.id!, 2)]);
    expect(x.ok && y.ok).toBe(true);
    expect(x.opportunityId).toBe(y.opportunityId);
    expect([x.repeated, y.repeated].sort()).toEqual([false, true]);
    expect((await db.query("select count(*)::int n from public.opportunities where import_id=$1", [a.id])).rows[0].n).toBe(1);
    const row = (await db.query("select status, content_text from public.opportunity_imports where id=$1", [a.id])).rows[0];
    expect(row).toEqual({ status: "confirmed", content_text: null });
    const o = (await db.query("select source_kind, location, import_warnings, removed_count, edited_count, source_url, is_synthetic from public.opportunities where id=$1", [x.opportunityId])).rows[0];
    expect(o).toEqual({ source_kind: "listing_url", location: "Phoenix, AZ", import_warnings: ["w1"], removed_count: 1, edited_count: 1, source_url: "https://jobs.example.com/confirm", is_synthetic: false });
    const r = (await db.query("select original_text, display_text, priority, original_priority from public.requirements where opportunity_id=$1 order by position", [x.opportunityId])).rows;
    expect(r[1]).toEqual({ original_text: "Valid driver's license", display_text: "Driving licence", priority: "required", original_priority: "required" });
    expect(await lease(db, a.id!)).toBe(false); // confirmed drafts are never regenerated
  });

  it("an expired draft cannot be confirmed and its text is dropped", async () => {
    const a = await begin(db, "https://jobs.example.com/expired");
    await fetched(db, a.id!);
    await lease(db, a.id!);
    await drafted(db, a.id!);
    await db.query("update public.opportunity_imports set expires_at = now() - interval '1 second' where id=$1", [a.id]);
    expect(await confirm(db, a.id!, 1)).toEqual({ ok: false, reason: "expired" });
    expect((await db.query("select status, content_text, draft from public.opportunity_imports where id=$1", [a.id])).rows[0]).toEqual({ status: "expired", content_text: null, draft: null });
  });

  it("finalize_match_run stores cannot_assess and still rejects unknown values", async () => {
    const oppId = randomUUID(), reqId = randomUUID();
    await db.query("insert into public.opportunities (id, worker_id, title, employer) values ($1,$2,'Job','Fictional')", [oppId, W]);
    await db.query("insert into public.requirements (id, opportunity_id, position, original_text, criteria_json, source) values ($1,$2,0,'Valid driver''s license','{}','test')", [reqId, oppId]);
    const run = await svc<{ id: string }>(db, "select * from public.start_match_run($1,$2)", [W, oppId]);
    const res = (a: string) => JSON.stringify([{ requirement_id: reqId, assessment: a, explanation: "x", uncertainties: [], missing_documentation: [] }]);
    await expect(svc(db, "select public.finalize_match_run($1,$2,$3::jsonb,'[]'::jsonb,null)", [W, run.id, res("maybe")])).rejects.toThrow(/assessment_check/);
    await db.query("update public.match_runs set status='processing' where id=$1", [run.id]).catch(() => {});
    const s = await svc<{ s: string }>(db, "select public.finalize_match_run($1,$2,$3::jsonb,'[]'::jsonb,null) s", [W, run.id, res("cannot_assess")]);
    expect(s.s).toBe("completed");
  });

  it("browser roles cannot read drafts or call the functions", async () => {
    await db.query("set role authenticated");
    try {
      await expect(db.query("select * from public.opportunity_imports")).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.opportunity_import_lease($1,$2)", [W, randomUUID()])).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("reset role");
    }
  });

  it("rollback refuses while imports exist", async () => {
    const sql = readFileSync(join(ROOT, "scripts/sql/rollback-job-import-if-empty.sql"), "utf8");
    await expect(db.query(sql)).rejects.toThrow(/refusing rollback/);
    await db.query("rollback");
    expect((await db.query("select to_regclass('public.opportunity_imports') t")).rows[0].t).not.toBeNull();
  });

  it("rollback on an empty install restores the old schema, and the migration re-applies", async () => {
    const c = await freshDb("qualitrail_import_rollback_test");
    await c.query(readFileSync(join(ROOT, "scripts/sql/rollback-job-import-if-empty.sql"), "utf8"));
    expect((await c.query("select to_regclass('public.opportunity_imports') t")).rows[0].t).toBeNull();
    const def = (await c.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='requirement_results_assessment_check'")).rows[0].d;
    expect(def).not.toMatch(/cannot_assess/);
    await c.query(readFileSync(join(ROOT, "supabase/migrations/20261118100000_job_import.sql"), "utf8"));
    expect((await c.query("select to_regclass('public.opportunity_imports') t")).rows[0].t).not.toBeNull();
  });
});
