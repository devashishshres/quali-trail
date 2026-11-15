"use client";
import { createBrowserClient } from "@supabase/ssr";

/** Browser Supabase client (publishable key only). Used for sign-in / sign-out. */
export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
