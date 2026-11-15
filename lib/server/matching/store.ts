import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EVIDENCE_COLUMNS, toEvidence, type EvidenceRow } from "@/lib/supabase/mappers";
import { MatchRun, MatchRunResponse, RequirementResult, type Evidence } from "@/lib/types";
import { computeChanges } from "./changes";
import { RunInProgressError, type MatchPorts } from "./run";
import type { MemorySearcher } from "../memory/types";

interface RunRow {
  id: string;
  worker_id: string;
  opportunity_id: string;
  evidence_revision: number | string;
  status: string;
  memory_warning: string | null;
  created_at: string;
}
interface ResultRow {
  requirement_id: string;
  assessment: string;
  explanation: string;
  uncertainties: string[];
  missing_documentation: string[];
}
interface MatchRow {
  requirement_id: string;
  evidence_id: string;
  role: string;
  contribution: string;
  relevance_explanation: string;
  memory_similarity: number | null;
}

const RUN_COLUMNS = "id, worker_id, opportunity_id, evidence_revision, status, memory_warning, created_at";

/** Worker's evidence, read as the signed-in user (RLS) with an explicit owner filter. */
export async function loadWorkerEvidence(user: SupabaseClient, workerId: string): Promise<Evidence[]> {
  const { data, error } = await user.from("evidence").select(EVIDENCE_COLUMNS).eq("worker_id", workerId).returns<EvidenceRow[]>();
  if (error) throw new Error(`evidence query failed (${error.code})`);
  return data.map(toEvidence);
}

/**
 * Rebuild a saved run from the database. Display fields (title, date, type,
 * verification) come from CURRENT evidence rows; requirement wording comes
 * from the requirements table. Returns null if the run is not this worker's.
 */
export async function readRun(user: SupabaseClient, workerId: string, runId: string): Promise<MatchRun | null> {
  const { data: run, error } = await user
    .from("match_runs")
    .select(RUN_COLUMNS)
    .eq("id", runId)
    .eq("worker_id", workerId)
    .maybeSingle<RunRow>();
  if (error) throw new Error(`run query failed (${error.code})`);
  if (!run) return null;

  const [reqs, results, matches, evidence] = await Promise.all([
    user.from("requirements").select("id, position, original_text, mandatory").eq("opportunity_id", run.opportunity_id).order("position"),
    user.from("requirement_results").select("requirement_id, assessment, explanation, uncertainties, missing_documentation").eq("match_run_id", run.id).returns<ResultRow[]>(),
    user.from("evidence_matches").select("requirement_id, evidence_id, role, contribution, relevance_explanation, memory_similarity").eq("match_run_id", run.id).eq("worker_id", workerId).returns<MatchRow[]>(),
    loadWorkerEvidence(user, workerId),
  ]);
  for (const r of [reqs, results, matches]) if (r.error) throw new Error(`run detail query failed (${r.error.code})`);

  const ev = new Map(evidence.map((e) => [e.id, e]));
  const resultByReq = new Map((results.data ?? []).map((r) => [r.requirement_id, r]));

  const out = (reqs.data ?? []).flatMap((req) => {
    const r = resultByReq.get(req.id);
    if (!r) return []; // run not completed: no result rows
    const connections = (matches.data ?? [])
      .filter((m) => m.requirement_id === req.id && ev.has(m.evidence_id))
      .map((m) => {
        const e = ev.get(m.evidence_id)!;
        return {
          evidenceId: e.id,
          evidenceTitle: e.title,
          evidenceDate: e.date,
          evidenceType: e.type,
          evidenceIssuer: e.issuer,
          verificationStatus: e.verificationStatus,
          role: m.role,
          contribution: m.contribution,
          relevanceExplanation: m.relevance_explanation,
          memorySimilarity: m.memory_similarity,
        };
      });
    return [
      {
        requirementId: req.id,
        originalText: req.original_text,
        mandatory: req.mandatory,
        assessment: r.assessment,
        connections,
        explanation: r.explanation,
        uncertainties: r.uncertainties,
        missingDocumentation: r.missing_documentation,
      },
    ];
  });

  return MatchRun.parse({
    id: run.id,
    workerId: run.worker_id,
    opportunityId: run.opportunity_id,
    status: run.status,
    evidenceRevision: Number(run.evidence_revision),
    memoryWarning: run.memory_warning,
    results: out,
    createdAt: run.created_at,
  });
}

