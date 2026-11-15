/**
 * Corrections, completed-job logging and the packet-safe summary, against the ISOLATED LOCAL Supabase stack
 * with a real signed-in (fictional) user, so row-level security applies exactly as in the app.
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_PUBLISHABLE, LOCAL_URL, hasLocalStack, useLocalStack } from "../helpers/local-supabase";

vi.mock("server-only", () => ({}));
const ctx: { current: unknown } = { current: null };
vi.mock("@/lib/api/auth", () => ({ getAuthedContext: async () => ctx.current }));
const indexed: string[] = [];
vi.mock("@/lib/server/memory/indexing", () => ({ indexEvidence: async (_a: unknown, e: { id: string }) => { indexed.push(e.id); } }));

let admin: SupabaseClient;
let me: { supabase: SupabaseClient; authUserId: string; worker: { id: string; name: string; trade: string; is_synthetic: boolean } };

async function signedInWorker(name: string) {
  const email = `${name.toLowerCase()}.${randomUUID().slice(0, 8)}@test.qualitrail.dev`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const r = await admin.rpc("account_onboard_worker", { p_auth: data.user.id, p_name: `${name} (fictional)`, p_trade: "HVAC", p_summary: null, p_arrangement: null });
  const user = createClient(LOCAL_URL!, LOCAL_PUBLISHABLE!, { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await user.auth.signInWithPassword({ email, password });
  if (s.error) throw s.error;
  return { supabase: user, authUserId: data.user.id, worker: { id: r.data.workerId as string, name: `${name} (fictional)`, trade: "HVAC", is_synthetic: false } };
}
async function record(workerId: string, type = "work_record", extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const { error } = await admin.from("evidence").insert({
    id, worker_id: workerId, type, title: `Job ${id.slice(0, 6)}`, source_kind: "manual_text", file_hash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    verification_status: "self_reported", structured_data: { activities: ["Brazed line set"], equipment: [], skills: [] }, ...extra,
  });
  if (error) throw error;
  return id;
}
const patch = async (id: string, fields: object) => {
  const { PATCH } = await import("@/app/api/evidence/[id]/route");
  const res = await PATCH(new Request(`http://localhost/api/evidence/${id}`, { method: "PATCH", body: JSON.stringify({ fields }) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
};
const fields = (type = "work_record", title = "Corrected title") => ({
  type, title, date: "2026-11-01", issuer: "Fictional Mechanical",
  structuredData: { skills: [], activities: ["Brazed line set", "Pulled vacuum"], equipment: ["Heat pump"], expirationDate: null, credentialNumber: null, summary: null },
});

describe.skipIf(!hasLocalStack)("corrections, job logging and packet summary (local Supabase stack)", () => {
  beforeAll(async () => {
    admin = useLocalStack();
    Object.assign(process.env, { SIGNOFF_PEPPER: "p".repeat(40) });
    me = await signedInWorker("Corina");
  });
  beforeEach(() => {
    ctx.current = me;
    indexed.length = 0;
  });

  it("an edit bumps the version, re-indexes, makes saved reports stale and supersedes open requests, without touching verification", async () => {
    const id = await record(me.worker.id);
    // A completed saved report that used this worker's evidence.
    const opp = randomUUID();
    await admin.from("opportunities").insert({ id: opp, worker_id: me.worker.id, title: "Job", employer: "Fictional", is_synthetic: true });
    const reqId = randomUUID();
    await admin.from("requirements").insert({ id: reqId, opportunity_id: opp, position: 0, original_text: "x", criteria_json: {}, source: "test" });
    const started = await admin.rpc("start_match_run", { p_worker_id: me.worker.id, p_opportunity_id: opp });
    const runId = started.data[0].id;
    const fin = await admin.rpc("finalize_match_run", {
      p_worker_id: me.worker.id, p_run_id: runId,
      p_results: [{ requirement_id: reqId, assessment: "needs_review", explanation: "x", uncertainties: [], missing_documentation: [] }],
      p_matches: [], p_memory_warning: null,
    });
    expect(fin.error).toBeNull();
    // An open customer request for the current version.
    const so = await admin.rpc("signoff_create_request", { p_worker: me.worker.id, p_evidence: id, p_email: "cust@example.test", p_name: null, p_email_hash: "h1", p_hint: "c***", p_token_hash: randomUUID(), p_delivery_mode: "mock", p_worker_email_hash: null, p_valid_days: 7 });
    expect(so.data.ok).toBe(true);

    const r = await patch(id, fields());
    expect(r.status).toBe(200);
    expect(r.body.evidence).toMatchObject({ version: 2, title: "Corrected title", verificationStatus: "self_reported" });
    expect(indexed).toEqual([id]);
    expect((await admin.from("match_runs").select("status").eq("id", runId).single()).data?.status).toBe("stale");
    expect((await admin.from("signoff_requests").select("status, evidence_version").eq("id", so.data.id).single()).data).toEqual({ status: "superseded", evidence_version: 1 });
  });

  it("refuses certifications, type changes, independently confirmed records and other workers' records", async () => {
    const cert = await record(me.worker.id, "certification");
    expect((await patch(cert, fields("work_record"))).status).toBe(403);
    const wr = await record(me.worker.id);
    expect((await patch(wr, fields("checklist"))).status).toBe(403);

    const confirmed = await record(me.worker.id);
    await admin.from("verification_events").insert({ evidence_id: confirmed, reviewer_id: me.authUserId, decision: "confirmed" });
    await admin.from("evidence").update({ verification_status: "independently_confirmed" }).eq("id", confirmed);
    const before = (await admin.from("evidence").select("version, title").eq("id", confirmed).single()).data;
    expect((await patch(confirmed, fields())).status).toBe(403);
    expect((await admin.from("evidence").select("version, title, verification_status").eq("id", confirmed).single()).data).toEqual({ ...before, verification_status: "independently_confirmed" });

    const other = await signedInWorker("Otto");
    const theirs = await record(other.worker.id);
    expect((await patch(theirs, fields())).status).toBe(404); // RLS + explicit worker filter
    expect((await admin.from("evidence").select("title").eq("id", theirs).single()).data?.title).not.toBe("Corrected title");
  });

  it("logs a completed job as an ordinary self-reported record and rejects an exact duplicate", async () => {
    const { POST } = await import("@/app/api/jobs/route");
    const job = { type: "work_record", title: "Ductless install, 2 heads", date: "2026-11-10", issuer: null, activities: ["Mounted indoor heads", "Pressure tested"], equipment: ["Mini-split"], skills: [], summary: null };
    const res = await POST(new Request("http://localhost/api/jobs", { method: "POST", body: JSON.stringify(job) }));
    expect(res.status).toBe(201);
    const { evidence } = await res.json();
    expect(evidence).toMatchObject({ type: "work_record", sourceKind: "manual_text", verificationStatus: "self_reported", workerId: me.worker.id, sourceAvailable: false });
    expect(indexed).toEqual([evidence.id]);
    const dup = await POST(new Request("http://localhost/api/jobs", { method: "POST", body: JSON.stringify(job) }));
    expect(dup.status).toBe(409);
    const bad = await POST(new Request("http://localhost/api/jobs", { method: "POST", body: JSON.stringify({ ...job, activities: [], title: "x2" }) }));
    expect(bad.status).toBe(400);
  });

  it("the packet summary never contains a customer address, masked hint or typed signature", async () => {
    const id = await record(me.worker.id);
    const email = `private.person.${randomUUID().slice(0, 6)}@example.test`;
    await admin.rpc("signoff_create_request", { p_worker: me.worker.id, p_evidence: id, p_email: email, p_name: "Private Person", p_email_hash: `h-${randomUUID()}`, p_hint: "p***@example.test", p_token_hash: randomUUID(), p_delivery_mode: "resend", p_worker_email_hash: null, p_valid_days: 7 });
    const { GET } = await import("@/app/api/attestations/route");
    const body = await (await GET()).json();
    expect(body.items[id].customer[0]).toMatchObject({ status: "pending", deliveryMode: "resend" });
    const text = JSON.stringify(body);
    expect(text).not.toContain(email);
    expect(text).not.toContain("p***");
    expect(text).not.toContain("Private Person");
  });
});
