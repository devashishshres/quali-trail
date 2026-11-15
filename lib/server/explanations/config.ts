/**
 * AI-assisted explanation configuration. OFF unless AI_EXPLANATIONS_ENABLED=true. Messages name variables only.
 *
 *  - AI_EXPLANATIONS_ENABLED       "true" to offer explanations (default off; the route answers 404 when off)
 *  - AI_EXPLANATIONS_MODE          "live" (default: Supermemory search + Gemini) or "stub" (deterministic local stand-ins
 *                                  for both; isolated local setups only)
 *  - AI_EXPLANATIONS_DAILY_LIMIT   explanation generations per technician per 24 h (default 20, max 200)
 * Live mode also needs GEMINI_API_KEY and SUPERMEMORY_API_KEY. Every mode needs SIGNOFF_PEPPER (rate limiting).
 */
import { isolatedLocal, rateLimitProblems, type ConfigProblem } from "../config";

export const explanationsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.AI_EXPLANATIONS_ENABLED === "true";
export const explanationsMode = (env: NodeJS.ProcessEnv = process.env): "live" | "stub" => (env.AI_EXPLANATIONS_MODE === "stub" ? "stub" : "live");

export function explanationsDailyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AI_EXPLANATIONS_DAILY_LIMIT ?? "20");
  return Number.isInteger(n) && n >= 0 && n <= 200 ? n : 20;
}

export function explanationsConfigProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const flag = env.AI_EXPLANATIONS_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false") out.push({ name: "AI_EXPLANATIONS_ENABLED", problem: "must be true or false (treated as false)" });
  if (env.AI_EXPLANATIONS_MODE !== undefined && !["live", "stub"].includes(env.AI_EXPLANATIONS_MODE)) out.push({ name: "AI_EXPLANATIONS_MODE", problem: "must be live or stub (treated as live)" });
  if (env.AI_EXPLANATIONS_DAILY_LIMIT !== undefined && explanationsDailyLimit(env) !== Number(env.AI_EXPLANATIONS_DAILY_LIMIT)) {
    out.push({ name: "AI_EXPLANATIONS_DAILY_LIMIT", problem: "must be a whole number from 0 to 200 (treated as 20)" });
  }
  if (!explanationsEnabled(env)) return out;
  if (explanationsMode(env) === "stub") {
    if (!isolatedLocal(env)) out.push({ name: "AI_EXPLANATIONS_MODE", problem: "stub is only allowed on an isolated local setup" });
  } else {
    if (!env.GEMINI_API_KEY) out.push({ name: "GEMINI_API_KEY", problem: "is not set (explanations need it)" });
    if (!env.SUPERMEMORY_API_KEY) out.push({ name: "SUPERMEMORY_API_KEY", problem: "is not set (explanations search related records)" });
  }
  out.push(...rateLimitProblems(env, "explanation"));
  return out;
}

export const explanationsAvailable = (env: NodeJS.ProcessEnv = process.env) => explanationsEnabled(env) && explanationsConfigProblems(env).length === 0;
