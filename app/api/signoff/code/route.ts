import { hmac, newCode } from "@/lib/server/signoff/crypto";
import { codeMessage, sendMessage } from "@/lib/server/signoff/mailer";
import { signoffStatus } from "@/lib/server/signoff/config";
import { logSignoffError } from "@/lib/server/signoff/redact";
import { allow, appBaseUrl, clientIp, featureOn, gone, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

/** POST /api/signoff/code — email a one-time code to the address the worker provided (and only that address). */
export async function POST(request: Request) {
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
  try {
    const mail = codeMessage({ workerName: String(issued.workerName), code, base: appBaseUrl(), mock: issued.deliveryMode === "mock" });
    await sendMessage({
      kind: "code",
      to: String(issued.email),
      ...mail,
      idempotencyKey: `code-${issued.requestId}-${th.slice(0, 8)}-${Date.now()}`,
      meta: { workerId: String(issued.workerId), requestId: String(issued.requestId) },
    });
  } catch (e) {
    logSignoffError("send-code", e);
    return json({ error: { code: "internal", message: "The code couldn't be sent. Please try again in a minute." } }, 502);
  }
  return json({ sent: true, simulated: issued.deliveryMode === "mock" });
}
