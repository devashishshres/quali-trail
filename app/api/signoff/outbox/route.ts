import { readFile } from "node:fs/promises";
import { getAuthedContext } from "@/lib/api/auth";
import { apiError, ok } from "@/lib/api/responses";
import { mockOutboxAllowed } from "@/lib/server/email/config";
import { OUTBOX_PATH } from "@/lib/server/email/transport";
import { redact } from "@/lib/server/signoff/redact";

/**
 * GET /api/signoff/outbox — SIMULATED messages for the signed-in worker's own requests, only in mock mode.
 * Nothing in this list was emailed to anyone. It never returns codes or invitation links: those belong to the
 * customer, and showing them to the worker would let the worker answer as the customer. A developer testing the
 * customer side reads the local, git-ignored outbox file directly.
 */
export async function GET() {
  const ctx = await getAuthedContext();
  if (!ctx) return apiError("unauthorized", "Sign in first.");
  if (!mockOutboxAllowed()) return apiError("not_found", "Not available.");
  const text = await readFile(OUTBOX_PATH, "utf8").catch(() => "");
  const messages = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const m = JSON.parse(line) as { at: string; subject: string; text: string; meta?: { workerId?: string; kind?: string } };
        const kind = m.meta?.kind;
        // Only messages the worker caused to be sent to someone else, minus anything secret. Never codes.
        return m.meta?.workerId === ctx.worker.id && (kind === "customer_invitation" || kind === "reminder" || kind === "supervisor_invitation" || kind === "review_notification")
          ? [{ simulated: true, at: m.at, kind, subject: m.subject, text: redact(m.text).replace(/https?:\/\/\S+/g, "[link withheld]") }]
          : [];
      } catch {
        return [];
      }
    })
    .slice(-10)
    .reverse();
  return ok({ simulated: true, messages });
}
