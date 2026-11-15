import { readFile } from "node:fs/promises";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { mailMode } from "@/lib/server/signoff/config";
import { OUTBOX_PATH } from "@/lib/server/signoff/mailer";

/**
 * GET /api/signoff/outbox — SIMULATED messages for the signed-in worker's own requests, only in mock mode.
 * Nothing in this list was emailed to anyone. It exists so the flow can be tested locally.
 */
export async function GET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (mailMode() !== "mock" || process.env.NODE_ENV === "production") return apiError("not_found", "Not available.");
  const text = await readFile(OUTBOX_PATH, "utf8").catch(() => "");
  const messages = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const m = JSON.parse(line) as { simulated: boolean; at: string; kind: string; subject: string; text: string; meta?: { workerId?: string } };
        return m.meta?.workerId === ctx.worker.id ? [{ simulated: true, at: m.at, kind: m.kind, subject: m.subject, text: m.text }] : [];
      } catch {
        return [];
      }
    })
    .slice(-10)
    .reverse();
  return ok({ simulated: true, messages });
}
