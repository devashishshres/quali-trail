import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./server";

/**
 * Supabase client with the SECRET key. BYPASSES Row Level Security.
 *
 * Only use it for operations a user must not be able to do themselves:
 * updating Supermemory index status, writing verification events,
 * deleting storage objects during account deletion.
 * Always check ownership in code before using it.
 */
export function createAdminClient() {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
