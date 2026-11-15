import { allow, clientIp, featureOn, gone, guarded, json, off, rpc, tokenHash, tooMany } from "@/lib/server/signoff/service";

/** POST /api/signoff/opt-out — stop all further QualiTrail requests to this address. */
async function handlePOST(request: Request) {
  if (!featureOn()) return off();
  if (!(await allow("optout-ip", await clientIp(), 3600, 10))) return tooMany();
  const th = await tokenHash(request);
  if (!th) return gone();
  const r = await rpc("signoff_opt_out", { p_token_hash: th });
  return r.ok ? json({ optedOut: true }) : gone();
}

export const POST = guarded(handlePOST);
