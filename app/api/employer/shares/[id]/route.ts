import { z } from "zod";
import { getAccount } from "@/lib/api/auth";
import { employerReviewEnabled } from "@/lib/server/employer/flags";
import { allow, guarded, json, off, rpc, tooMany } from "@/lib/server/signoff/service";
import { SharedPacket } from "@/lib/types/employer";

const CLOSED: Record<string, string> = {
  revoked: "The technician withdrew this share.",
  expired: "This share has expired.",
  pending: "Open this packet from the link in your email first.",
};

/** GET /api/employer/shares/:id — the frozen packet, only for the account that opened it, while active. Logged. */
async function handleGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!employerReviewEnabled()) return off();
  const a = await getAccount();
  if (!a || !a.user.emailConfirmed) return json({ error: { code: "unauthorized", message: "Sign in with a confirmed email address." } }, 401);
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return off();
  if (!(await allow("employer-view-user", a.user.id, 600, 120))) return tooMany();
  const r = await rpc("employer_share_get", { p_auth: a.user.id, p_share: id.data });
  if (!r.ok) {
    const reason = String(r.reason);
    if (CLOSED[reason]) return json({ error: { code: "forbidden", message: CLOSED[reason], reason } }, 410);
    return off();
  }
  return json(SharedPacket.parse(r));
}

export const GET = guarded(handleGET);
