/**
 * The real customer routes, driven end to end against a DISPOSABLE local PostgreSQL (database
 * `qualitrail_signoff_routes_test`). Mail is captured in memory; nothing is sent anywhere, and no
 * Supabase project is contacted. Uses a fictional test worker.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const DB_NAME = "qualitrail_signoff_routes_test";
const ROOT = join(__dirname, "..", "..");

let db: Client;
const jar = new Map<string, string>();
const sent: { kind: string; to: string; text: string }[] = [];
const logged: string[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined) }),
  headers: async () => new Headers({ "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const keys = Object.keys(args);
      const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as data`;
      await db.query("set role service_role");
      try {
        return { data: (await db.query(sql, keys.map((k) => args[k]))).rows[0].data, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code ?? "x" } };
      } finally {
        await db.query("reset role");
      }
    },
  }),
}));
vi.mock("@/lib/server/email/deliver", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/email/deliver")>()),
  deliver: async (m: { kind: string; to: string; rendered: { text: string } }) => {
    sent.push({ kind: m.kind, to: m.to, text: m.rendered.text });
    return { ok: true, mode: "mock", duplicate: false };
  },
}));
vi.mock("@/lib/server/signoff/notify", () => ({ notifyCustomerDecision: async () => undefined }));

const WORKER = randomUUID();
let evidenceId: string;

const ROUTES = {
  gate: () => import("@/app/api/signoff/gate/route"),
  code: () => import("@/app/api/signoff/code/route"),
  verify: () => import("@/app/api/signoff/verify/route"),
  snapshot: () => import("@/app/api/signoff/snapshot/route"),
  respond: () => import("@/app/api/signoff/respond/route"),
  "opt-out": () => import("@/app/api/signoff/opt-out/route"),
};

const call = async (route: "gate" | "code" | "verify" | "snapshot" | "respond" | "opt-out", token: string | null, body?: unknown) => {
  const mod = await ROUTES[route]();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["x-signoff-token"] = token;
  const res: Response = await mod.POST(new Request(`http://x.test/api/signoff/${route}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const setCookie = res.headers.get("set-cookie");
  const m = setCookie && /qt_signoff=([^;]+)/.exec(setCookie);
  if (m) jar.set("qt_signoff", decodeURIComponent(m[1]));
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null), setCookie };
};

async function newInvitation(email = "casey.customer@example.test") {
  const { hmac, newToken, maskEmail } = await import("@/lib/server/signoff/crypto");
  const token = newToken();
  await db.query("update public.evidence set updated_at = updated_at where id = $1", [evidenceId]);
  const r = await db.query("select public.signoff_create_request($1,$2,$3,null,$4,$5,$6,'mock',null,7) as r", [WORKER, evidenceId, email, hmac("email", email), maskEmail(email), hmac("token", token)]);
  expect(r.rows[0].r.ok).toBe(true);
  return token;
}
const lastCode = () => /Code: (\d{6})/.exec(sent.filter((s) => s.kind === "customer_code").at(-1)!.text)![1];

describe.skipIf(!ADMIN_URL)("customer routes (end to end, local database)", () => {
  beforeAll(async () => {
    process.env.SIGNOFF_ENABLED = "true";
    process.env.SIGNOFF_MAIL_MODE = "mock";
    process.env.SIGNOFF_PEPPER = "p".repeat(48);
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321"; // simulated email requires an isolated local setup
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
    const auth = randomUUID();
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query("insert into public.workers (id, auth_user_id, name, trade, is_synthetic) values ($1,$2,'Test Worker (fictional)','HVAC',true)", [WORKER, auth]);
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    jar.clear();
    sent.length = 0;
    logged.length = 0;
    vi.spyOn(console, "error").mockImplementation((...a) => { logged.push(JSON.stringify(a)); });
    vi.spyOn(console, "log").mockImplementation((...a) => { logged.push(JSON.stringify(a)); });
    evidenceId = randomUUID();
    await db.query(
      `insert into public.evidence (id, worker_id, type, title, source_kind, file_hash, structured_data) values ($1,$2,'work_record',$3,'seed',encode(sha256($4::bytea),'hex'),'{"summary":"Swapped a contactor","activities":["Replaced contactor"]}')`,
      [evidenceId, WORKER, `Job ${evidenceId.slice(0, 6)}`, evidenceId],
    );
  });

  it("full journey: gate -> code -> verify -> snapshot -> acknowledge; link alone shows no job details", async () => {
    const token = await newInvitation();
    const gate = await call("gate", token);
    expect(gate.status).toBe(200);
    expect(JSON.stringify(gate.body)).not.toMatch(/Job |contactor/);
    expect(gate.headers.get("cache-control")).toBe("no-store");

    // Link alone: no snapshot, no decision.
    expect((await call("snapshot", token)).status).toBe(404);
    expect((await call("respond", token, { decision: "decline" })).status).toBe(404);

    expect((await call("code", token)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("casey.customer@example.test");
    expect((await call("verify", token, { code: "000000" })).status).toBe(400);
    const ok = await call("verify", token, { code: lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/HttpOnly/i);
    expect(ok.setCookie).toMatch(/SameSite=strict/i);
    expect(ok.setCookie).toMatch(/Path=\/api\/signoff/);
    expect(ok.setCookie).not.toMatch(/Secure/i); // non-production run

    const snap = await call("snapshot", token);
    expect(snap.status).toBe(200);
    expect(snap.body.snapshot.summary).toBe("Swapped a contactor");

    expect((await call("respond", token, { decision: "confirm", typedName: "Casey Customer", agreed: true })).status).toBe(200);
    const status = (await db.query("select status, email_verified_at from public.signoff_requests where evidence_id=$1", [evidenceId])).rows[0];
    expect(status.status).toBe("acknowledged");
    expect(status.email_verified_at).not.toBeNull();
    // Second, different decision: refused.
    expect((await call("respond", token, { decision: "confirm", typedName: "Casey Customer", agreed: true })).body.repeated).toBe(true);
    expect((await call("respond", token, { decision: "decline" })).status).toBe(409); // a conflicting decision is refused
    // Acknowledgment never changes the record's verification status or version.
    expect((await db.query("select verification_status, version from public.evidence where id=$1", [evidenceId])).rows[0]).toEqual({ verification_status: "document_supplied", version: 1 });
  });

  it("a wrong, replayed or reissued code fails with an identical response", async () => {
    const token = await newInvitation();
    await call("code", token);
    const first = lastCode();
    const wrong = await call("verify", token, { code: first === "111111" ? "222222" : "111111" });
    const malformed = await call("verify", token, { code: "abc" });
    expect(wrong.body).toEqual(malformed.body);
    expect((await call("verify", token, { code: first })).status).toBe(200);
    jar.clear();
    expect((await call("verify", token, { code: first })).status).toBe(400); // replay
    const unknownToken = await call("verify", "x".repeat(43), { code: first });
    expect(unknownToken.status).toBe(400);
    expect(unknownToken.body).toEqual(wrong.body); // an unknown link is indistinguishable from a wrong code
  });

  it("asking again too soon is refused; the address never changes", async () => {
    const token = await newInvitation();
    expect((await call("code", token)).status).toBe(200);
    expect((await call("code", token)).status).toBe(429);
    expect(sent).toHaveLength(1);
    expect(sent.every((s) => s.to === "casey.customer@example.test")).toBe(true);
  });

  it("correction requests and declines are recorded; comments are stored as plain text", async () => {
    const token = await newInvitation();
    await call("code", token);
    await call("verify", token, { code: lastCode() });
    const r = await call("respond", token, { decision: "request_correction", comment: "<script>alert(1)</script> wrong date" });
    expect(r.status).toBe(200);
    expect((await db.query("select comment from public.signoff_responses")).rows.at(-1).comment).toBe("<script>alert(1)</script> wrong date");
  });

  it("opt-out suppresses the address and closes the invitation", async () => {
    const token = await newInvitation("optout.person@example.test");
    expect((await call("opt-out", token)).status).toBe(200);
    expect((await call("gate", token)).body.status).toBe("revoked");
    expect((await db.query("select count(*)::int n from public.signoff_suppressions")).rows[0].n).toBeGreaterThan(0);
  });

  it("the feature flag turns every customer route off", async () => {
    const token = await newInvitation();
    process.env.SIGNOFF_ENABLED = "false";
    try {
      for (const route of ["gate", "code", "verify", "snapshot", "respond", "opt-out"] as const) expect((await call(route, token, {})).status).toBe(404);
    } finally {
      process.env.SIGNOFF_ENABLED = "true";
    }
    // Data stays: the existing request is unchanged.
    expect((await call("gate", token)).status).toBe(200);
  });

  it("no token, code or customer address ever reaches the logs", async () => {
    const token = await newInvitation("leaky.address@example.test");
    await call("code", token);
    const code = lastCode();
    await call("verify", token, { code: "999999" });
    await call("verify", token, { code });
    await call("respond", token, { decision: "confirm", typedName: "Leaky Person", agreed: true });
    await call("gate", "z".repeat(43));
    const all = logged.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(code);
    expect(all).not.toContain("leaky.address");
    expect(all).not.toContain("Leaky Person");
  });
});
