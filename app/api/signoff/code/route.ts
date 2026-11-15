import { hmac, newCode } from "@/lib/server/signoff/crypto";
import { deliver } from "@/lib/server/email/deliver";
import { templates } from "@/lib/server/email/templates";
import { signoffStatus } from "@/lib/server/signoff/config";
import { allow, appBaseUrl, clientIp, featureOn, gone, guarded, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

/** POST /api/signoff/code — email a one-time code to the address the worker provided (and only that address). */
async function handlePOST(request: Request) {
  if (!featureOn()) return off();
  const status = signoffStatus();
  if (!status.ready) return off();
  const th = await tokenHash(request);
  if (!th) return gone();
  if (!(await allow("code-ip", await clientIp(), 3600, 10)) || !(await allow("code-token", th, 3600, 6))) return tooMany();

  const code = newCode();
  const issued = await rpc("signoff_issue_code", { p_token_hash: th, p_code_hash: hmac("code", `${th}:${code}`) });
  if (!issued.ok) {
    if (issued.reason === "too_soon") return json({ error: { code: "rate_limited", message: "A code was just sent. Wait a minute before asking for another." } }, 429);
    if (issued.reason === "limit") return json({ error: { code: "rate_limited", message: "The limit of codes for this request was reached." } }, 429);
    return gone();
  }
  const sent = await deliver({
    kind: "customer_code",
    to: String(issued.email),
    rendered: templates.customerCode({ base: appBaseUrl(), mock: issued.deliveryMode === "mock", workerName: String(issued.workerName), code }),
    // One key per issued code: a retried request cannot send the same code twice; a reissue is a new key.
    idempotencyKey: `code-${issued.requestId}-${hmac("rate", code).slice(0, 16)}`,
    related: { type: "signoff_request", id: String(issued.requestId) },
    workerId: String(issued.workerId),
  });
  if (!sent.ok) return json({ error: { code: "internal", message: "The code couldn't be sent. Please try again in a minute." } }, 502);
  return json({ sent: true, simulated: issued.deliveryMode === "mock" });
}

export const POST = guarded(handlePOST);
