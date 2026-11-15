/**
 * Employer review portal (database). DISPOSABLE PostgreSQL only; drops and recreates `qualitrail_employer_test`.
 * Fictional test identities only.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_employer_test";
const ROOT = join(__dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let db: Client;
type R = Record<string, unknown> & { ok: boolean; reason?: string };
async function fn<T = R>(name: string, args: unknown[]): Promise<T> {
  await db.query("set role service_role");
  try {
    return (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as r`, args)).rows[0].r as T;
  } finally {
    await db.query("reset role");
  }
}
async function user(email: string, confirmed = true) {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1,$2,$3)", [id, email, confirmed ? new Date() : null]);
  return id;
}
const addr = (n: string) => `${n}.${randomUUID().slice(0, 6)}@test.qualitrail.dev`;
type W = { auth: string; id: string; email: string; rel?: string; sup?: string };
async function worker(name: string): Promise<W> {
  const email = addr(name.toLowerCase());
  const auth = await user(email);
  const r = await fn("account_onboard_worker", [auth, `${name} (fictional)`, "HVAC", null, "employee"]);
  return { auth, id: r.workerId as string, email };
}
async function record(w: W, type = "work_record", storage: string | null = null) {
  const id = randomUUID();
  await db.query(
    `insert into public.evidence (id, worker_id, type, title, issuer, source_kind, storage_path, file_hash, verification_status, structured_data)
     values ($1,$2,$3,$4,'Fictional Issuer',$5,$6,$7,$8,$9)`,
    [id, w.id, type, `Fictional ${type} ${id.slice(0, 6)}`, storage ? "pdf_upload" : "manual_text", storage, sha(id), storage ? "document_supplied" : "self_reported",
     JSON.stringify({ activities: ["Brazed line set"], summary: "Customer Pat Example, 12 Fictional Lane", credentialNumber: "CRED-123" })],
  );
  return id;
}
const version = async (id: string) => (await db.query("select version from public.evidence where id=$1", [id])).rows[0].version as number;
/** Supervisor confirmation of `rec`; consent: undefined = none, else the show_name flag. */
async function supervisorConfirms(w: W, rec: string, consent?: boolean) {
  if (!w.rel) {
    const semail = addr("sup");
    w.sup = await user(semail);
    await fn("account_onboard_supervisor", [w.sup, "Sky Reviewer (fictional)", "Fictional Mech", "Lead"]);
    await fn("sup_invite_create", [w.id, semail, sha(`e${semail}`), "x***", sha(`t${semail}`), 14]);
    w.rel = (await fn("sup_invite_answer", [sha(`t${semail}`), w.sup, true])).relationshipId as string;
  }
  const q = await fn("review_create", [w.id, rec, w.rel, 30, false]);
  expect(await fn("review_respond", [w.sup, q.id, "confirm_observed", JSON.stringify(["Brazed line set"]), "Private supervisor comment", "supervisor-review-v1"])).toMatchObject({ ok: true });
  if (consent !== undefined) expect(await fn("review_record_share_consent", [w.sup, q.id, "supervisor-employer-share-v2", consent])).toMatchObject({ ok: true });
  return q.id as string;
}
async function customerAck(w: W, rec: string, statement: string) {
  const req = randomUUID(), session = randomUUID();
  await db.query(
    `insert into public.signoff_requests (id, worker_id, evidence_id, evidence_version, snapshot, snapshot_hash, file_hash, customer_email, customer_name,
       token_hash, status, delivery_mode, expires_at, verified_session_id, email_verified_at)
     values ($1,$2,$3,$4,$5,$6,'x','casey@example.test','Casey Customer',$7,'acknowledged','resend',now() + interval '7 days',$8,now())`,
    [req, w.id, rec, await version(rec), JSON.stringify({ activities: ["Replaced contactor"] }), sha(req), sha(`tok${req}`), session]);
  await db.query(
    `insert into public.signoff_responses (request_id, decision, typed_name, comment, statement_version, snapshot_hash, evidence_version, session_id)
     values ($1,'confirm','Casey Typed Signature','Customer private note',$2,$3,$4,$5)`, [req, statement, sha(req), await version(rec), session]);
}
async function share(w: W, email: string, items: { id: string; kind: "work" | "certification"; original?: boolean }[], days = 7) {
  const token = sha(`tok-${randomUUID()}`);
  const v = async (x: { id: string }) => ({ id: x.id, version: await version(x.id) });
  const packet = { format: "employer-packet-v2", technician: { name: "x", trade: "HVAC" },
    work: await Promise.all(items.filter((x) => x.kind === "work").map(v)),
    certifications: await Promise.all(items.filter((x) => x.kind === "certification").map(v)) };
  const r = await fn("employer_share_create", [w.id, "employer-packet-v2", JSON.stringify(packet),
    JSON.stringify(items.map((x) => ({ id: x.id, kind: x.kind, original: Boolean(x.original) }))), email, sha(`email:${email.toLowerCase()}`), "x***", token, days]);
  return { ...r, id: r.id as string, token };
}
type Cand = { work: { id: string; supervisor: { reviewer: unknown }[]; customer: unknown[]; withheldCount: number }[]; certifications: { id: string }[] };

