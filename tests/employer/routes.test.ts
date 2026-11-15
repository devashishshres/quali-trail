/**
 * Employer reviewer routes and the feature flag, driven against a DISPOSABLE local PostgreSQL
 * (`qualitrail_employer_routes_test`). Sign-in is simulated; no Supabase project, email or storage is contacted.
 * Fictional identities only.
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
type Acct = { id: string; email: string; confirmed: boolean } | null;
let current: Acct = null;

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/api/auth", () => ({
  getAccount: async () => current && { supabase: null, user: { id: current.id, email: current.email, emailConfirmed: current.confirmed }, worker: null, supervisor: null },
  getAuthedContext: async () => null,
  getSupervisorContext: async () => current && { supabase: null, user: { id: current.id, email: current.email, emailConfirmed: true }, worker: null, supervisor: { auth_user_id: current.id, name: "Sky (fictional)", organization: null, title: null } },
}));
vi.mock("@/lib/server/accounts/notify", () => ({ notifyReviewDecided: async () => undefined }));
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
let worker: { id: string; auth: string };
let run: string;
async function record(storage: string | null) {
  const id = randomUUID();
  await db.query(`insert into public.evidence (id, worker_id, type, title, source_kind, storage_path, file_hash, verification_status, structured_data)
    values ($1,$2,'work_record','Fictional job',$3,$4,$5,'self_reported','{"activities":["Brazed line set"]}')`, [id, worker.id, storage ? "pdf_upload" : "manual_text", storage, sha(id)]);
  return id;
}
async function share(email: string, recs: { id: string; original: boolean }[]) {
  const { hmac, newToken, maskEmail } = await import("@/lib/server/signoff/crypto");
  const token = newToken();
  const versions = await Promise.all(recs.map(async (r) => ({ id: r.id, version: (await db.query("select version from public.evidence where id=$1", [r.id])).rows[0].version })));
  const packet = { format: "employer-packet-v1", generatedAt: new Date().toISOString(), isSynthetic: true,
    technician: { name: "Test Tech (fictional)", trade: "HVAC" },
    opportunity: { title: "Fictional Installer", employer: "Fictional Co", location: null, sourceUrl: null, sourceKind: "other" },
    report: { reference: "abcd1234", createdAt: new Date().toISOString(), status: "completed" },
    counts: { evidence_found: 1, needs_review: 0, no_sufficient_evidence: 0, cannot_assess: 0 },
    requirements: [], includesConfirmations: false,
    records: versions.map((v, i) => ({ id: v.id, ref: `R${i + 1}`, version: v.version, type: "work_record", title: "Fictional job", date: null, issuer: null, expirationDate: null,
      verificationStatus: "self_reported", activities: [], equipment: [], skills: [], originalShared: recs[i].original, confirmations: [] })) };
  // Adding a record marks earlier runs stale (as in the app); this fixture's report is treated as re-run.
  await db.query("update public.match_runs set status = 'completed' where id = $1", [run]);
  await db.query("set role service_role");
  const r = (await db.query("select public.employer_share_create($1,$2,'employer-packet-v1',$3,$4,$5,$6,$7,$8,7) as r",
    [worker.id, run, JSON.stringify(packet), JSON.stringify(recs), email, hmac("email", email), maskEmail(email), hmac("token", token)])).rows[0].r;
  await db.query("reset role");
  expect(r).toMatchObject({ ok: true });
  return { id: r.id as string, token };
}

const R = {
  peek: () => import("@/app/api/employer/invite/peek/route"),
  accept: () => import("@/app/api/employer/invite/accept/route"),
  list: () => import("@/app/api/employer/shares/route"),
  get: () => import("@/app/api/employer/shares/[id]/route"),
  doc: () => import("@/app/api/employer/shares/[id]/document/route"),
};

describe.skipIf(!ADMIN_URL)("employer reviewer routes (local database)", () => {
  beforeAll(async () => {
    process.env.SIGNOFF_PEPPER = "e".repeat(48);
    process.env.SUPERVISOR_REVIEW_ENABLED = "true";
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
    const w = await user(`tech.${randomUUID().slice(0, 6)}@test.qualitrail.dev`);
    const id = randomUUID();
    await db.query("insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,'Test Tech (fictional)','HVAC',true)", [id, w.id]);
    worker = { id, auth: w.id };
    const opp = (await db.query("insert into public.opportunities (worker_id, title, employer) values ($1,'Fictional Installer','Fictional Co') returning id", [id])).rows[0].id;
    run = (await db.query("insert into public.match_runs (worker_id, opportunity_id, evidence_revision, status) values ($1,$2,0,'completed') returning id", [id, opp])).rows[0].id;
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(() => {
    process.env.EMPLOYER_REVIEW_ENABLED = "true";
    current = null;
    logged.length = 0;
    signed.length = 0;
    vi.spyOn(console, "error").mockImplementation((...a) => { logged.push(JSON.stringify(a)); });
    vi.spyOn(console, "log").mockImplementation((...a) => { logged.push(JSON.stringify(a)); });
  });

  it("journey: peek shows only name + masked address; a different account is refused; the invited account opens and reads it", async () => {
    const email = `hiring.${randomUUID().slice(0, 6)}@employer.test`;
    const doc = await record("fictional/original.pdf");
    const hidden = await record("fictional/not-shared.pdf");
    const s = await share(email, [{ id: doc, original: true }, { id: hidden, original: false }]);

    const peek = await body(await (await R.peek()).POST(req("/api/employer/invite/peek", { method: "POST", token: s.token })));
    expect(peek.status).toBe(200);
    expect(peek.body).toMatchObject({ status: "pending", workerName: "Test Tech (fictional)" });
    expect(JSON.stringify(peek.body)).not.toMatch(/Fictional job|Fictional Installer/);
    expect(JSON.stringify(peek.body)).not.toContain(email); // masked hint only

    // Signed out, and a forwarded link opened by someone else: nothing.
    expect((await (await R.accept()).POST(req("/api/employer/invite/accept", { method: "POST", token: s.token }))).status).toBe(401);
    current = await user(`someone.else.${randomUUID().slice(0, 6)}@employer.test`);
    const wrong = await body(await (await R.accept()).POST(req("/api/employer/invite/accept", { method: "POST", token: s.token })));
    expect(wrong).toMatchObject({ status: 409, body: { error: { reason: "wrong_account" } } });
    expect((await (await R.get()).GET(req(`/api/employer/shares/${s.id}`), params(s.id))).status).toBe(404);

    current = await user(email);
    const ok = await body(await (await R.accept()).POST(req("/api/employer/invite/accept", { method: "POST", token: s.token })));
    expect(ok).toMatchObject({ status: 200, body: { id: s.id } });
    const got = await body(await (await R.get()).GET(req(`/api/employer/shares/${s.id}`), params(s.id)));
    expect(got.status).toBe(200);
    expect(got.body.packet.technician.name).toBe("Test Tech (fictional)");
    expect(got.body.packetHash).toMatch(/^[0-9a-f]{64}$/);
    const list = await body(await (await R.list()).GET());
    expect(list.body.shares).toEqual([expect.objectContaining({ id: s.id, status: "active", jobTitle: "Fictional Installer" })]);

    // Originals: only the shared one; the signed URL is returned to the caller and never logged.
    const d1 = await body(await (await R.doc()).GET(req(`/api/employer/shares/${s.id}/document?record=${doc}`), params(s.id)));
    expect(d1.status).toBe(200);
    expect(d1.body.url).toContain("SIGNED-SECRET");
    const d2 = await (await R.doc()).GET(req(`/api/employer/shares/${s.id}/document?record=${hidden}`), params(s.id));
    expect(d2.status).toBe(404);
    expect(signed).toEqual(["fictional/original.pdf"]);
    expect(logged.join("\n")).not.toMatch(/SIGNED-SECRET|fictional\/original/);
    expect(logged.join("\n")).not.toContain(email);
    expect(logged.join("\n")).not.toContain(s.token);

    // Withdrawn: the reviewer immediately loses the packet and the original.
    await db.query("set role service_role");
    await db.query("select public.employer_share_revoke($1,$2)", [worker.id, s.id]);
    await db.query("reset role");
    expect(await body(await (await R.get()).GET(req(`/api/employer/shares/${s.id}`), params(s.id)))).toMatchObject({ status: 410, body: { error: { reason: "revoked" } } });
    expect((await (await R.doc()).GET(req(`/api/employer/shares/${s.id}/document?record=${doc}`), params(s.id))).status).toBe(404);
    const events = (await db.query("select event from public.employer_share_events where share_id=$1 order by id", [s.id])).rows.map((r) => r.event);
    expect(events).toEqual(["invited", "accepted", "viewed", "original_opened", "revoked"]);
  });

  it("an unconfirmed account can't open a share, and opening one grants no other role", async () => {
    const email = `unconf.${randomUUID().slice(0, 6)}@employer.test`;
    const s = await share(email, [{ id: await record(null), original: false }]);
    current = await user(email, false);
    expect(await body(await (await R.accept()).POST(req("/api/employer/invite/accept", { method: "POST", token: s.token })))).toMatchObject({ status: 409, body: { error: { reason: "email_unconfirmed" } } });
    expect((await (await R.list()).GET()).status).toBe(401);

    const { hasPendingEmployerShare } = await import("@/lib/server/employer/service");
    const { mayCreateRole, mayRegister } = await import("@/lib/server/accounts/policy");
    expect(await hasPendingEmployerShare(email)).toBe(true);
    // It may register an account, but under the default closed policy it may not create a technician or supervisor profile.
    expect(mayRegister(email, true, {} as NodeJS.ProcessEnv)).toBe(true);
    const state = { email, hasWorker: false, hasSupervisor: false, hasInvite: false, supervisorReviewOn: true };
    expect(mayCreateRole("worker", state, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(mayCreateRole("supervisor", state, {} as NodeJS.ProcessEnv)).toBe(false);
    const { roleState } = await import("@/lib/server/accounts/roles");
    expect((await roleState({ supabase: null as never, user: { id: current!.id, email, emailConfirmed: true }, worker: null, supervisor: null })).hasInvite).toBe(false);
  });

  it("with the flag off every employer route answers 404 and no share registers an address", async () => {
    const email = `off.${randomUUID().slice(0, 6)}@employer.test`;
    const s = await share(email, [{ id: await record(null), original: false }]);
    process.env.EMPLOYER_REVIEW_ENABLED = "false";
    current = await user(email);
    expect((await (await R.peek()).POST(req("/x", { method: "POST", token: s.token }))).status).toBe(404);
    expect((await (await R.accept()).POST(req("/x", { method: "POST", token: s.token }))).status).toBe(404);
    expect((await (await R.list()).GET()).status).toBe(404);
    expect((await (await R.get()).GET(req("/x"), params(s.id))).status).toBe(404);
    expect((await (await R.doc()).GET(req(`/x?record=${randomUUID()}`), params(s.id))).status).toBe(404);
    const worker = await Promise.all([import("@/app/api/employer-shares/route"), import("@/app/api/employer-shares/preview/route"), import("@/app/api/employer-shares/[id]/route")]);
    // Worker routes need a technician session first (none here), so they answer 401 before anything else.
    expect((await worker[1].POST(req("/x", { method: "POST", body: {} }))).status).toBe(401);
    const { hasPendingEmployerShare } = await import("@/lib/server/employer/service");
    expect(await hasPendingEmployerShare(email)).toBe(false);
    const { customerStatement } = await import("@/lib/server/signoff/statement");
    expect(customerStatement(false).version).toBe("customer-ack-v1");
  });

  it("supervisor consent is recorded only when ticked, only while the flag is on", async () => {
    const semail = `sup.${randomUUID().slice(0, 6)}@test.qualitrail.dev`;
    current = await user(semail);
    await db.query("set role service_role");
    await db.query("select public.account_onboard_supervisor($1,'Sky (fictional)',null,null)", [current.id]);
    await db.query("select public.sup_invite_create($1,$2,$3,'x***',$4,14)", [worker.id, semail, sha("e" + semail), sha("t" + semail)]);
    const rel = (await db.query("select public.sup_invite_answer($1,$2,true) as r", [sha("t" + semail), current.id])).rows[0].r.relationshipId;
    const mk = async () => (await db.query("select public.review_create($1,$2,$3,30,false) as r", [worker.id, await record(null), rel])).rows[0].r.id as string;
    const [a, b, c] = [await mk(), await mk(), await mk()];
    await db.query("reset role");
    const respond = (await import("@/app/api/supervisor/reviews/[id]/respond/route")).POST;
    const answer = (share?: boolean) => ({ decision: "confirm_observed", observedTasks: ["Brazed line set"], agreed: true, ...(share === undefined ? {} : { shareWithEmployers: share }) });
    expect((await body(await respond(req("/x", { method: "POST", body: answer(true) }), params(a)))).body).toMatchObject({ recorded: true, shareConsent: true });
    expect((await body(await respond(req("/x", { method: "POST", body: answer() }), params(b)))).body).toMatchObject({ recorded: true, shareConsent: false });
    process.env.EMPLOYER_REVIEW_ENABLED = "false";
    expect((await body(await respond(req("/x", { method: "POST", body: answer(true) }), params(c)))).body).toMatchObject({ recorded: true, shareConsent: false });
    const rows = (await db.query("select request_id from public.review_share_consents")).rows.map((r) => r.request_id);
    expect(rows).toEqual([a]);
  });
});
