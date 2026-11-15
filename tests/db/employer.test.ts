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

let url: string;
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
async function worker(name: string) {
  const email = addr(name.toLowerCase());
  const auth = await user(email);
  const r = await fn("account_onboard_worker", [auth, `${name} (fictional)`, "HVAC", null, "employee"]);
  return { auth, id: r.workerId as string, email };
}
async function record(w: { id: string }, storage: string | null = null) {
  const id = randomUUID();
  await db.query(
    `insert into public.evidence (id, worker_id, type, title, source_kind, storage_path, file_hash, verification_status, structured_data)
     values ($1,$2,'work_record',$3,$4,$5,$6,'self_reported','{"activities":["Brazed line set"]}')`,
    [id, w.id, `Fictional job ${id.slice(0, 6)}`, storage ? "pdf_upload" : "manual_text", storage, sha(id)],
  );
  return id;
}
async function report(w: { id: string }) {
  const opp = (await db.query("insert into public.opportunities (worker_id, title, employer) values ($1,'Fictional Installer','Fictional Co') returning id", [w.id])).rows[0].id;
  return (await db.query("insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status) values ($1,$2,0,'completed') returning id", [w.id, opp])).rows[0].id as string;
}
const version = async (id: string) => (await db.query("select version from public.evidence where id=$1", [id])).rows[0].version as number;
async function share(w: { id: string }, run: string, email: string, recs: { id: string; original?: boolean }[], days = 7) {
  // Adding a record marks earlier runs stale (as in the app); this fixture's report is treated as re-run.
  await db.query("update public.match_runs set status = 'completed' where id = $1", [run]);
  const token = sha(`tok-${randomUUID()}`);
  const packet = { format: "employer-packet-v1", technician: { name: "x" }, opportunity: { title: "Fictional Installer" },
    records: await Promise.all(recs.map(async (r) => ({ id: r.id, version: await version(r.id) }))) };
  const r = await fn("employer_share_create", [w.id, run, "employer-packet-v1", JSON.stringify(packet), JSON.stringify(recs.map((x) => ({ id: x.id, original: Boolean(x.original) }))),
    email, sha(`email:${email.toLowerCase()}`), "x***", token, days]);
  return { ...r, id: r.id as string, token };
}

