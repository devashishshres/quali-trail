import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read the worker's optional career summary. Deliberately separate from sign-in:
 * if the column does not exist yet (migration not applied) or the read fails,
 * the summary is simply absent and everything else keeps working.
 */
export async function readWorkerSummary(supabase: SupabaseClient, workerId: string): Promise<string | null> {
  const { data, error } = await supabase.from("workers").select("summary").eq("id", workerId).maybeSingle<{ summary: string | null }>();
  if (error) return null;
  const text = data?.summary?.trim();
  return text ? text : null;
}