/** Most recent EARLIER run with saved results for the same opportunity. */
async function previousRun(user: SupabaseClient, workerId: string, run: MatchRun, createdAtRaw: string): Promise<MatchRun | null> {
  const { data, error } = await user
    .from("match_runs")
    .select("id, requirement_results!inner(id)")
    .eq("worker_id", workerId)
    .eq("opportunity_id", run.opportunityId)
    .in("status", ["completed", "stale"])
    .lt("created_at", createdAtRaw)
    .neq("id", run.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`previous run query failed (${error.code})`);
  return data?.[0] ? readRun(user, workerId, data[0].id) : null;
}

export async function readRunResponse(user: SupabaseClient, workerId: string, runId: string): Promise<MatchRunResponse | null> {
  const run = await readRun(user, workerId, runId);
  if (!run) return null;
  const prev = await previousRun(user, workerId, run, run.createdAt);
  return MatchRunResponse.parse({
    matchRun: run,
    previousRunId: prev?.id ?? null,
    changes: prev ? computeChanges(prev.results, run.results) : [],
  });
}

/**
 * Latest run that can be shown as a report: completed or stale. Processing and
 * failed runs are never returned, so they cannot be mistaken for a current
 * result (a stale one is returned AS stale so the UI can say so).
 */
export async function latestRunId(user: SupabaseClient, workerId: string, opportunityId: string): Promise<string | null> {
  const { data, error } = await user
    .from("match_runs")
    .select("id, requirement_results!inner(id)")
    .eq("worker_id", workerId)
    .eq("opportunity_id", opportunityId)
    .in("status", ["completed", "stale"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`latest run query failed (${error.code})`);
  return data?.[0]?.id ?? null;
}

/** Real ports: trusted RPCs via the admin client, worker identity passed explicitly. */
export class MatchingSetupError extends Error {}

export function supabasePorts(args: {
  user: SupabaseClient;
  admin: SupabaseClient;
  workerId: string;
  search: MemorySearcher;
}): MatchPorts {
  const { user, admin, workerId } = args;
  return {
    search: args.search,
    today: () => new Date().toISOString().slice(0, 10),
    loadEvidence: () => loadWorkerEvidence(user, workerId),
    async startRun(opportunityId) {
      const { data, error } = await admin.rpc("start_match_run", { p_worker_id: workerId, p_opportunity_id: opportunityId });
      if (error?.code === "PGRST202" || error?.code === "42883") throw new MatchingSetupError("Matching setup is incomplete.");
      if (error?.code === "55P03") throw new RunInProgressError("A matching run is already in progress.");
      if (error || !data?.[0]) throw new Error(`start_match_run failed (${error?.code ?? "no row"})`);
      return { runId: data[0].id as string };
    },
    async finalize(runId, db, memoryWarning) {
      const { data, error } = await admin.rpc("finalize_match_run", {
        p_worker_id: workerId,
        p_run_id: runId,
        p_results: db.results,
        p_matches: db.matches,
        p_memory_warning: memoryWarning,
      });
      if (error) throw new Error(`finalize_match_run failed (${error.code})`);
      if (data !== "completed" && data !== "stale") throw new Error("Invalid match finalization response");
      return data;
    },
    async fail(runId, message, memoryWarning) {
      const { error } = await admin.rpc("fail_match_run", { p_worker_id: workerId, p_run_id: runId, p_error: message, p_memory_warning: memoryWarning });
      if (error) throw new Error(`fail_match_run failed (${error.code})`);
    },
  };
}

export { RequirementResult };
