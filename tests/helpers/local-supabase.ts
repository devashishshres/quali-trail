/**
 * Points server code at the ISOLATED LOCAL Supabase stack (`npx supabase start`) for integration tests.
 * Refuses anything that is not localhost, so a misconfigured environment can never reach a hosted project.
 *
 *   TEST_SUPABASE_URL=http://127.0.0.1:54321 TEST_SUPABASE_SECRET_KEY=<local secret from `npx supabase status`> \
 *   TEST_SUPABASE_PUBLISHABLE_KEY=<local publishable> npx vitest run
 */
import { createClient } from "@supabase/supabase-js";

export const LOCAL_URL = process.env.TEST_SUPABASE_URL;
export const LOCAL_SECRET = process.env.TEST_SUPABASE_SECRET_KEY;
export const LOCAL_PUBLISHABLE = process.env.TEST_SUPABASE_PUBLISHABLE_KEY;
export const hasLocalStack = Boolean(LOCAL_URL && LOCAL_SECRET && LOCAL_PUBLISHABLE);

export function useLocalStack() {
  const host = new URL(LOCAL_URL!).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("Integration tests only run against a local Supabase stack");
  process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL;
  process.env.SUPABASE_SECRET_KEY = LOCAL_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = LOCAL_PUBLISHABLE;
  return createClient(LOCAL_URL!, LOCAL_SECRET!, { auth: { persistSession: false, autoRefreshToken: false } });
}
