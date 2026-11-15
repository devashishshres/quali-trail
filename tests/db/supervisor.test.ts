/**
 * Accounts, supervisor relationships and supervisor review (database). DISPOSABLE PostgreSQL only;
 * drops and recreates `qualitrail_supervisor_test`. Fictional test identities only.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_supervisor_test";
const ROOT = join(__dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let url: string;
let db: Client;
const clients: Client[] = [];
const newClient = async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
};
type R = Record<string, unknown> & { ok: boolean; reason?: string };
async function fn(c: Client, name: string, args: unknown[]): Promise<R> {
  await c.query("set role service_role");
  try {
    return (await c.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as r`, args)).rows[0].r as R;
  } finally {
    await c.query("reset role");
  }
}

/** A fictional auth user. confirmed=false models an unverified signup. */
async function user(email: string, confirmed = true) {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1,$2,$3)", [id, email, confirmed ? new Date() : null]);
  return id;
}
async function worker(name: string) {
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}.${randomUUID().slice(0, 6)}@test.qualitrail.dev`;
  const auth = await user(email);
  const r = await fn(db, "account_onboard_worker", [auth, `${name} (fictional)`, "HVAC", null, "employee"]);
  return { auth, id: r.workerId as string, email };
}
async function supervisor(name: string, email = `${name.toLowerCase()}.${randomUUID().slice(0, 6)}@test.qualitrail.dev`) {
  const auth = await user(email);
  await fn(db, "account_onboard_supervisor", [auth, `${name} (fictional)`, "Fictional Mechanical", "Lead"]);
  return { auth, email };
}
async function invite(w: { id: string }, email: string) {
  const token = sha(`tok-${randomUUID()}`);
  const r = await fn(db, "sup_invite_create", [w.id, email, sha(`email:${email.toLowerCase()}`), "x***", token, 14]);
  return { ...r, id: r.id as string, token };
}
async function connect(w: { id: string }, s: { auth: string; email: string }) {
  const inv = await invite(w, s.email);
  expect(inv.ok).toBe(true);
  const a = await fn(db, "sup_invite_answer", [inv.token, s.auth, true]);
  expect(a.ok).toBe(true);
  return a.relationshipId as string;
}
async function job(w: { id: string }, opts: { type?: string; status?: string; storage?: string | null; activities?: string[] } = {}) {
  const id = randomUUID();
  await db.query(
    `insert into public.evidence (id, worker_id, type, title, source_kind, storage_path, file_hash, verification_status, structured_data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, w.id, opts.type ?? "work_record", `Job ${id.slice(0, 6)}`, opts.storage ? "pdf_upload" : "manual_text", opts.storage ?? null, sha(id),
     opts.status ?? (opts.storage ? "document_supplied" : "self_reported"),
     JSON.stringify({ activities: opts.activities ?? ["Brazed line set", "Pulled vacuum to 500 microns", "Charged by subcooling"], equipment: ["3-ton heat pump"] })],
  );
  return id;
}

