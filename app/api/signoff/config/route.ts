import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { signoffStatus } from "@/lib/server/signoff/config";
import type { SignoffConfig } from "@/lib/types";

/** GET /api/signoff/config — what the worker UI may offer. Names no secrets. */
export async function GET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  const { enabled, mode, ready } = signoffStatus();
  return ok<SignoffConfig>({ enabled, mode, ready });
}
