/**
 * Employer sharing routes, technician and reviewer, driven against a DISPOSABLE local PostgreSQL
 * (`qualitrail_employer_routes_test`). Sign-in and email are simulated; no Supabase project, mail or storage is
 * contacted. Fictional identities only.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_employer_routes_test";
const ROOT = join(__dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let db: Client;
const logged: string[] = [];
const signed: string[] = [];
const sent: { kind: string; to: string; text: string }[] = [];
type Acct = { id: string; email: string; confirmed: boolean } | null;
let current: Acct = null;
let asWorker: { id: string; name: string; trade: string; is_synthetic: boolean } | null = null;

let signoffCookie: string | undefined;
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (signoffCookie ? { value: signoffCookie } : undefined) }), headers: async () => new Headers() }));
vi.mock("@/lib/server/signoff/notify", () => ({ notifyCustomerDecision: async () => undefined }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/lib/api/auth", () => ({
  getAccount: async () => current && { supabase: null, user: { id: current.id, email: current.email, emailConfirmed: current.confirmed }, worker: null, supervisor: null },
  getAuthedContext: async () => asWorker && { supabase: null, authUserId: "x", worker: asWorker },
  getSupervisorContext: async () => current && { supabase: null, user: { id: current.id, email: current.email, emailConfirmed: true }, worker: null, supervisor: { auth_user_id: current.id, name: "Sky (fictional)", organization: null, title: null } },
}));
vi.mock("@/lib/server/accounts/notify", () => ({ notifyReviewDecided: async () => undefined }));
vi.mock("@/lib/server/email/deliver", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/email/deliver")>()),
  deliver: async (m: { kind: string; to: string; rendered: { text: string } }) => { sent.push({ kind: m.kind, to: m.to, text: m.rendered.text }); return { ok: true, mode: "mock", duplicate: false }; },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const keys = Object.keys(args);
      const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as data`;
      await db.query("set role service_role");
      try {
        return { data: (await db.query(sql, keys.map((k) => (typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k])))).rows[0].data, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code ?? "x" } };
      } finally {
        await db.query("reset role");
      }
    },
    storage: { from: () => ({ createSignedUrl: async (path: string) => { signed.push(path); return { data: { signedUrl: `https://storage.test/signed/${encodeURIComponent(path)}?token=SIGNED-SECRET` }, error: null }; } }) },
  }),
}));

const req = (path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
  new Request(`http://x.test${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init.token ? { "x-signoff-token": init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const body = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
async function user(email: string, confirmed = true) {
  const id = randomUUID();
  await db.query("insert into auth.users (id, email, email_confirmed_at) values ($1,$2,$3)", [id, email, confirmed ? new Date() : null]);
  return { id, email, confirmed };
}
const sql = async (q: string, a: unknown[] = []) => { await db.query("set role service_role"); try { return (await db.query(q, a)).rows[0]?.r; } finally { await db.query("reset role"); } };

const R = {
  shares: () => import("@/app/api/employer-shares/route"),
  preview: () => import("@/app/api/employer-shares/preview/route"),
  candidates: () => import("@/app/api/employer-shares/candidates/route"),
  mine: () => import("@/app/api/employer-shares/[id]/route"),
  peek: () => import("@/app/api/employer/invite/peek/route"),
  accept: () => import("@/app/api/employer/invite/accept/route"),
  list: () => import("@/app/api/employer/shares/route"),
  get: () => import("@/app/api/employer/shares/[id]/route"),
  doc: () => import("@/app/api/employer/shares/[id]/document/route"),
};

// Fictional technician with: one permitted+named job, one permitted anonymous job, one unconfirmed job, one job
// whose confirmation has no sharing permission, two uploaded certificates and one training record.
let W: { id: string; auth: string; email: string };
let jobNamed: string, jobAnon: string, jobNone: string, jobOld: string, certA: string, certB: string, training: string, supAuth: string, rel: string;
async function record(type: string, storage: string | null, title: string) {
  const id = randomUUID();
  await db.query(`insert into public.evidence (id, worker_id, type, title, issuer, source_kind, storage_path, file_hash, verification_status, structured_data)
    values ($1,$2,$3,$4,'Fictional Issuer',$5,$6,$7,$8,$9)`, [id, W.id, type, title, storage ? "pdf_upload" : "manual_text", storage, sha(id), storage ? "document_supplied" : "self_reported",
    JSON.stringify({ activities: ["Brazed line set"], equipment: ["Secret equipment list"], summary: "Customer Pat Example at 12 Fictional Lane", credentialNumber: "CRED-SECRET-123" })]);
  return id;
}
async function confirm(rec: string, consent?: boolean) {
  const q = await sql("select public.review_create($1,$2,$3,30,false) as r", [W.id, rec, rel]);
  await sql("select public.review_respond($1,$2,'confirm_observed',$3,'Private supervisor comment','supervisor-review-v1') as r", [supAuth, q.id, JSON.stringify(["Brazed line set"])]);
  if (consent !== undefined) await sql("select public.review_record_share_consent($1,$2,'v2',$3) as r", [supAuth, q.id, consent]);
}

describe.skipIf(!ADMIN_URL)("employer sharing routes (local database)", () => {
  beforeAll(async () => {
    process.env.SIGNOFF_PEPPER = "e".repeat(48);
    process.env.SUPERVISOR_REVIEW_ENABLED = "true";
    process.env.EMAIL_MODE = "mock";
    process.env.APP_BASE_URL = "http://localhost:3100";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
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
    const wu = await user(`tech.${randomUUID().slice(0, 6)}@test.qualitrail.dev`);
    const id = randomUUID();
    await db.query("insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,'Test Tech (fictional)','HVAC',true)", [id, wu.id]);
    W = { id, auth: wu.id, email: wu.email };
    const s = await user(`sup.${randomUUID().slice(0, 6)}@test.qualitrail.dev`);
    supAuth = s.id;
    await sql("select public.account_onboard_supervisor($1,'Sky Reviewer (fictional)','Fictional Mech','Lead') as r", [supAuth]);
    await sql("select public.sup_invite_create($1,$2,'h','x***','t1',14) as r", [W.id, s.email]);
    rel = (await sql("select public.sup_invite_answer('t1',$1,true) as r", [supAuth])).relationshipId;
    jobNamed = await record("work_record", "fictional/work-order.pdf", "Heat-pump install (fictional)");
    jobAnon = await record("checklist", null, "Commissioning checklist (fictional)");
    jobNone = await record("work_record", null, "Unconfirmed job (fictional)");
    jobOld = await record("work_record", null, "Older confirmed job (fictional)");
    certA = await record("certification", "fictional/epa.pdf", "EPA 608 (fictional)");
    certB = await record("certification", "fictional/nate.pdf", "NATE (fictional)");
    training = await record("training", "fictional/training.pdf", "Training (fictional)");
    await confirm(jobNamed, true);
    await confirm(jobAnon, false);
    await confirm(jobOld);
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(() => {
    process.env.EMPLOYER_REVIEW_ENABLED = "true";
    current = null;
    asWorker = { id: W.id, name: "Test Tech (fictional)", trade: "HVAC", is_synthetic: true };
    logged.length = 0; signed.length = 0; sent.length = 0;
    vi.spyOn(console, "error").mockImplementation((...a) => { logged.push(JSON.stringify(a)); });
    vi.spyOn(console, "log").mockImplementation((...a) => { logged.push(JSON.stringify(a)); });
  });

  it("candidates list only eligible work and uploaded certificates, with honest withheld counts", async () => {
    const c = await body(await (await R.candidates()).GET());
    expect(c.status).toBe(200);
    const work = Object.fromEntries(c.body.work.map((w: { id: string; eligible: boolean; withheldCount: number }) => [w.id, [w.eligible, w.withheldCount]]));
    expect(work[jobNamed]).toEqual([true, 0]);
    expect(work[jobAnon]).toEqual([true, 0]);
    expect(work[jobNone]).toEqual([false, 0]);
    expect(work[jobOld]).toEqual([false, 1]);
    expect(c.body.certifications.map((x: { id: string }) => x.id).sort()).toEqual([certA, certB].sort());
    expect(JSON.stringify(c.body)).not.toContain(training);
  });

  it("the server refuses excluded items however they are requested", async () => {
    const preview = (await R.preview()).POST;
    const p = async (b: unknown) => body(await preview(req("/x", { method: "POST", body: b })));
    expect((await p({ workIds: [jobNone] })).status).toBe(400);           // unconfirmed work
    expect((await p({ workIds: [jobOld] })).status).toBe(400);            // confirmation without permission
    expect((await p({ certificationIds: [training] })).status).toBe(400); // other record type
    expect((await p({ certificationIds: [jobNamed] })).status).toBe(400); // work as a certificate
    expect((await p({ workIds: [jobNamed], originalIds: [jobNamed] })).status).toBe(400); // a work document
    expect((await p({ certificationIds: [certA], originalIds: [certB] })).status).toBe(400); // original of an unselected cert
    // A forged create request that skips the preview is held to the same rules by the server AND the database.
    const create = (await R.shares()).POST;
    const forged = await body(await create(req("/x", { method: "POST", body: { workIds: [jobOld], email: "hr@employer.example", reviewed: true } })));
    expect(forged.status).toBe(400);
    expect(await sql("select count(*)::int as r from public.employer_shares")).toBe(0);
    // Extra fields in the request are ignored, never stored.
    const ok = await p({ workIds: [jobAnon], opportunityId: randomUUID(), includeReport: true, comments: true });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body.packet).sort()).toEqual(["certifications", "format", "generatedAt", "isSynthetic", "technician", "work"]);
  });

  it("journey: preview equals stored packet; only the invited account reads it; unselected items and excluded fields are unreachable", async () => {
    const selection = { workIds: [jobNamed, jobAnon], certificationIds: [certA, certB], originalIds: [certA] };
    const pv = await body(await (await R.preview()).POST(req("/x", { method: "POST", body: selection })));
    expect(pv.status).toBe(200);
    const email = `hiring.${randomUUID().slice(0, 6)}@employer.example`;
    const created = await body(await (await R.shares()).POST(req("/x", { method: "POST", body: { ...selection, email, validDays: 7, reviewed: true } })));
    expect(created.status).toBe(201);
    const stored = (await db.query("select packet from public.employer_shares where id=$1", [created.body.id])).rows[0].packet;
    expect({ ...stored, generatedAt: "x" }).toEqual({ ...pv.body.packet, generatedAt: "x" });
    expect(sent).toHaveLength(1);
    const token = /#t=([A-Za-z0-9_-]+)/.exec(sent[0].text)![1];
    expect(sent[0].text).not.toMatch(/Heat-pump|EPA 608|Brazed/);

    current = await user(`other.${randomUUID().slice(0, 6)}@employer.example`);
    expect((await body(await (await R.accept()).POST(req("/x", { method: "POST", token })))).body.error.reason).toBe("wrong_account");
    expect((await (await R.get()).GET(req("/x"), params(created.body.id))).status).toBe(404);

    current = await user(email);
    expect((await body(await (await R.accept()).POST(req("/x", { method: "POST", token })))).status).toBe(200);
    const got = await body(await (await R.get()).GET(req("/x"), params(created.body.id)));
    expect(got.status).toBe(200);
    const text = JSON.stringify(got.body);
    type W = { id: string; confirmations: { reviewer: unknown }[] };
    const byId = Object.fromEntries((got.body.packet.work as W[]).map((w) => [w.id, w]));
    expect(Object.keys(byId).sort()).toEqual([jobNamed, jobAnon].sort());
    expect(byId[jobNamed].confirmations[0].reviewer).toEqual({ name: "Sky Reviewer (fictional)", organization: "Fictional Mech", title: "Lead" });
    expect(byId[jobAnon].confirmations[0].reviewer).toBeNull();
    for (const absent of [jobNone, jobOld, training, "Unconfirmed job", "Older confirmed", "Training (fictional)", "Private supervisor comment",
      "Pat Example", "Fictional Lane", "CRED-SECRET-123", "Secret equipment list", "Fictional Issuer\",\"confirmations", "work-order.pdf", "opportunity", "requirements", "explanation"]) {
      expect(text).not.toContain(absent);
    }
    // Originals: the authorized certificate only. Never a work document, an unauthorized certificate or an unselected item.
    const doc = async (rec: string) => (await (await R.doc()).GET(req(`/x?record=${rec}`), params(created.body.id))).status;
    expect(await doc(certA)).toBe(200);
    for (const rec of [certB, jobNamed, jobNone, training]) expect(await doc(rec)).toBe(404);
    expect(signed).toEqual(["fictional/epa.pdf"]);
    expect(logged.join("\n")).not.toMatch(/SIGNED-SECRET|fictional\/epa/);
    expect(logged.join("\n")).not.toContain(email);
    expect(logged.join("\n")).not.toContain(token);

    // The technician's own view is the same packet; withdrawal ends access.
    asWorker = { id: W.id, name: "Test Tech (fictional)", trade: "HVAC", is_synthetic: true };
    const mine = await body(await (await R.mine()).GET(req("/x"), params(created.body.id)));
    expect(mine.body.packetHash).toBe(got.body.packetHash);
    expect((await (await R.mine()).DELETE(req("/x", { method: "DELETE" }), params(created.body.id))).status).toBe(200);
    expect((await body(await (await R.get()).GET(req("/x"), params(created.body.id)))).body.error.reason).toBe("revoked");
    expect(await doc(certA)).toBe(404);
  });

  it("the stored packet is re-validated on read: a tampered row with extra fields is refused", async () => {
    const email = `t.${randomUUID().slice(0, 6)}@employer.example`;
    const created = await body(await (await R.shares()).POST(req("/x", { method: "POST", body: { certificationIds: [certB], email, reviewed: true } })));
    const token = /#t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)!.text)![1];
    current = await user(email);
    await (await R.accept()).POST(req("/x", { method: "POST", token }));
    await db.query("alter table public.employer_shares disable trigger employer_shares_frozen");
    await db.query(`update public.employer_shares set packet = packet || '{"report": {"fit": "secret"}}'::jsonb where id = $1`, [created.body.id]);
    await db.query("alter table public.employer_shares enable trigger employer_shares_frozen");
    await expect((await R.get()).GET(req("/x"), params(created.body.id))).rejects.toThrow();
  });

  it("supervisor permission: share and name are separate, recorded only when ticked and only while the flag is on", async () => {
    const respond = (await import("@/app/api/supervisor/reviews/[id]/respond/route")).POST;
    current = { id: supAuth, email: "sup@test.qualitrail.dev", confirmed: true };
    const mk = async () => (await sql("select public.review_create($1,$2,$3,30,false) as r", [W.id, await record("work_record", null, "Job (fictional)"), rel])).id as string;
    const [a, b, c, d] = [await mk(), await mk(), await mk(), await mk()];
    const answer = (extra: object) => ({ decision: "confirm_observed", observedTasks: ["Brazed line set"], agreed: true, ...extra });
    expect((await body(await respond(req("/x", { method: "POST", body: answer({ shareWithEmployers: true, shareName: true }) }), params(a)))).body.shareConsent).toBe(true);
    expect((await body(await respond(req("/x", { method: "POST", body: answer({ shareWithEmployers: true }) }), params(b)))).body.shareConsent).toBe(true);
    expect((await body(await respond(req("/x", { method: "POST", body: answer({ shareName: true }) }), params(c)))).body.shareConsent).toBe(false);
    process.env.EMPLOYER_REVIEW_ENABLED = "false";
    expect((await body(await respond(req("/x", { method: "POST", body: answer({ shareWithEmployers: true, shareName: true }) }), params(d)))).body.shareConsent).toBe(false);
    const rows = (await db.query("select request_id, show_name from public.review_share_consents where request_id = any($1)", [[a, b, c, d]])).rows;
    expect(Object.fromEntries(rows.map((r) => [r.request_id, r.show_name]))).toEqual({ [a]: true, [b]: false });
  });

  it("with the flag off every employer route answers 404 and no share registers an address", async () => {
    const email = `off.${randomUUID().slice(0, 6)}@employer.example`;
    const created = await body(await (await R.shares()).POST(req("/x", { method: "POST", body: { certificationIds: [certA], email, reviewed: true } })));
    const token = /#t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)!.text)![1];
    process.env.EMPLOYER_REVIEW_ENABLED = "false";
    current = await user(email);
    expect((await (await R.peek()).POST(req("/x", { method: "POST", token }))).status).toBe(404);
    expect((await (await R.accept()).POST(req("/x", { method: "POST", token }))).status).toBe(404);
    expect((await (await R.list()).GET()).status).toBe(404);
    expect((await (await R.get()).GET(req("/x"), params(created.body.id))).status).toBe(404);
    expect((await (await R.doc()).GET(req(`/x?record=${certA}`), params(created.body.id))).status).toBe(404);
    expect((await (await R.candidates()).GET()).status).toBe(404);
    expect((await (await R.preview()).POST(req("/x", { method: "POST", body: { certificationIds: [certA] } }))).status).toBe(404);
    expect((await (await R.shares()).POST(req("/x", { method: "POST", body: { certificationIds: [certA], email, reviewed: true } }))).status).toBe(404);
    const { hasPendingEmployerShare } = await import("@/lib/server/employer/service");
    expect(await hasPendingEmployerShare(email)).toBe(false);
  });

  it("with the flag off the answer is 404 for every caller, checked before sign-in or role (never 401)", async () => {
    process.env.EMPLOYER_REVIEW_ENABLED = "false";
    const id = randomUUID();
    const savedWorker = asWorker;
    try {
      for (const [who, acct, worker] of [["signed out", null, null], ["account without a technician profile", await user(`norole.${randomUUID().slice(0, 6)}@employer.example`), null]] as const) {
        current = acct;
        asWorker = worker;
        const statuses = {
          list: (await (await R.shares()).GET()).status,
          create: (await (await R.shares()).POST(req("/x", { method: "POST", body: {} }))).status,
          candidates: (await (await R.candidates()).GET()).status,
          preview: (await (await R.preview()).POST(req("/x", { method: "POST", body: {} }))).status,
          mine: (await (await R.mine()).GET(req("/x"), params(id))).status,
          withdraw: (await (await R.mine()).DELETE(req("/x", { method: "DELETE" }), params(id))).status,
          reviewerList: (await (await R.list()).GET()).status,
          reviewerGet: (await (await R.get()).GET(req("/x"), params(id))).status,
          accept: (await (await R.accept()).POST(req("/x", { method: "POST", token: "x" }))).status,
        };
        expect({ who, statuses }).toEqual({ who, statuses: Object.fromEntries(Object.keys(statuses).map((k) => [k, 404])) });
      }
    } finally {
      asWorker = savedWorker;
    }
  });

  it("customer: the acknowledgment wording is unchanged; sharing is a separate, unticked permission recorded only when given", async () => {
    process.env.SIGNOFF_ENABLED = "true";
    const { hmac } = await import("@/lib/server/signoff/crypto");
    const { STATEMENT_TEXT } = await import("@/lib/server/signoff/statement");
    const { CUSTOMER_SHARE_CONSENT_TEXT } = await import("@/lib/server/employer/flags");
    const snapshotRoute = (await import("@/app/api/signoff/snapshot/route")).POST;
    const respondRoute = (await import("@/app/api/signoff/respond/route")).POST;
    async function pending(title: string) {
      const rec = await record("work_record", null, title);
      const [id, sid, token, cookie] = [randomUUID(), randomUUID(), randomUUID().replace(/-/g, "") + "aaaa", randomUUID().replace(/-/g, "") + "bbbb"];
      const v = (await db.query("select version from public.evidence where id=$1", [rec])).rows[0].version;
      await db.query(`insert into public.signoff_requests (id, worker_id, evidence_id, evidence_version, snapshot, snapshot_hash, file_hash, customer_email, customer_name,
          token_hash, status, delivery_mode, expires_at, verified_session_id, email_verified_at)
        values ($1,$2,$3,$4,$5,$8,'x','casey@example.test','Casey Customer',$6,'pending','mock',now() + interval '7 days',$7,now())`,
        [id, W.id, rec, v, JSON.stringify({ title, workerName: "Test Tech (fictional)", activities: ["Brazed line set"], skills: [], equipment: [] }), hmac("token", token), sid, sha(id)]);
      await db.query("insert into public.signoff_sessions (id, request_id, session_hash, expires_at) values ($1,$2,$3,now() + interval '30 minutes')", [sid, id, hmac("session", cookie)]);
      return { id, rec, token, cookie };
    }
    const confirm = async (x: { token: string; cookie: string }, extra: object) => {
      signoffCookie = x.cookie;
      return body(await respondRoute(req("/x", { method: "POST", token: x.token, body: { decision: "confirm", typedName: "Casey Typed", agreed: true, ...extra } })));
    };
    try {
      const a = await pending("Customer job A (fictional)");
      signoffCookie = a.cookie;
      const snap = await body(await snapshotRoute(req("/x", { method: "POST", token: a.token })));
      expect(snap.body.statement).toBe(STATEMENT_TEXT);
      expect(snap.body.statement).not.toMatch(/employer/i);
      expect(snap.body.shareConsent).toBe(CUSTOMER_SHARE_CONSENT_TEXT);
      expect(CUSTOMER_SHARE_CONSENT_TEXT).toMatch(/^I give the technician permission to share this acknowledgment with prospective employers/);
      expect(CUSTOMER_SHARE_CONSENT_TEXT).toMatch(/never my name, signature, comments or contact details/);
      expect((await confirm(a, { shareWithEmployers: true })).body).toMatchObject({ recorded: true, shareConsent: true });

      const b = await pending("Customer job B (fictional)");
      expect((await confirm(b, {})).body).toMatchObject({ recorded: true, shareConsent: false });
      const c = await pending("Customer job C (fictional)");
      expect((await confirm(c, { shareWithEmployers: false })).body).toMatchObject({ recorded: true, shareConsent: false });

      process.env.EMPLOYER_REVIEW_ENABLED = "false";
      const d = await pending("Customer job D (fictional)");
      signoffCookie = d.cookie;
      expect((await body(await snapshotRoute(req("/x", { method: "POST", token: d.token })))).body.shareConsent).toBeUndefined();
      expect((await confirm(d, { shareWithEmployers: true })).body).toMatchObject({ recorded: true, shareConsent: false });
      process.env.EMPLOYER_REVIEW_ENABLED = "true";

      const rows = (await db.query("select request_id from public.signoff_share_consents where request_id = any($1)", [[a.id, b.id, c.id, d.id]])).rows.map((r) => r.request_id);
      expect(rows).toEqual([a.id]);
      const versions = (await db.query("select distinct statement_version v from public.signoff_responses where request_id = any($1)", [[a.id, b.id, c.id, d.id]])).rows.map((r) => r.v);
      expect(versions).toEqual(["customer-ack-v1"]);
      const cands = await body(await (await R.candidates()).GET());
      const work = Object.fromEntries(cands.body.work.map((w: { id: string; eligible: boolean; withheldCount: number }) => [w.id, [w.eligible, w.withheldCount]]));
      expect(work[a.rec]).toEqual([true, 0]);
      expect(work[b.rec]).toEqual([false, 1]);
      expect(JSON.stringify(cands.body)).not.toMatch(/Casey/);
    } finally {
      signoffCookie = undefined;
    }
  });

  it("an invited address may register but gets no technician or supervisor role", async () => {
    const email = `reg.${randomUUID().slice(0, 6)}@employer.example`;
    await (await R.shares()).POST(req("/x", { method: "POST", body: { certificationIds: [certA], email, reviewed: true } }));
    const { hasPendingEmployerShare } = await import("@/lib/server/employer/service");
    const { mayCreateRole, mayRegister } = await import("@/lib/server/accounts/policy");
    expect(await hasPendingEmployerShare(email)).toBe(true);
    expect(mayRegister(email, true, {} as NodeJS.ProcessEnv)).toBe(true);
    const state = { email, hasWorker: false, hasSupervisor: false, hasInvite: false, supervisorReviewOn: true };
    expect(mayCreateRole("worker", state, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(mayCreateRole("supervisor", state, {} as NodeJS.ProcessEnv)).toBe(false);
    const { roleState } = await import("@/lib/server/accounts/roles");
    const u = await user(email);
    expect((await roleState({ supabase: null as never, user: { id: u.id, email, emailConfirmed: true }, worker: null, supervisor: null })).hasInvite).toBe(false);
  });
});
