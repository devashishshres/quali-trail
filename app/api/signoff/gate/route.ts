import { allow, clientIp, featureOn, gone, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";
import type { GateResponse } from "@/lib/types";

/** POST /api/signoff/gate — minimal facts for the invitation page. No job details. */
export async function POST(request: Request) {
  if (!featureOn()) return off();
  if (!(await allow("gate-ip", await clientIp(), 600, 60))) return tooMany();
  const th = await tokenHash(request);
  if (!th) return gone();
  const r = await rpc("signoff_gate", { p_token_hash: th });
  if (!r.ok) return gone();
  const body: GateResponse = {
    status: r.status as GateResponse["status"],
    workerName: String(r.workerName),
    emailHint: (r.emailHint as string | null) ?? null,
    deliveryMode: r.deliveryMode as GateResponse["deliveryMode"],
  };
  return json(body);
}
