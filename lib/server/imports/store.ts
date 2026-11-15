import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ImportDraft } from "@/lib/types/imports";
import { isolatedLocal } from "../config";
import { dailyLimit, tinyfishMode } from "./config";
import type { ImportPorts, ImportRow } from "./service";
import { proposeWithGemini, proposeWithStub } from "./structure";
import { fetchListingLive, fetchListingStub } from "./tinyfish";
import { systemResolver, type Resolver } from "./url";

export const IMPORT_COLUMNS =
  "id, worker_id, source_kind, submitted_url, status, final_url, listing_title, content_text, content_truncated, retrieved_at, draft, draft_version, warnings, error_code, error_message, expires_at, opportunity_id";

/** Logs carry function names and error codes only: never URLs, listing text, keys or drafts. */
function check<T>(name: string, r: { data: T; error: { code?: string } | null }): T {
  if (r.error) throw new Error(`${name} failed (${r.error.code ?? "unknown"})`);
  return r.data;
}

/** Stub DNS for isolated local runs: the reserved example host answers without a lookup; nothing is fetched. */
export const STUB_HOST = "jobs.example.com";
const stubResolver: Resolver = async (host) => (host === STUB_HOST ? ["93.184.215.14"] : systemResolver(host));

export function parseDraft(d: unknown): ImportDraft | null {
  const p = ImportDraft.safeParse(d);
  return p.success ? p.data : null;
}

export function importPorts(workerId: string): ImportPorts {
  const admin = createAdminClient();
  const stub = tinyfishMode() === "stub" && isolatedLocal();
  return {
    resolve: stub ? stubResolver : systemResolver,
    async begin(kind, url) {
      const { data, error } = await admin.rpc("opportunity_import_begin", { p_worker_id: workerId, p_source_kind: kind, p_url: url, p_daily_limit: dailyLimit() });
      if (error || !data) return { ok: false, reason: "error" };
      const r = data as { ok: boolean; id?: string; reason?: "in_progress" | "daily_limit" | "not_found" };
      return r.ok && r.id ? { ok: true, id: r.id } : { ok: false, reason: r.reason ?? "error" };
    },
    async fetched(id, d) {
      return check("import_fetched", await admin.rpc("opportunity_import_fetched", { p_worker_id: workerId, p_id: id, p_title: d.title, p_final_url: d.finalUrl, p_text: d.text, p_truncated: d.truncated, p_request_id: d.requestId, p_warnings: [] })) as boolean;
    },
    async fail(id, code, message) {
      check("import_fail", await admin.rpc("opportunity_import_fail", { p_worker_id: workerId, p_id: id, p_code: code, p_message: message }));
    },
    async lease(id) {
      return check("import_lease", await admin.rpc("opportunity_import_lease", { p_worker_id: workerId, p_id: id })) === true;
    },
    async load(id) {
      return check("import_load", await admin.from("opportunity_imports").select(IMPORT_COLUMNS).eq("id", id).eq("worker_id", workerId).maybeSingle<ImportRow>());
    },
    async drafted(id, draft, warnings) {
      return check("import_drafted", await admin.rpc("opportunity_import_drafted", { p_worker_id: workerId, p_id: id, p_draft: draft, p_warnings: warnings })) as number | null;
    },
    async fetchListing(url, timeoutMs) {
      if (stub) return fetchListingStub(url, { timeoutMs });
      return fetchListingLive(url, { apiKey: process.env.TINYFISH_API_KEY ?? "", timeoutMs });
    },
    async propose(listing, budgetMs) {
      return stub ? proposeWithStub(listing) : proposeWithGemini(listing, budgetMs);
    },
    now: () => Date.now(),
  };
}

export async function saveReview(workerId: string, id: string, version: number, draft: ImportDraft): Promise<number | null> {
  return check("import_save", await createAdminClient().rpc("opportunity_import_save_review", { p_worker_id: workerId, p_id: id, p_expected_version: version, p_draft: draft })) as number | null;
}

export async function confirmImport(workerId: string, id: string, version: number, opportunity: object, requirements: object[]) {
  return check("import_confirm", await createAdminClient().rpc("opportunity_import_confirm", { p_worker_id: workerId, p_id: id, p_expected_version: version, p_opportunity: opportunity, p_requirements: requirements })) as {
    ok: boolean;
    opportunityId?: string;
    repeated?: boolean;
    reason?: "not_found" | "expired" | "not_ready" | "changed";
  };
}
