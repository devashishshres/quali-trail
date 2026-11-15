import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Evidence } from "@/lib/types";
import { RequirementExplanation, RunExplanations } from "@/lib/types/explanations";
import type { MemorySearcher } from "../memory/types";
import { explanationsDailyLimit, explanationsMode } from "./config";
import { explainWithGemini, explainWithStub } from "./model";
import type { ClaimResult, ExplainPorts } from "./service";

interface Row {
  match_run_id: string;
  status: "processing" | "completed" | "failed";
  ai_status: "ok" | "failed" | "skipped" | null;
  rejected_references: number;
  items: unknown;
  updated_at: string;
}
const COLUMNS = "match_run_id, status, ai_status, rejected_references, items, updated_at";
const Items = z.array(RequirementExplanation);

/** Table missing (migration not applied yet): explanations simply don't exist. */
const missingTable = (code?: string) => code === "42P01" || code === "PGRST205" || code === "PGRST202" || code === "42883";

function toExplanations(row: Row, current: Map<string, number> | null): RunExplanations | null {
  if (row.status !== "completed" || !row.ai_status) return { runId: row.match_run_id, status: row.status, aiStatus: row.ai_status ?? "skipped", rejectedReferences: row.rejected_references, generatedAt: row.updated_at, items: [] };
  const parsed = Items.safeParse(row.items);
  if (!parsed.success) return null; // never show something that does not match the contract
  const items = parsed.data.map((it) => {
    if (!current) return it;
    // A cited record that was deleted is dropped; one that changed marks the explanation as out of date.
    const related = it.related.filter((r) => current.has(r.evidenceId));
    const stale = related.length !== it.related.length || related.some((r) => current.get(r.evidenceId) !== r.evidenceVersion);
    return { ...it, related, stale };
  });
  return RunExplanations.parse({ runId: row.match_run_id, status: row.status, aiStatus: row.ai_status, rejectedReferences: row.rejected_references, generatedAt: row.updated_at, items });
}

/** The run's explanation, checked against the worker's CURRENT records. Null when none exists. */
export async function readExplanations(admin: SupabaseClient, workerId: string, runId: string, evidence: Pick<Evidence, "id" | "version">[]): Promise<RunExplanations | null> {
  const { data, error } = await admin.from("match_run_explanations").select(COLUMNS).eq("match_run_id", runId).eq("worker_id", workerId).maybeSingle<Row>();
  if (error) {
    if (missingTable(error.code)) return null;
    throw new Error(`explanation query failed (${error.code})`);
  }
  return data ? toExplanations(data, new Map(evidence.map((e) => [e.id, e.version]))) : null;
}

export function explanationPorts(args: { admin: SupabaseClient; workerId: string; search: MemorySearcher; jobTitle: string }): ExplainPorts {
  const { admin, workerId } = args;
  return {
    now: () => Date.now(),
    search: (q) => args.search(workerId, q),
    propose: (input, budget) => (explanationsMode() === "stub" ? explainWithStub(input, { jobTitle: args.jobTitle }) : explainWithGemini(input, budget)),
    async claim(runId): Promise<ClaimResult> {
      const { data, error } = await admin.rpc("explanation_claim", { p_worker_id: workerId, p_run_id: runId, p_daily_limit: explanationsDailyLimit() });
      if (error) throw new Error(`explanation_claim failed (${error.code})`);
      if (data === "existing") {
        const r = await admin.from("match_run_explanations").select(COLUMNS).eq("match_run_id", runId).eq("worker_id", workerId).single<Row>();
        const ex = r.data ? toExplanations(r.data, null) : null;
        if (!ex) throw new Error("stored explanation is unreadable");
        return { kind: "existing", explanations: ex };
      }
      if (["claimed", "busy", "exhausted", "limited", "not_found"].includes(data as string)) return { kind: data } as ClaimResult;
      throw new Error("invalid explanation_claim response");
    },
    async save(runId, d, model) {
      const items = Items.parse(d.items);
      const { data, error } = await admin.rpc("explanation_save", { p_worker_id: workerId, p_run_id: runId, p_ai_status: d.aiStatus, p_model: model, p_rejected: d.rejectedReferences, p_items: items });
      if (error || data !== true) throw new Error(`explanation_save failed (${error?.code ?? "not processing"})`);
      return RunExplanations.parse({ runId, status: "completed", aiStatus: d.aiStatus, rejectedReferences: d.rejectedReferences, generatedAt: new Date().toISOString(), items });
    },
    async fail(runId, code) {
      const { error } = await admin.rpc("explanation_fail", { p_worker_id: workerId, p_run_id: runId, p_error_code: code });
      if (error) throw new Error(`explanation_fail failed (${error.code})`);
    },
  };
}
