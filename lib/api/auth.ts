import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createUserClient } from "../supabase/server";
import { WORKER_COLUMNS, type WorkerRow } from "../supabase/mappers";

export interface AuthedContext {
  supabase: SupabaseClient;
  authUserId: string;
  worker: WorkerRow;
}

/**
 * Resolve the signed-in user and their worker profile.
 * Returns null when there is no valid session or no worker profile.
 *
 * Uses auth.getUser() (verified with Supabase Auth), not getSession()
 * (which only reads the cookie and can be spoofed).
 */
export async function getAuthedContext(): Promise<AuthedContext | null> {
  const supabase = await createUserClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;

  const { data: worker, error } = await supabase
    .from("workers")
    .select(WORKER_COLUMNS)
    .eq("auth_user_id", userData.user.id)
    .maybeSingle<WorkerRow>();
  if (error || !worker) return null;

  return { supabase, authUserId: userData.user.id, worker };
}
