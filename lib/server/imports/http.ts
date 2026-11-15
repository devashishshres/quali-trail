import "server-only";
import { getAuthedContext, type AuthedContext } from "@/lib/api/auth";
import { apiError } from "@/lib/api/responses";
import { describeProblems } from "../config";
import { logSignoffError } from "../signoff/redact";
import { allow } from "../signoff/service";
import { importConfigProblems, importEnabled } from "./config";

/**
 * Shared gate for every import route: flag (404 when off, as if the routes did not exist), server setup (503),
 * session (401) and a per-technician rate limit on all import actions (fails closed via `guarded`).
 */
export async function importGate(action: "start" | "read" | "write"): Promise<{ ctx: AuthedContext } | { response: Response }> {
  if (!importEnabled()) return { response: apiError("not_found", "Not found.") };
  const problems = importConfigProblems();
  if (problems.length) {
    logSignoffError("import-config", new Error(describeProblems(problems)));
    return { response: apiError("unavailable", "Job import isn't available on this server right now.") };
  }
  const ctx = await getAuthedContext();
  if (!ctx) return { response: apiError("unauthorized", "Sign in to import a job.") };
  const limits = { start: [3600, 20], write: [3600, 120], read: [300, 300] } as const;
  const [win, max] = limits[action];
  if (!(await allow(`import-${action}`, ctx.worker.id, win, max))) return { response: apiError("rate_limited", "Too many import requests. Please wait a few minutes.") };
  return { ctx };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
