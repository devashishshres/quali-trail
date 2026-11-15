import { STATEMENT_VERSION } from "@/lib/server/signoff/statement";
import { notifyCustomerDecision } from "@/lib/server/signoff/notify";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, clientIp, featureOn, gone, json, off, rpc, sessionHash, tokenHash, tooMany } from "@/lib/server/signoff/service";
import { RespondRequest } from "@/lib/types";

const CLOSED: Record<string, string> = {
  expired: "This request has expired.",
  revoked: "The technician cancelled this request.",
  superseded: "The record changed after this request was sent. Ask the technician to send a new one.",
  locked: "This request is locked.",
  already_responded: "A different response was already recorded for this request.",
};

/** POST /api/signoff/respond — records ONE decision. Repeat or concurrent submissions cannot create a second one. */
export async function POST(request: Request) {
  if (!featureOn()) return off();
  if (!(await allow("respond-ip", await clientIp(), 600, 30))) return tooMany();
  const [th, sh] = [await tokenHash(request), await sessionHash()];
  if (!th || !sh) return gone();
  const body = RespondRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: { code: "validation_failed", message: "Check what you entered and try again." } }, 400);
  const d = body.data;
  const r = await rpc("signoff_respond", {
    p_token_hash: th,
    p_session_hash: sh,
    p_decision: d.decision,
    p_typed_name: d.decision === "confirm" ? d.typedName : null,
    p_comment: d.decision === "request_correction" ? d.comment : null,
    p_statement_version: STATEMENT_VERSION,
  });
  if (r.ok) {
    if (r.repeated !== true) {
      // Receipts are best-effort: the decision is already recorded and is never undone by an email failure.
      await notifyCustomerDecision({
        requestId: String(r.requestId), workerId: String(r.workerId), status: String(r.status),
        title: String(r.title), workerName: String(r.workerName), deliveryMode: String(r.deliveryMode),
      }).catch((e) => logSignoffError("receipt", e));
    }
    return json({ recorded: true, repeated: r.repeated === true });
  }
  const reason = String(r.reason);
  if (CLOSED[reason]) return json({ error: { code: "forbidden", message: CLOSED[reason], reason } }, 409);
  return gone();
}
