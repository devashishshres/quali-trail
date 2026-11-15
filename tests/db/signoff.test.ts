/**
 * Customer sign-off (database). Needs a DISPOSABLE PostgreSQL server; it drops and
 * recreates `qualitrail_signoff_test`. Uses a separate FICTIONAL test worker only.
 *
 *   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx vitest run tests/db/signoff.test.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_signoff_test";
const ROOT = join(__dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const AUTH = randomUUID();
const WORKER = randomUUID();
const OTHER_AUTH = randomUUID();
const OTHER_WORKER = randomUUID();

let url: string;
let db: Client;
const clients: Client[] = [];
const newClient = async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};

async function svc<T = Record<string, unknown>>(c: Client, sql: string, args: unknown[] = []): Promise<T> {
  await c.query("set role service_role");
  try {
    return (await c.query(sql, args)).rows[0] as T;
  } finally {
    await c.query("reset role");
  }
}
const fn = async (c: Client, name: string, args: unknown[]) => {
  const row = await svc<Record<string, unknown>>(c, `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as r`, args);
  return row.r as Record<string, unknown> & { ok: boolean; reason?: string };
};

let seq = 0;
async function addEvidence(type = "work_record", status = "document_supplied") {
  const id = randomUUID();
  await db.query(
    `insert into public.evidence (id, worker_id, type, title, source_kind, file_hash, verification_status, structured_data)
     values ($1,$2,$3,$4,'seed',$5,$6,'{"skills":["Brazing"],"summary":"Replaced a coil"}')`,
    [id, WORKER, type, `Test record ${++seq}`, sha(`e${seq}${Math.random()}`), status],
  );
  return id;
}

interface Req { id: string; token: string; hash: string }
async function create(evidenceId: string, email = `cust${++seq}@example.test`): Promise<Req & { res: Record<string, unknown> }> {
  const token = `tok-${randomUUID()}`;
  const hash = sha(token);
  const res = await fn(db, "signoff_create_request", [WORKER, evidenceId, email, null, sha(email), "c***@example.test", hash, "mock", sha("worker@example.test"), 7]);
  return { id: res.id as string, token, hash, res };
}
const code = (n: string) => sha(`code:${n}`);
async function verified(r: Req, c = "111111") {
  const issued = await fn(db, "signoff_issue_code", [r.hash, code(c)]);
  expect(issued.ok).toBe(true);
  const session = `sess-${randomUUID()}`;
  const v = await fn(db, "signoff_verify_code", [r.hash, code(c), sha(session)]);
  expect(v.ok).toBe(true);
  return sha(session);
}

describe.skipIf(!ADMIN_URL)("customer sign-off (database)", () => {
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
    await db.query("insert into auth.users (id) values ($1), ($2)", [AUTH, OTHER_AUTH]);
    await db.query(
      "insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,'Test Worker (fictional)','HVAC',true), ($3,$4,'Other Worker (fictional)','HVAC',true)",
      [WORKER, AUTH, OTHER_WORKER, OTHER_AUTH],
    );
  });
  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
  });

  it("only work records and checklists in an editable verification state can be sent", async () => {
    expect((await create(await addEvidence("certification"))).res.reason).toBe("unsupported_type");
    expect((await create(await addEvidence("training"))).res.reason).toBe("unsupported_type");
    const confirmed = await addEvidence("work_record", "document_supplied");
    await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [randomUUID()]);
    await db.query("update public.evidence set verification_status='pending_review' where id=$1", [confirmed]);
    expect((await create(confirmed)).res.reason).toBe("not_eligible");
    expect((await create(await addEvidence("checklist", "self_reported"))).res.ok).toBe(true);
  });

  it("builds the snapshot from the stored row and refuses another worker's record", async () => {
    const e = await addEvidence();
    const r = await create(e);
    const row = (await db.query("select snapshot, snapshot_hash, evidence_version from public.signoff_requests where id=$1", [r.id])).rows[0];
    expect(row.snapshot.title).toMatch(/^Test record/);
    expect(row.snapshot.skills).toEqual(["Brazing"]);
    expect(row.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    const other = await fn(db, "signoff_create_request", [OTHER_WORKER, e, "x@example.test", null, sha("x"), "x***", sha("t2"), "mock", null, 7]);
    expect(other.reason).toBe("not_found");
  });

  it("the worker's own address, suppressed addresses and duplicates are refused", async () => {
    const e = await addEvidence();
    const own = await fn(db, "signoff_create_request", [WORKER, e, "worker@example.test", null, sha("worker@example.test"), "w***", sha("t3"), "mock", sha("worker@example.test"), 7]);
    expect(own.reason).toBe("own_email");
    await fn(db, "signoff_add_suppression", [sha("blocked@example.test"), "bounce", "msg_1"]);
    expect((await create(e, "blocked@example.test")).res.reason).toBe("suppressed");
    expect((await create(e)).res.ok).toBe(true);
    expect((await create(e)).res.reason).toBe("duplicate_open");
  });

  it("a link alone shows only the gate and never the snapshot", async () => {
    const r = await create(await addEvidence());
    const gate = await fn(db, "signoff_gate", [r.hash]);
    expect(gate).toMatchObject({ ok: true, status: "pending", workerName: "Test Worker (fictional)" });
    expect(JSON.stringify(gate)).not.toMatch(/Test record|Brazing|cust\d+@/);
    expect((await fn(db, "signoff_read_snapshot", [r.hash, sha("no-session")])).ok).toBe(false);
    expect((await fn(db, "signoff_respond", [r.hash, sha("no-session"), "confirm", "A Customer", null, "v1"])).ok).toBe(false);
    expect((await fn(db, "signoff_gate", [sha("unknown")])).ok).toBe(false);
  });

  it("codes are single-use and reissuing invalidates earlier codes", async () => {
    const r = await create(await addEvidence());
    expect((await fn(db, "signoff_issue_code", [r.hash, code("a")])).ok).toBe(true);
    await db.query("update public.signoff_codes set created_at = now() - interval '2 minutes' where request_id=$1", [r.id]);
    expect((await fn(db, "signoff_issue_code", [r.hash, code("b")])).ok).toBe(true);
    expect((await fn(db, "signoff_verify_code", [r.hash, code("a"), sha("s1")])).ok).toBe(false); // earlier code dead
    expect((await fn(db, "signoff_verify_code", [r.hash, code("b"), sha("s2")])).ok).toBe(true);
    expect((await fn(db, "signoff_verify_code", [r.hash, code("b"), sha("s3")])).ok).toBe(false); // already used
  });

  it("limits code spacing, count per day, attempts per code and total failures", async () => {
    const r = await create(await addEvidence());
    expect((await fn(db, "signoff_issue_code", [r.hash, code("1")])).ok).toBe(true);
    expect((await fn(db, "signoff_issue_code", [r.hash, code("2")])).reason).toBe("too_soon");
    for (const n of ["2", "3"]) {
      await db.query("update public.signoff_codes set created_at = created_at - interval '2 minutes' where request_id=$1", [r.id]);
      expect((await fn(db, "signoff_issue_code", [r.hash, code(n)])).ok).toBe(true);
    }
    await db.query("update public.signoff_codes set created_at = created_at - interval '2 minutes' where request_id=$1", [r.id]);
    expect((await fn(db, "signoff_issue_code", [r.hash, code("4")])).reason).toBe("limit");

    const r2 = await create(await addEvidence());
    await fn(db, "signoff_issue_code", [r2.hash, code("x")]);
    for (let i = 0; i < 5; i++) expect((await fn(db, "signoff_verify_code", [r2.hash, code("wrong"), sha("s")])).ok).toBe(false);
    // Code is now exhausted: even the right code fails.
    expect((await fn(db, "signoff_verify_code", [r2.hash, code("x"), sha("s")])).ok).toBe(false);
    for (let i = 0; i < 6; i++) await fn(db, "signoff_verify_code", [r2.hash, code("wrong"), sha("s")]);
    expect((await db.query("select status from public.signoff_requests where id=$1", [r2.id])).rows[0].status).toBe("locked");
  });

  it("failures look identical whatever the cause", async () => {
    const r = await create(await addEvidence());
    await fn(db, "signoff_issue_code", [r.hash, code("x")]);
    const wrong = await fn(db, "signoff_verify_code", [r.hash, code("nope"), sha("s")]);
    const unknown = await fn(db, "signoff_verify_code", [sha("no-such-token"), code("x"), sha("s")]);
    expect(wrong).toEqual(unknown);
  });

  it("a session does not work for another request and the snapshot needs token + session", async () => {
    const a = await create(await addEvidence());
    const b = await create(await addEvidence());
    const sessionA = await verified(a);
    expect((await fn(db, "signoff_read_snapshot", [a.hash, sessionA])).ok).toBe(true);
    expect((await fn(db, "signoff_read_snapshot", [b.hash, sessionA])).ok).toBe(false);
    expect((await fn(db, "signoff_respond", [b.hash, sessionA, "confirm", "A Customer", null, "v1"])).ok).toBe(false);
  });

  it("records a verified acknowledgment, repeats are idempotent, a conflicting decision is refused", async () => {
    const r = await create(await addEvidence());
    const s = await verified(r);
    const first = await fn(db, "signoff_respond", [r.hash, s, "confirm", "Casey Customer", null, "v1"]);
    expect(first).toMatchObject({ ok: true, repeated: false, status: "acknowledged" });
    expect(await fn(db, "signoff_respond", [r.hash, s, "confirm", "Casey Customer", null, "v1"])).toMatchObject({ ok: true, repeated: true });
    expect((await fn(db, "signoff_respond", [r.hash, s, "decline", null, null, "v1"])).reason).toBe("already_responded");
    const row = (await db.query("select status, email_verified_at from public.signoff_requests where id=$1", [r.id])).rows[0];
    expect(row.status).toBe("acknowledged");
    expect(row.email_verified_at).not.toBeNull();
    expect((await db.query("select count(*)::int n from public.signoff_responses where request_id=$1", [r.id])).rows[0].n).toBe(1);
  });

  it("concurrent submissions create exactly one response", async () => {
    const r = await create(await addEvidence());
    const s = await verified(r);
    const cs = await Promise.all([newClient(), newClient(), newClient(), newClient()]);
    const results = await Promise.all(
      cs.map((c, i) => fn(c, "signoff_respond", [r.hash, s, i % 2 ? "confirm" : "decline", "Casey Customer", null, "v1"])),
    );
    expect(results.filter((x) => x.ok && x.repeated === false)).toHaveLength(1);
    // Every other submission is either an identical repeat or a refused conflict. None created a second response.
    for (const x of results.filter((y) => !(y.ok && y.repeated === false))) expect(x.ok ? x.repeated : x.reason).toSatisfy((v: unknown) => v === true || v === "already_responded");
    expect((await db.query("select count(*)::int n from public.signoff_responses where request_id=$1", [r.id])).rows[0].n).toBe(1);
  });

  it("an acknowledgment is refused when the record changed after the invitation", async () => {
    const e = await addEvidence();
    const r = await create(e);
    const s = await verified(r);
    await db.query("update public.evidence set title='Edited title' where id=$1", [e]);
    expect((await db.query("select status from public.signoff_requests where id=$1", [r.id])).rows[0].status).toBe("superseded");
    expect((await fn(db, "signoff_respond", [r.hash, s, "confirm", "Casey Customer", null, "v1"])).ok).toBe(false);
    expect((await db.query("select count(*)::int n from public.signoff_responses where request_id=$1", [r.id])).rows[0].n).toBe(0);
  });

  it("expired invitations, revoked invitations and typed-name rules are enforced", async () => {
    const r = await create(await addEvidence());
    const s = await verified(r);
    await db.query("update public.signoff_requests set expires_at = now() - interval '1 minute' where id=$1", [r.id]);
    expect((await fn(db, "signoff_respond", [r.hash, s, "confirm", "Casey Customer", null, "v1"])).reason).toBe("expired");

    const r2 = await create(await addEvidence());
    const s2 = await verified(r2);
    expect((await fn(db, "signoff_respond", [r2.hash, s2, "confirm", " ", null, "v1"])).reason).toBe("name_required");
    expect((await fn(db, "signoff_respond", [r2.hash, s2, "request_correction", null, "", "v1"])).reason).toBe("comment_required");
    expect((await fn(db, "signoff_revoke_request", [WORKER, r2.id])).ok).toBe(true);
    expect((await fn(db, "signoff_respond", [r2.hash, s2, "confirm", "Casey Customer", null, "v1"])).ok).toBe(false);
    expect((await fn(db, "signoff_revoke_request", [OTHER_WORKER, r2.id])).reason).toBe("not_found");
  });

  it("resending rotates the token: the old link and old session stop working", async () => {
    const r = await create(await addEvidence());
    const s = await verified(r);
    const newToken = sha("new-token");
    expect((await fn(db, "signoff_rotate_token", [WORKER, r.id, newToken])).ok).toBe(true);
    expect((await fn(db, "signoff_gate", [r.hash])).ok).toBe(false);
    expect((await fn(db, "signoff_read_snapshot", [newToken, s])).ok).toBe(false);
  });

  it("a decision row cannot exist without a verified session (database constraint)", async () => {
    const r = await create(await addEvidence());
    await expect(db.query("update public.signoff_requests set status='acknowledged' where id=$1", [r.id])).rejects.toThrow(/check/i);
  });

  it("snapshots and responses are immutable and not deletable", async () => {
    const r = await create(await addEvidence());
    const s = await verified(r);
    await fn(db, "signoff_respond", [r.hash, s, "confirm", "Casey Customer", null, "v1"]);
    await expect(db.query("update public.signoff_requests set snapshot='{}' where id=$1", [r.id])).rejects.toThrow(/immutable/);
    await expect(db.query("delete from public.signoff_requests where id=$1", [r.id])).rejects.toThrow(/not deleted/);
    await expect(db.query("update public.signoff_responses set typed_name='Someone Else' where request_id=$1", [r.id])).rejects.toThrow(/immutable/);
    await expect(db.query("delete from public.signoff_responses where request_id=$1", [r.id])).rejects.toThrow(/not deleted/);
    await expect(db.query("update public.signoff_requests set status='declined' where id=$1", [r.id])).rejects.toThrow(/cannot change/);
  });

  it("the evidence row cannot be deleted while a sign-off references it", async () => {
    const e = await addEvidence();
    await create(e);
    await expect(db.query("delete from public.evidence where id=$1", [e])).rejects.toThrow();
  });

  it("the 90-day purge removes personal data but keeps the acknowledgment and the typed signature", async () => {
    const e = await addEvidence();
    const r = await create(e, "purge-me@example.test");
    const s = await verified(r);
    await fn(db, "signoff_respond", [r.hash, s, "request_correction", null, "Please fix the date", "v1"]);
    const e2 = await addEvidence();
    const r2 = await create(e2, "sign-me@example.test");
    const s2 = await verified(r2);
    await fn(db, "signoff_respond", [r2.hash, s2, "confirm", "Casey Customer", "thanks", "v1"]);
    await fn(db, "signoff_add_suppression", [sha("kept@example.test"), "complaint", "msg_9"]);

    // Not old enough: nothing removed.
    await fn(db, "signoff_purge_pii", [90]);
    expect((await db.query("select customer_email from public.signoff_requests where id=$1", [r2.id])).rows[0].customer_email).not.toBeNull();

    await db.query("update public.signoff_requests set closed_at = now() - interval '91 days' where id in ($1,$2)", [r.id, r2.id]);
    await fn(db, "signoff_purge_pii", [90]);
    const q = (await db.query("select customer_email, customer_name, customer_email_hash, email_hint, pii_purged_at, snapshot_hash, status from public.signoff_requests where id=$1", [r2.id])).rows[0];
    expect(q).toMatchObject({ customer_email: null, customer_name: null, customer_email_hash: null, email_hint: null, status: "acknowledged" });
    expect(q.pii_purged_at).not.toBeNull();
    expect(q.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
    const resp = (await db.query("select typed_name, comment, decision from public.signoff_responses where request_id=$1", [r2.id])).rows[0];
    expect(resp).toMatchObject({ typed_name: "Casey Customer", comment: null, decision: "confirm" }); // signature stays, comment goes
    const resp1 = (await db.query("select comment from public.signoff_responses where request_id=$1", [r.id])).rows[0];
    expect(resp1.comment).toBeNull();
    expect((await db.query("select count(*)::int n from public.signoff_codes where request_id in ($1,$2)", [r.id, r2.id])).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from public.signoff_suppressions where email_hash=$1", [sha("kept@example.test")])).rows[0].n).toBe(1);
  });

  it("a bounce or complaint suppresses the address and closes its open invitations", async () => {
    const e = await addEvidence();
    const r = await create(e, "bouncer@example.test");
    await fn(db, "signoff_add_suppression", [sha("bouncer@example.test"), "bounce", "msg_2"]);
    expect((await db.query("select status from public.signoff_requests where id=$1", [r.id])).rows[0].status).toBe("revoked");
    expect((await fn(db, "signoff_issue_code", [r.hash, code("z")])).ok).toBe(false);
    expect((await create(e, "bouncer@example.test")).res.reason).toBe("suppressed");
  });

  it("the rate limiter counts per key and window", async () => {
    const key = sha("ip:1");
    const outcomes: boolean[] = [];
    for (let i = 0; i < 4; i++) outcomes.push((await svc<{ r: boolean }>(db, "select public.signoff_hit_rate_limit($1,3600,3) as r", [key])).r);
    expect(outcomes).toEqual([true, true, true, false]);
    expect((await svc<{ r: boolean }>(db, "select public.signoff_hit_rate_limit($1,3600,3) as r", [sha("ip:2")])).r).toBe(true);
  });

  it("no client role can read or call anything", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.query(`set role ${role}`);
      try {
        await expect(db.query("select * from public.signoff_requests")).rejects.toThrow(/permission denied/);
        await expect(db.query("select * from public.signoff_responses")).rejects.toThrow(/permission denied/);
        await expect(db.query("select public.signoff_gate('x')")).rejects.toThrow(/permission denied/);
        await expect(db.query("select public.signoff_purge_pii(1)")).rejects.toThrow(/permission denied/);
      } finally {
        await db.query("reset role");
      }
    }
  });

  it("sign-off never changes the record's verification status", async () => {
    const e = await addEvidence("work_record", "document_supplied");
    const r = await create(e);
    const s = await verified(r);
    await fn(db, "signoff_respond", [r.hash, s, "confirm", "Casey Customer", null, "v1"]);
    expect((await db.query("select verification_status, version from public.evidence where id=$1", [e])).rows[0]).toMatchObject({ verification_status: "document_supplied", version: 1 });
  });
});
