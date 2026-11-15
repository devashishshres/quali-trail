import { z } from "zod";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { readRunResponse } from "@/lib/server/matching/store";

/** GET /api/matches/:id — one saved run belonging to the signed-in worker. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in to view match results.");

  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return apiError("validation_failed", "That isn't a valid match id.");

  try {
    const response = await readRunResponse(ctx.supabase, ctx.worker.id, id.data);
    return response ? ok(response) : apiError("not_found", "That match run isn't available.");
  } catch (e) {
    console.error("GET /api/matches/:id failed", { message: e instanceof Error ? e.message : "unknown" });
    return apiError("internal", "Could not load the match run. Please try again.");
  }
}
