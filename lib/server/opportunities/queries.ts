import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Opportunity } from "@/lib/types";
import {
  OPPORTUNITY_COLUMNS,
  REQUIREMENT_COLUMNS,
  toOpportunity,
  type OpportunityRow,
  type RequirementRow,
} from "./mappers";

/**
 * All opportunities owned by the signed-in worker, each with its requirements
 * in posting order. Runs as the user (RLS applies); the explicit worker_id
 * filter is a second, independent ownership check.
 */
export async function listWorkerOpportunities(supabase: SupabaseClient, workerId: string): Promise<Opportunity[]> {
  const { data: opps, error } = await supabase
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("worker_id", workerId)
    .order("created_at", { ascending: true })
    .returns<OpportunityRow[]>();
  if (error) throw new Error(`opportunities query failed (${error.code})`);
  if (opps.length === 0) return [];

  const { data: reqs, error: reqError } = await supabase
    .from("requirements")
    .select(REQUIREMENT_COLUMNS)
    .in("opportunity_id", opps.map((o) => o.id))
    .order("position", { ascending: true })
    .returns<RequirementRow[]>();
  if (reqError) throw new Error(`requirements query failed (${reqError.code})`);

  return opps.map((o) => toOpportunity(o, reqs.filter((r) => r.opportunity_id === o.id)));
}

/** One opportunity, or null when it does not exist or belongs to someone else. */
export async function getWorkerOpportunity(
  supabase: SupabaseClient,
  workerId: string,
  opportunityId: string,
): Promise<Opportunity | null> {
  const { data: opp, error } = await supabase
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("id", opportunityId)
    .eq("worker_id", workerId)
    .maybeSingle<OpportunityRow>();
  if (error) throw new Error(`opportunity query failed (${error.code})`);
  if (!opp) return null;

  const { data: reqs, error: reqError } = await supabase
    .from("requirements")
    .select(REQUIREMENT_COLUMNS)
    .eq("opportunity_id", opp.id)
    .order("position", { ascending: true })
    .returns<RequirementRow[]>();
  if (reqError) throw new Error(`requirements query failed (${reqError.code})`);
  return toOpportunity(opp, reqs);
}