describe.skipIf(!ADMIN_URL)("employer review portal (database)", () => {
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
    for (const f of readdirSync(join(ROOT, "supabase/migrations")).sort()) await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
  });
  afterAll(async () => { await db?.end().catch(() => undefined); });

  it("only explicitly permitted confirmations of the current version make work shareable", async () => {
    const w = await worker("Kai");
    const none = await record(w);
    const old = await record(w);
    const okAnon = await record(w);
    const okNamed = await record(w);
    const custV1 = await record(w);
    const custV2 = await record(w);
    const training = await record(w, "training", "fictional/training.pdf");
    const cert = await record(w, "certification", "fictional/cert.pdf");
    const typedCert = await record(w, "certification", null);
    await supervisorConfirms(w, old);
    await supervisorConfirms(w, okAnon, false);
    await supervisorConfirms(w, okNamed, true);
    await customerAck(w, custV1, "customer-ack-v1");
    await customerAck(w, custV2, "customer-ack-v2");

    const c = await fn<Cand>("employer_share_candidates", [w.id]);
    const byId = new Map(c.work.map((x) => [x.id, x]));
    expect(byId.get(none)).toMatchObject({ supervisor: [], customer: [], withheldCount: 0 });
    expect(byId.get(old)).toMatchObject({ supervisor: [], customer: [], withheldCount: 1 });
    expect(byId.get(okAnon)!.supervisor).toEqual([expect.objectContaining({ reviewer: null })]);
    expect(byId.get(okNamed)!.supervisor).toEqual([expect.objectContaining({ reviewer: { name: "Sky Reviewer (fictional)", organization: "Fictional Mech", title: "Lead" } })]);
    expect(byId.get(custV1)).toMatchObject({ customer: [], withheldCount: 1 });
    expect(byId.get(custV2)!.customer).toEqual([expect.objectContaining({ acknowledgedActivities: ["Replaced contactor"], simulated: false })]);
    expect(c.certifications.map((x) => x.id)).toEqual([cert]);
    const text = JSON.stringify(c);
    for (const leak of ["Private supervisor comment", "Casey", "casey@example.test", "Customer private note", "Pat Example", "CRED-123", "Fictional Lane"]) expect(text).not.toContain(leak);

    const hr = addr("hr");
    for (const bad of [none, old, custV1]) expect((await share(w, hr, [{ id: bad, kind: "work" }])).reason).toBe("not_eligible");
    expect((await share(w, hr, [{ id: training, kind: "certification" }])).reason).toBe("not_eligible");
    expect((await share(w, hr, [{ id: typedCert, kind: "certification" }])).reason).toBe("not_eligible");
    expect((await share(w, hr, [{ id: okAnon, kind: "certification" }])).reason).toBe("not_eligible");
    expect((await share(w, hr, [{ id: cert, kind: "work" }])).reason).toBe("not_eligible");
    expect((await share(w, hr, [{ id: okAnon, kind: "work", original: true }])).reason).toBe("no_original");
    expect((await share(w, hr, [])).reason).toBe("invalid");
    expect((await share(w, hr, [{ id: okAnon, kind: "work" }, { id: custV2, kind: "work" }, { id: cert, kind: "certification", original: true }])).ok).toBe(true);

    await db.query("update public.evidence set title = 'Edited (fictional)' where id = $1", [okAnon]);
    expect((await share(w, hr, [{ id: okAnon, kind: "work" }])).reason).toBe("not_eligible");
  });

  it("consent is explicit, by the reviewer only, for confirmations only, at decision time only", async () => {
    const w = await worker("Rae");
    const q = await supervisorConfirms(w, await record(w));
    await db.query("alter table public.review_responses disable trigger review_responses_frozen");
    await db.query("update public.review_responses set created_at = now() - interval '1 day' where request_id=$1", [q]);
    await db.query("alter table public.review_responses enable trigger review_responses_frozen");
    expect((await fn("review_record_share_consent", [w.sup, q, "v", true])).reason).toBe("too_late");
    const fresh = await supervisorConfirms(w, await record(w));
    expect((await fn("review_record_share_consent", [w.auth, fresh, "v", true])).reason).toBe("not_found");
    const dq = await fn("review_create", [w.id, await record(w), w.rel, 30, false]);
    await fn("review_respond", [w.sup, dq.id, "decline", null, null, "supervisor-review-v1"]);
    expect((await fn("review_record_share_consent", [w.sup, dq.id, "v", true])).reason).toBe("not_confirmation");
    expect(await fn("review_record_share_consent", [w.sup, fresh, "v", false])).toMatchObject({ ok: true });
    await expect(db.query("update public.review_share_consents set show_name = true where request_id=$1", [fresh])).rejects.toThrow(/append-only/);
  });

  it("only the confirmed invited account can open; a forwarded link does nothing; no other role is granted", async () => {
    const w = await worker("Wren");
    const cert = await record(w, "certification", "fictional/c.pdf");
    const email = addr("hiring");
    expect((await share(w, w.email, [{ id: cert, kind: "certification" }])).reason).toBe("own_email");
    const s = await share(w, email.toUpperCase(), [{ id: cert, kind: "certification" }]);
    expect(s.ok).toBe(true);
    expect(await fn("account_has_pending_employer_share", [sha(`email:${email}`)])).toBe(true);
    const stranger = await user(addr("stranger"));
    expect((await fn("employer_share_accept", [s.token, stranger])).reason).toBe("wrong_account");
    expect((await fn("employer_share_accept", [s.token, w.auth])).reason).toBe("self");
    expect((await fn("employer_share_accept", [s.token, await user(addr("unconfirmed"), false)])).reason).toBe("email_unconfirmed");
    const reviewer = await user(email);
    expect(await fn("employer_share_accept", [s.token, reviewer])).toMatchObject({ ok: true, id: s.id });
    expect(await fn("employer_share_accept", [s.token, reviewer])).toMatchObject({ ok: true, repeated: true });
    expect((await fn("employer_share_accept", [s.token, stranger])).reason).toBe("wrong_account");
    expect((await fn("employer_share_get", [stranger, s.id])).reason).toBe("not_found");
    expect(await fn("employer_share_get", [reviewer, s.id])).toMatchObject({ ok: true, changedRecordIds: [] });
    expect((await db.query("select count(*)::int n from public.supervisor_profiles where auth_user_id=$1", [reviewer])).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from public.supervisor_relationships where supervisor_auth_user_id=$1", [reviewer])).rows[0].n).toBe(0);
  });

  it("certificate originals open only when authorized, unchanged and active; unselected items and work documents never", async () => {
    const w = await worker("Rowan");
    const work = await record(w, "work_record", "fictional/work-order.pdf");
    await supervisorConfirms(w, work, true);
    const authorized = await record(w, "certification", "fictional/authorized.pdf");
    const notAuthorized = await record(w, "certification", "fictional/not-authorized.pdf");
    const unselected = await record(w, "certification", "fictional/unselected.pdf");
    const email = addr("lead");
    const s = await share(w, email, [{ id: work, kind: "work" }, { id: authorized, kind: "certification", original: true }, { id: notAuthorized, kind: "certification" }]);
    expect(s.ok).toBe(true);
    const reviewer = await user(email);
    expect(await fn("employer_share_document_path", [reviewer, s.id, authorized])).toBeNull();
    await fn("employer_share_accept", [s.token, reviewer]);
    expect(await fn("employer_share_document_path", [reviewer, s.id, authorized])).toBe("fictional/authorized.pdf");
    for (const other of [notAuthorized, unselected, work]) expect(await fn("employer_share_document_path", [reviewer, s.id, other])).toBeNull();
    // Even a tampered share row can't serve a work document.
    await db.query("alter table public.employer_shares disable trigger employer_shares_frozen");
    await db.query(`update public.employer_shares set shared_records = (select jsonb_agg(case when r->>'id' = $2 then r || '{"original": true, "kind": "certification"}'::jsonb else r end) from jsonb_array_elements(shared_records) r) where id = $1`, [s.id, work]);
    await db.query("alter table public.employer_shares enable trigger employer_shares_frozen");
    expect(await fn("employer_share_document_path", [reviewer, s.id, work])).toBeNull();

    const got = await fn("employer_share_get", [reviewer, s.id]);
    expect(JSON.stringify(got)).not.toContain(unselected);
    await db.query("update public.evidence set file_hash = $2 where id=$1", [authorized, sha("replaced")]);
    expect(await fn("employer_share_document_path", [reviewer, s.id, authorized])).toBeNull();
    expect((await fn<{ changedRecordIds: string[] }>("employer_share_get", [reviewer, s.id])).changedRecordIds).toEqual([authorized]);

    await expect(db.query("update public.employer_shares set packet = '{}'::jsonb where id=$1", [s.id])).rejects.toThrow(/cannot be changed/);
    await expect(db.query("delete from public.employer_shares where id=$1", [s.id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query("delete from public.employer_share_events where share_id=$1", [s.id])).rejects.toThrow(/append-only/);
    expect(await fn("employer_share_revoke", [w.id, s.id])).toMatchObject({ ok: true, status: "revoked" });
    expect((await fn("employer_share_get", [reviewer, s.id])).reason).toBe("revoked");
    await expect(db.query("update public.employer_shares set status='active' where id=$1", [s.id])).rejects.toThrow(/cannot be reopened/);
    const events = (await db.query("select event from public.employer_share_events where share_id=$1 order by id", [s.id])).rows.map((r) => r.event);
    expect(events).toEqual(["invited", "accepted", "original_opened", "viewed", "viewed", "revoked"]);

    const e2 = addr("later");
    const s2 = await share(w, e2, [{ id: notAuthorized, kind: "certification" }], 1);
    const r2 = await user(e2);
    await fn("employer_share_accept", [s2.token, r2]);
    await db.query("alter table public.employer_shares disable trigger employer_shares_frozen");
    await db.query("update public.employer_shares set expires_at = now() - interval '1 second' where id=$1", [s2.id]);
    await db.query("alter table public.employer_shares enable trigger employer_shares_frozen");
    expect((await fn("employer_share_get", [r2, s2.id])).reason).toBe("expired");
    const list = await fn<{ status: string; workCount: number; certificationCount: number }[]>("employer_share_list_for_worker", [w.id]);
    // (The revoked share was tampered above, which relabelled its work item; counts reflect the row as stored.)
    expect(list.map((x) => [x.status, x.workCount, x.certificationCount])).toEqual([["expired", 0, 1], ["revoked", 0, 3]]);
    expect(JSON.stringify(list)).not.toContain(email);
  });

  it("clients cannot read or write any of it directly", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.query(`set role ${role}`);
      try {
        for (const t of ["employer_shares", "employer_share_events", "review_share_consents"]) {
          await expect(db.query(`select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
        }
        await expect(db.query("select public.employer_share_candidates($1)", [randomUUID()])).rejects.toThrow(/permission denied/);
        await expect(db.query("select public.employer_share_get($1,$2)", [randomUUID(), randomUUID()])).rejects.toThrow(/permission denied/);
      } finally {
        await db.query("reset role");
      }
    }
  });
});