describe.skipIf(!ADMIN_URL)("employer review portal (database)", () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    await admin.query(`create database ${DB_NAME}`);
    await admin.end();
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${DB_NAME}`;
    url = u.toString();
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(readFileSync(join(ROOT, "tests/db/supabase-stubs.sql"), "utf8"));
    for (const f of readdirSync(join(ROOT, "supabase/migrations")).sort()) await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
  });
  afterAll(async () => {
    await db?.end().catch(() => undefined);
  });

  it("only the confirmed account with the invited email can open a share; a forwarded link does nothing", async () => {
    const w = await worker("Wren");
    const run = await report(w);
    const rec = await record(w);
    const email = addr("hiring");
    expect((await share(w, run, w.email, [{ id: rec }])).reason).toBe("own_email");
    const s = await share(w, run, email.toUpperCase(), [{ id: rec }]);
    expect(s.ok).toBe(true);
    expect(await fn("account_has_pending_employer_share", [sha(`email:${email}`)])).toBe(true);
    expect(await fn("employer_share_peek", [s.token])).toMatchObject({ ok: true, status: "pending", workerName: "Wren (fictional)", emailHint: "x***" });

    const stranger = await user(addr("stranger"));
    expect((await fn("employer_share_accept", [s.token, stranger])).reason).toBe("wrong_account");
    expect((await fn("employer_share_accept", [s.token, await user(email + ".x", true)])).reason).toBe("wrong_account");
    expect((await fn("employer_share_accept", [s.token, w.auth])).reason).toBe("self");
    const unconfirmed = await user(addr("unconfirmed"), false);
    expect((await fn("employer_share_accept", [s.token, unconfirmed])).reason).toBe("email_unconfirmed");
    // Stranger cannot read by id either.
    expect((await fn("employer_share_get", [stranger, s.id])).reason).toBe("not_found");

    const reviewer = await user(email);
    expect(await fn("employer_share_accept", [s.token, reviewer])).toMatchObject({ ok: true, id: s.id });
    const row = (await db.query("select invited_email, token_hash, status from public.employer_shares where id=$1", [s.id])).rows[0];
    expect(row).toEqual({ invited_email: null, token_hash: null, status: "active" });
    expect(await fn("employer_share_accept", [s.token, reviewer])).toMatchObject({ ok: true, repeated: true });
    expect((await fn("employer_share_accept", [s.token, stranger])).reason).toBe("wrong_account"); // forwarded after acceptance
    expect(await fn("employer_share_peek", [s.token])).toMatchObject({ answered: true, workerName: null, emailHint: null });
    expect(await fn("account_has_pending_employer_share", [sha(`email:${email}`)])).toBe(false);

    const got = await fn("employer_share_get", [reviewer, s.id]);
    expect(got).toMatchObject({ ok: true, changedRecordIds: [] });
    expect((await fn("employer_share_get", [stranger, s.id])).reason).toBe("not_found");
    // Opening a share grants no supervisor role and no relationship.
    expect((await db.query("select count(*)::int n from public.supervisor_profiles where auth_user_id=$1", [reviewer])).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from public.supervisor_relationships where supervisor_auth_user_id=$1", [reviewer])).rows[0].n).toBe(0);
  });

  it("the packet is frozen, records outside the worker are refused, and edits show as changed", async () => {
    const w = await worker("Ash");
    const other = await worker("Other");
    const run = await report(w);
    const mine = await record(w);
    const theirs = await record(other);
    expect((await share(w, run, addr("hr"), [{ id: theirs }])).reason).toBe("not_found");
    expect((await share(w, await report(other), addr("hr"), [{ id: mine }])).reason).toBe("no_report");
    expect((await share(w, run, addr("hr"), [{ id: mine, original: true }])).reason).toBe("no_original");
    // A report made out of date by later record changes can't be shared.
    expect((await share(w, run, addr("hr"), [{ id: mine }])).ok).toBe(true);
    await record(w);
    expect((await fn("employer_share_create", [w.id, run, "f", JSON.stringify({ records: [{ id: mine, version: await version(mine) }] }),
      JSON.stringify([{ id: mine, original: false }]), addr("hr"), sha(randomUUID()), "x***", sha(randomUUID()), 7])).reason).toBe("no_report");
    await db.query("update public.match_runs set status = 'completed' where id = $1", [run]);
    // Packet claiming a stale version is refused.
    const token = sha(randomUUID());
    const stale = await fn("employer_share_create", [w.id, run, "employer-packet-v1", JSON.stringify({ records: [{ id: mine, version: 99 }] }),
      JSON.stringify([{ id: mine, original: false }]), addr("hr"), sha(randomUUID()), "x***", token, 7]);
    expect(stale.reason).toBe("changed");
    // Packet listing a record that is not in the selection is refused.
    const extra = await fn("employer_share_create", [w.id, run, "employer-packet-v1", JSON.stringify({ records: [{ id: mine, version: await version(mine) }, { id: theirs, version: 1 }] }),
      JSON.stringify([{ id: mine, original: false }]), addr("hr"), sha(randomUUID()), "x***", sha(randomUUID()), 7]);
    expect(extra.reason).toBe("invalid");

    const email = addr("hr");
    const s = await share(w, run, email, [{ id: mine }]);
    const reviewer = await user(email);
    await fn("employer_share_accept", [s.token, reviewer]);
    await expect(db.query("update public.employer_shares set packet = '{}'::jsonb where id=$1", [s.id])).rejects.toThrow(/cannot be changed/);
    await expect(db.query("update public.employer_shares set expires_at = now() + interval '90 days' where id=$1", [s.id])).rejects.toThrow(/cannot be changed/);
    await expect(db.query("delete from public.employer_shares where id=$1", [s.id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query("delete from public.employer_share_events where share_id=$1", [s.id])).rejects.toThrow(/append-only/);

    await db.query("update public.evidence set title = 'Edited (fictional)' where id=$1", [mine]);
    expect((await fn("employer_share_get", [reviewer, s.id])).changedRecordIds).toEqual([mine]);
  });

  it("originals open only when shared, at the shared version, while active; revocation and expiry end access", async () => {
    const w = await worker("Rowan");
    const run = await report(w);
    const withDoc = await record(w, "fictional/shared.pdf");
    const notShared = await record(w, "fictional/private.pdf");
    const email = addr("lead");
    const s = await share(w, run, email, [{ id: withDoc, original: true }, { id: notShared, original: false }]);
    const reviewer = await user(email);
    expect(await fn("employer_share_document_path", [reviewer, s.id, withDoc])).toBeNull(); // not yet accepted
    await fn("employer_share_accept", [s.token, reviewer]);
    expect(await fn("employer_share_document_path", [reviewer, s.id, withDoc])).toBe("fictional/shared.pdf");
    expect(await fn("employer_share_document_path", [reviewer, s.id, notShared])).toBeNull();
    expect(await fn("employer_share_document_path", [await user(addr("x")), s.id, withDoc])).toBeNull();
    const events = (await db.query("select event from public.employer_share_events where share_id=$1 order by id", [s.id])).rows.map((r) => r.event);
    expect(events).toEqual(["invited", "accepted", "original_opened"]);

    await db.query("update public.evidence set file_hash = $2 where id=$1", [withDoc, sha("replaced")]);
    expect(await fn("employer_share_document_path", [reviewer, s.id, withDoc])).toBeNull(); // replaced file is never served

    expect(await fn("employer_share_revoke", [w.id, s.id])).toMatchObject({ ok: true, status: "revoked" });
    expect((await fn("employer_share_get", [reviewer, s.id])).reason).toBe("revoked");
    expect((await fn("employer_share_revoke", [(await worker("Nope")).id, s.id])).reason).toBe("not_found");
    await expect(db.query("update public.employer_shares set status='active' where id=$1", [s.id])).rejects.toThrow(/cannot be reopened/);

    const e2 = addr("later");
    const s2 = await share(w, run, e2, [{ id: withDoc }], 1);
    const r2 = await user(e2);
    await fn("employer_share_accept", [s2.token, r2]);
    await db.query("alter table public.employer_shares disable trigger employer_shares_frozen");
    await db.query("update public.employer_shares set expires_at = now() - interval '1 second' where id=$1", [s2.id]);
    await db.query("alter table public.employer_shares enable trigger employer_shares_frozen");
    expect((await fn("employer_share_get", [r2, s2.id])).reason).toBe("expired");
    const list = await fn<{ id: string; status: string; views: number }[]>("employer_share_list_for_worker", [w.id]);
    expect(list.map((x) => x.status).sort()).toEqual(["expired", "revoked"]);
    expect(JSON.stringify(list)).not.toContain(email);
  });

  it("supervisor consent is explicit, only by the reviewer, only for confirmations and only at decision time", async () => {
    const w = await worker("Kai");
    const semail = addr("sup");
    const sauth = await user(semail);
    await fn("account_onboard_supervisor", [sauth, "Sky (fictional)", "Fictional Mech", "Lead"]);
    const inv = await fn("sup_invite_create", [w.id, semail, sha(`email:${semail}`), "x***", sha("t1" + semail), 14]);
    const rel = (await fn("sup_invite_answer", [sha("t1" + semail), sauth, true])).relationshipId;
    expect(inv.ok).toBe(true);
    const old = await fn("review_create", [w.id, await record(w), rel, 30, false]);
    const fresh = await fn("review_create", [w.id, await record(w), rel, 30, false]);
    const declined = await fn("review_create", [w.id, await record(w), rel, 30, false]);
    for (const q of [old, fresh]) expect(await fn("review_respond", [sauth, q.id, "confirm_observed", JSON.stringify(["Brazed line set"]), null, "supervisor-review-v1"])).toMatchObject({ ok: true });
    await fn("review_respond", [sauth, declined.id, "decline", null, null, "supervisor-review-v1"]);
    // An older review: consent is never recorded after the fact.
    await db.query("alter table public.review_responses disable trigger review_responses_frozen");
    await db.query("update public.review_responses set created_at = now() - interval '1 day' where request_id=$1", [old.id]);
    await db.query("alter table public.review_responses enable trigger review_responses_frozen");
    expect((await fn("review_record_share_consent", [sauth, old.id, "v"])).reason).toBe("too_late");
    expect((await fn("review_record_share_consent", [w.auth, fresh.id, "v"])).reason).toBe("not_found");
    expect((await fn("review_record_share_consent", [sauth, declined.id, "v"])).reason).toBe("not_confirmation");
    expect(await fn("review_record_share_consent", [sauth, fresh.id, "v"])).toMatchObject({ ok: true });
    expect(await fn("review_share_consented", [w.id])).toEqual([fresh.id]);
  });

  it("clients cannot read or write any of it directly", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.query(`set role ${role}`);
      try {
        for (const t of ["employer_shares", "employer_share_events", "review_share_consents"]) {
          await expect(db.query(`select * from public.${t} limit 1`)).rejects.toThrow(/permission denied/);
        }
        await expect(db.query("select public.employer_share_get($1,$2)", [randomUUID(), randomUUID()])).rejects.toThrow(/permission denied/);
      } finally {
        await db.query("reset role");
      }
    }
  });
});