describe.skipIf(!ADMIN_URL)("accounts and supervisor review (database)", () => {
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
    for (const f of readdirSync(join(ROOT, "supabase/migrations")).sort()) await db.query(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"));
  });
  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
  });

  it("onboarding is idempotent and one person can be both worker and supervisor", async () => {
    const auth = await user(`dual.${randomUUID().slice(0, 6)}@test.qualitrail.dev`);
    const a = await fn(db, "account_onboard_worker", [auth, "Dana Dual (fictional)", "HVAC", "  ", "contractor"]);
    const b = await fn(db, "account_onboard_worker", [auth, "Someone Else", "Plumbing", null, null]);
    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toMatchObject({ ok: true, created: false, workerId: a.workerId });
    const row = (await db.query("select name, summary, employment_arrangement, is_synthetic from public.workers where id=$1", [a.workerId])).rows[0];
    expect(row).toEqual({ name: "Dana Dual (fictional)", summary: null, employment_arrangement: "contractor", is_synthetic: false });
    expect((await fn(db, "account_onboard_supervisor", [auth, "Dana Dual (fictional)", null, null])).created).toBe(true);
    expect((await fn(db, "account_onboard_supervisor", [auth, "Changed", null, null])).created).toBe(false);
    // Concurrent double-submit creates exactly one worker row.
    const auth2 = await user(`race.${randomUUID().slice(0, 6)}@test.qualitrail.dev`);
    const cs = await Promise.all([newClient(), newClient(), newClient()]);
    const out = await Promise.all(cs.map((c) => fn(c, "account_onboard_worker", [auth2, "Race (fictional)", "HVAC", null, null])));
    expect(new Set(out.map((o) => o.workerId)).size).toBe(1);
    expect(out.filter((o) => o.created)).toHaveLength(1);
  });

  it("an invitation is accepted only by a confirmed account with the invited email, never by the worker", async () => {
    const w = await worker("Wren");
    const s = await supervisor("Sky");
    expect((await invite(w, w.email)).reason).toBe("own_email");
    const inv = await invite(w, s.email.toUpperCase());
    expect(inv.ok).toBe(true);

    const stranger = await supervisor("Stranger");
    expect((await fn(db, "sup_invite_answer", [inv.token, stranger.auth, true])).reason).toBe("wrong_account"); // forwarded link
    const unconfirmed = await user(`un.${randomUUID().slice(0, 6)}@test.qualitrail.dev`, false);
    expect((await fn(db, "sup_invite_answer", [inv.token, unconfirmed, true])).reason).toBe("email_unconfirmed");
    expect((await fn(db, "sup_invite_answer", [inv.token, w.auth, true])).reason).toBe("self");

    // Right email but no supervisor profile yet.
    const s2email = `noprofile.${randomUUID().slice(0, 6)}@test.qualitrail.dev`;
    const s2auth = await user(s2email);
    const inv2 = await invite(w, s2email);
    expect((await fn(db, "sup_invite_answer", [inv2.token, s2auth, true])).reason).toBe("needs_profile");

    const ok = await fn(db, "sup_invite_answer", [inv.token, s.auth, true]);
    expect(ok).toMatchObject({ ok: true, status: "accepted" });
    const row = (await db.query("select invited_email, token_hash, email_hint from public.supervisor_relationships where id=$1", [ok.relationshipId])).rows[0];
    expect(row).toEqual({ invited_email: null, token_hash: null, email_hint: "x***" }); // address dropped, link dead
    expect((await fn(db, "sup_invite_answer", [inv.token, s.auth, true])).ok).toBe(false); // the link no longer works
    expect((await invite(w, s.email)).reason).toBe("already_connected");
  });

  it("a worker can't be their own supervisor even through a hand-made relationship", async () => {
    const w = await worker("Solo");
    await fn(db, "account_onboard_supervisor", [w.auth, "Solo (fictional)", null, null]);
    const token = sha(`t-${randomUUID()}`);
    await db.query("insert into public.supervisor_relationships (worker_id, invited_email, invited_email_hash, token_hash, expires_at) values ($1,$2,'h',$3, now() + interval '1 day')", [w.id, w.email, token]);
    expect((await fn(db, "sup_invite_answer", [token, w.auth, true])).reason).toBe("self");
  });

  it("many workers per supervisor and many supervisors per worker, with strict isolation", async () => {
    const w1 = await worker("Ash");
    const w2 = await worker("Birch");
    const s1 = await supervisor("Cedar");
    const s2 = await supervisor("Dune");
    const rel11 = await connect(w1, s1);
    const rel21 = await connect(w2, s1);
    const rel12 = await connect(w1, s2);
    const j1 = await job(w1);
    const j2 = await job(w2);
    const q11 = await fn(db, "review_create", [w1.id, j1, rel11, 30]);
    const q21 = await fn(db, "review_create", [w2.id, j2, rel21, 30]);
    expect(q11.ok && q21.ok).toBe(true);
    // A worker can't use another worker's relationship or record.
    expect((await fn(db, "review_create", [w1.id, j1, rel21, 30])).reason).toBe("no_relationship");
    expect((await fn(db, "review_create", [w1.id, j2, rel11, 30])).reason).toBe("not_found");

    const s1list = (await fn(db, "review_list_for_supervisor", [s1.auth])) as unknown as { id: string }[];
    expect(s1list.map((x) => x.id).sort()).toEqual([q11.id, q21.id].sort());
    const s2list = (await fn(db, "review_list_for_supervisor", [s2.auth])) as unknown as { id: string }[];
    expect(s2list).toEqual([]); // connected to w1 but nothing was sent to them
    expect((await fn(db, "review_get", [s2.auth, q11.id])).reason).toBe("not_found");
    expect((await fn(db, "review_respond", [s2.auth, q11.id, "decline", null, null, "v1"])).reason).toBe("not_found");
    expect(rel12).toBeTruthy();
  });

  it("only eligible work records and checklists can be sent, one open request per supervisor", async () => {
    const w = await worker("Elm");
    const s = await supervisor("Fir");
    const rel = await connect(w, s);
    expect((await fn(db, "review_create", [w.id, await job(w, { type: "certification" }), rel, 30])).reason).toBe("unsupported_type");
    const pending = await job(w);
    await db.query("update public.evidence set verification_status='pending_review' where id=$1", [pending]);
    expect((await fn(db, "review_create", [w.id, pending, rel, 30])).reason).toBe("not_eligible");
    const j = await job(w, { type: "checklist" });
    expect((await fn(db, "review_create", [w.id, j, rel, 30])).ok).toBe(true);
    expect((await fn(db, "review_create", [w.id, j, rel, 30])).reason).toBe("duplicate_open");
  });

  it("decisions record exact scope; tasks must come from the snapshot; documents only when one exists", async () => {
    const w = await worker("Gale");
    const s = await supervisor("Hale");
    const rel = await connect(w, s);
    const noDoc = await fn(db, "review_create", [w.id, await job(w), rel, 30]);
    expect((await fn(db, "review_respond", [s.auth, noDoc.id, "confirm_observed", JSON.stringify([]), null, "v1"])).reason).toBe("tasks_required");
    expect((await fn(db, "review_respond", [s.auth, noDoc.id, "confirm_observed", JSON.stringify(["Installed solar panels"]), null, "v1"])).reason).toBe("unknown_task");
    expect((await fn(db, "review_respond", [s.auth, noDoc.id, "confirm_observed", JSON.stringify(["Brazed line set", "Brazed line set"]), null, "v1"])).reason).toBe("unknown_task");
    expect((await fn(db, "review_respond", [s.auth, noDoc.id, "confirm_documents_reviewed", null, null, "v1"])).reason).toBe("no_document");
    expect((await fn(db, "review_respond", [s.auth, noDoc.id, "request_correction", null, " ", "v1"])).reason).toBe("comment_required");
    const ok = await fn(db, "review_respond", [s.auth, noDoc.id, "confirm_observed", JSON.stringify(["Pulled vacuum to 500 microns"]), "Seen on site", "v1"]);
    expect(ok).toMatchObject({ ok: true, status: "confirmed_observed" });
    const resp = (await db.query("select observed_tasks, reviewer_name, reviewer_organization, snapshot_hash from public.review_responses where request_id=$1", [noDoc.id])).rows[0];
    expect(resp.observed_tasks).toEqual(["Pulled vacuum to 500 microns"]);
    expect(resp.reviewer_name).toBe("Hale (fictional)");

    const withDoc = await fn(db, "review_create", [w.id, await job(w, { storage: "fictional/doc.pdf" }), rel, 30]);
    expect((await fn(db, "review_respond", [s.auth, withDoc.id, "confirm_documents_reviewed", null, null, "v1"])).status).toBe("confirmed_documents");
  });

  it("identical retries are idempotent, conflicting answers refused, concurrent answers produce one response", async () => {
    const w = await worker("Iris");
    const s = await supervisor("Jade");
    const rel = await connect(w, s);
    const q = await fn(db, "review_create", [w.id, await job(w), rel, 30]);
    const tasks = JSON.stringify(["Brazed line set"]);
    const cs = await Promise.all([newClient(), newClient(), newClient(), newClient()]);
    const out = await Promise.all(cs.map((c, i) => fn(c, "review_respond", [s.auth, q.id, i % 2 ? "confirm_observed" : "decline", i % 2 ? tasks : null, null, "v1"])));
    expect(out.filter((o) => o.ok && o.repeated === false)).toHaveLength(1);
    expect((await db.query("select count(*)::int n from public.review_responses where request_id=$1", [q.id])).rows[0].n).toBe(1);
    const winner = (await db.query("select decision from public.review_responses where request_id=$1", [q.id])).rows[0].decision;
    const same = await fn(db, "review_respond", [s.auth, q.id, winner, winner === "confirm_observed" ? tasks : null, null, "v1"]);
    expect(same).toMatchObject({ ok: true, repeated: true });
    const other = winner === "decline" ? "request_correction" : "decline";
    expect((await fn(db, "review_respond", [s.auth, q.id, other, null, "x", "v1"])).reason).toBe("already_responded");
  });

  it("revoking stops access and pending decisions but keeps completed reviews", async () => {
    const w = await worker("Kai");
    const s = await supervisor("Lark");
    const rel = await connect(w, s);
    const done = await fn(db, "review_create", [w.id, await job(w), rel, 30]);
    await fn(db, "review_respond", [s.auth, done.id, "decline", null, "Not on that job", "v1"]);
    const pending = await fn(db, "review_create", [w.id, await job(w), rel, 30]);
    const other = await worker("Other");
    expect((await fn(db, "sup_relationship_revoke", [other.auth, rel])).reason).toBe("not_found"); // a stranger can't revoke
    expect(await fn(db, "sup_relationship_revoke", [w.auth, rel])).toMatchObject({ ok: true, closedReviews: 1 });
    expect((await db.query("select status from public.review_requests where id=$1", [pending.id])).rows[0].status).toBe("revoked");
    expect((await fn(db, "review_respond", [s.auth, pending.id, "decline", null, null, "v1"])).ok).toBe(false);
    expect(await fn(db, "review_list_for_supervisor", [s.auth])).toEqual([]);
    expect((await fn(db, "review_get", [s.auth, done.id])).reason).toBe("not_found");
    // History kept for the worker.
    expect((await db.query("select count(*)::int n from public.review_responses where request_id=$1", [done.id])).rows[0].n).toBe(1);
    expect((await fn(db, "review_create", [w.id, await job(w), rel, 30])).reason).toBe("no_relationship");
    // The supervisor can also end it (on a fresh relationship).
    const rel2 = await connect(w, s);
    expect((await fn(db, "sup_relationship_revoke", [s.auth, rel2])).ok).toBe(true);
  });

  it("an edit supersedes the pending review, blocks the decision, and hides the document", async () => {
    const w = await worker("Moss");
    const s = await supervisor("Nash");
    const rel = await connect(w, s);
    const e = await job(w, { storage: "fictional/x.pdf" });
    const q = await fn(db, "review_create", [w.id, e, rel, 30]);
    expect((await svcText(db, "review_document_path", [s.auth, q.id]))).toBe("fictional/x.pdf");
    const stranger = await supervisor("Other2");
    expect(await svcText(db, "review_document_path", [stranger.auth, q.id])).toBeNull();
    await db.query("update public.evidence set title='Edited' where id=$1", [e]);
    expect((await db.query("select status from public.review_requests where id=$1", [q.id])).rows[0].status).toBe("superseded");
    expect(await svcText(db, "review_document_path", [s.auth, q.id])).toBeNull();
    expect((await fn(db, "review_respond", [s.auth, q.id, "confirm_documents_reviewed", null, null, "v1"])).ok).toBe(false);
  });

  it("completed reviews and snapshots are immutable; reviews never change verification status", async () => {
    const w = await worker("Oak");
    const s = await supervisor("Pine");
    const rel = await connect(w, s);
    const e = await job(w, { storage: "fictional/y.pdf" });
    const q = await fn(db, "review_create", [w.id, e, rel, 30]);
    await fn(db, "review_respond", [s.auth, q.id, "confirm_documents_reviewed", null, null, "v1"]);
    await expect(db.query("update public.review_requests set snapshot='{}' where id=$1", [q.id])).rejects.toThrow(/immutable/);
    await expect(db.query("update public.review_requests set status='declined' where id=$1", [q.id])).rejects.toThrow(/cannot change/);
    await expect(db.query("update public.review_responses set comment='x' where request_id=$1", [q.id])).rejects.toThrow(/immutable/);
    await expect(db.query("delete from public.review_responses where request_id=$1", [q.id])).rejects.toThrow(/immutable/);
    expect((await db.query("select verification_status, version from public.evidence where id=$1", [e])).rows[0]).toEqual({ verification_status: "document_supplied", version: 1 });
  });

  it("invite-only signup: an address may register while it holds an open invitation", async () => {
    const w = await worker("Quill");
    const email = `invitee.${randomUUID().slice(0, 6)}@test.qualitrail.dev`;
    const h = sha(`email:${email}`);
    expect((await fn(db, "account_has_pending_invite", [h])) as unknown).toBe(false);
    await invite(w, email);
    expect((await fn(db, "account_has_pending_invite", [h])) as unknown).toBe(true);
  });

  it("reminders are bounded and expired invitations close", async () => {
    const w = await worker("Reed");
    const inv = await invite(w, `rem.${randomUUID().slice(0, 6)}@test.qualitrail.dev`);
    expect((await fn(db, "sup_invite_rotate", [w.id, inv.id, sha("n1")])).reason).toBe("too_soon");
    for (let i = 0; i < 3; i++) {
      await db.query("update public.supervisor_relationships set last_invited_at = now() - interval '2 days' where id=$1", [inv.id]);
      expect((await fn(db, "sup_invite_rotate", [w.id, inv.id, sha(`n${i + 2}`)])).ok).toBe(true);
    }
    await db.query("update public.supervisor_relationships set last_invited_at = now() - interval '2 days' where id=$1", [inv.id]);
    expect((await fn(db, "sup_invite_rotate", [w.id, inv.id, sha("n9")])).reason).toBe("limit");
    await db.query("update public.supervisor_relationships set expires_at = now() - interval '1 minute' where id=$1", [inv.id]);
    expect((await fn(db, "sup_invite_peek", [sha("n4")])).status).toBe("expired");
  });

  it("purge removes unaccepted invitation addresses after 90 days", async () => {
    const w = await worker("Sage");
    const inv = await invite(w, `purge.${randomUUID().slice(0, 6)}@test.qualitrail.dev`);
    await fn(db, "sup_relationship_revoke", [w.auth, inv.id]);
    await db.query("update public.supervisor_relationships set closed_at = now() - interval '91 days' where id=$1", [inv.id]);
    await fn(db, "sup_purge_pii", [90]);
    expect((await db.query("select invited_email, invited_email_hash, email_hint from public.supervisor_relationships where id=$1", [inv.id])).rows[0]).toEqual({ invited_email: null, invited_email_hash: null, email_hint: null });
  });

  it("client roles can read only their own supervisor profile and nothing else", async () => {
    const s = await supervisor("Tarn");
    const other = await supervisor("Umber");
    const c = await newClient();
    await c.query("set role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [s.auth]);
    try {
      const rows = (await c.query("select auth_user_id from public.supervisor_profiles")).rows;
      expect(rows.map((r) => r.auth_user_id)).toEqual([s.auth]);
      expect(rows.map((r) => r.auth_user_id)).not.toContain(other.auth);
      await expect(c.query("insert into public.supervisor_profiles (auth_user_id, name) values ($1,'x')", [s.auth])).rejects.toThrow(/permission denied/);
      for (const t of ["supervisor_relationships", "review_requests", "review_responses", "review_events"]) {
        await expect(c.query(`select * from public.${t}`)).rejects.toThrow(/permission denied/);
      }
      await expect(c.query("select public.review_list_for_supervisor($1)", [s.auth])).rejects.toThrow(/permission denied/);
      await expect(c.query("select public.account_onboard_worker($1,'x','y',null,null)", [s.auth])).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("reset role");
    }
  });
});

async function svcText(c: Client, name: string, args: unknown[]): Promise<string | null> {
  await c.query("set role service_role");
  try {
    return (await c.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as r`, args)).rows[0].r;
  } finally {
    await c.query("reset role");
  }
}
