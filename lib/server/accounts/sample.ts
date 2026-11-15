import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEMO_OPPORTUNITY, DEMO_REQUIREMENTS, REQUIREMENT_SOURCE } from "@/supabase/seed/demo-data";

export const SAMPLE_TITLE = `Sample (fictional): ${DEMO_OPPORTUNITY.title}`;

/**
 * Explicit opt-in only. Adds ONE clearly labelled fictional job (no evidence) so a new worker can try matching.
 * Idempotent: a second call does nothing.
 */
export async function addSampleOpportunity(workerId: string): Promise<{ created: boolean }> {
  const admin = createAdminClient();
  const { data: existing } = await admin.from("opportunities").select("id").eq("worker_id", workerId).eq("title", SAMPLE_TITLE).maybeSingle();
  if (existing) return { created: false };
  const id = randomUUID();
  const { error } = await admin.from("opportunities").insert({
    id,
    worker_id: workerId,
    title: SAMPLE_TITLE,
    employer: DEMO_OPPORTUNITY.employer,
    description: `${DEMO_OPPORTUNITY.description} Added as a sample at your request; it is not a real job.`,
    source_url: null,
    is_synthetic: true,
  });
  if (error) throw new Error(`sample opportunity failed (${error.code})`);
  const { error: reqError } = await admin.from("requirements").insert(
    DEMO_REQUIREMENTS.map((r) => ({
      id: randomUUID(),
      opportunity_id: id,
      position: r.position,
      original_text: r.originalText,
      criteria_json: r.criteria,
      mandatory: r.mandatory,
      source: REQUIREMENT_SOURCE,
    })),
  );
  if (reqError) throw new Error(`sample requirements failed (${reqError.code})`);
  return { created: true };
}
