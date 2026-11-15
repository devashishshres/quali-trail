/**
 * Job-import configuration. Off unless OPPORTUNITY_IMPORT_ENABLED=true. Messages name variables, never values.
 *
 *  - OPPORTUNITY_IMPORT_ENABLED   "true" to offer import (default off; routes answer 404 when off)
 *  - TINYFISH_API_KEY             server-only; required unless TINYFISH_MODE=stub
 *  - TINYFISH_MODE                "live" (default) or "stub" (fictional listings; isolated local only)
 *  - IMPORT_DAILY_LIMIT           provider retrievals per technician per 24 h (default 10, max 100)
 */
import { isolatedLocal, rateLimitProblems, type ConfigProblem } from "../config";

export const importEnabled = (env: NodeJS.ProcessEnv = process.env) => env.OPPORTUNITY_IMPORT_ENABLED === "true";

export type TinyfishMode = "live" | "stub";
export const tinyfishMode = (env: NodeJS.ProcessEnv = process.env): TinyfishMode => (env.TINYFISH_MODE === "stub" ? "stub" : "live");

export function dailyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.IMPORT_DAILY_LIMIT ?? "10");
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : 10;
}

export function importConfigProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const flag = env.OPPORTUNITY_IMPORT_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false") out.push({ name: "OPPORTUNITY_IMPORT_ENABLED", problem: "must be true or false (treated as false)" });
  if (env.TINYFISH_MODE !== undefined && !["live", "stub"].includes(env.TINYFISH_MODE)) out.push({ name: "TINYFISH_MODE", problem: "must be live or stub (treated as live)" });
  if (env.IMPORT_DAILY_LIMIT !== undefined && dailyLimit(env) !== Number(env.IMPORT_DAILY_LIMIT)) out.push({ name: "IMPORT_DAILY_LIMIT", problem: "must be a whole number from 0 to 100 (treated as 10)" });
  if (!importEnabled(env)) return out;
  if (tinyfishMode(env) === "stub") {
    if (!isolatedLocal(env)) out.push({ name: "TINYFISH_MODE", problem: "stub is only allowed on an isolated local setup (not hosted; APP_BASE_URL and Supabase both on localhost)" });
  } else if (!env.TINYFISH_API_KEY) {
    out.push({ name: "TINYFISH_API_KEY", problem: "is not set (required when OPPORTUNITY_IMPORT_ENABLED=true)" });
  }
  if (!env.GEMINI_API_KEY) out.push({ name: "GEMINI_API_KEY", problem: "is not set (import drafts need it)" });
  out.push(...rateLimitProblems(env, "import"));
  return out;
}
