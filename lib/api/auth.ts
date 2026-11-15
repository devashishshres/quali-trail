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

export interface SupervisorProfileRow {
  auth_user_id: string;
  name: string;
  organization: string | null;
  title: string | null;
}

export interface Account {
  supabase: SupabaseClient;
  user: { id: string; email: string | null; emailConfirmed: boolean };
  worker: WorkerRow | null;
  supervisor: SupervisorProfileRow | null;
}

/**
 * The signed-in user and whichever roles they have (none, worker, supervisor, or both).
 * Roles are read with the user's own client, so RLS limits each lookup to the caller's own row.
 */
export async function getAccount(): Promise<Account | null> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const [w, s] = await Promise.all([
    supabase.from("workers").select(WORKER_COLUMNS).eq("auth_user_id", data.user.id).maybeSingle<WorkerRow>(),
    supabase.from("supervisor_profiles").select("auth_user_id, name, organization, title").eq("auth_user_id", data.user.id).maybeSingle<SupervisorProfileRow>(),
  ]);
  return {
    supabase,
    user: { id: data.user.id, email: data.user.email ?? null, emailConfirmed: Boolean(data.user.email_confirmed_at) },
    worker: w.data ?? null,
    supervisor: s.error ? null : (s.data ?? null),
  };
}

/** A signed-in supervisor with a confirmed email. Being a supervisor grants no access by itself. */
export async function getSupervisorContext(): Promise<(Account & { supervisor: SupervisorProfileRow }) | null> {
  const a = await getAccount();
  if (!a || !a.supervisor || !a.user.emailConfirmed) return null;
  return a as Account & { supervisor: SupervisorProfileRow };
}
