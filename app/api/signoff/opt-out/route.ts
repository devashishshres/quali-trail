import { allow, clientIp, featureOn, gone, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

/** POST /api/signoff/opt-out — stop all further QualiTrail requests to this address. */
export async function POST(request: Request) {
  if (!featureOn()) return off();
  if (!(await allow("optout-ip", await clientIp(), 3600, 10))) return tooMany();
  const th = await tokenHash(request);
  if (!th) return gone();
  const r = await rpc("signoff_opt_out", { p_token_hash: th });
  return r.ok ? json({ optedOut: true }) : gone();
}
